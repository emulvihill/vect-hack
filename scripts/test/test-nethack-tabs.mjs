// Regression test for vect-hack-4ho: a second tab must not reconcile the
// first tab's saved game out of IndexedDB.
//
// IDBFS.syncfs(populate=false) — which autoPersist runs after every write —
// deletes every IndexedDB entry the local MEMFS lacks. Before the writer-lock
// election, a second tab wiped the first tab's save and top-ten list from its
// first turn. Two engines are alive at once here, against a real IDBFS and
// node's real Web Locks.
import "fake-indexeddb/auto";
import createModule from "../../external/NetHack/targets/wasm/nethack.js";
import { SAVEFILE, seedEngineFS } from "../../src/modules/nethack/engineBoot.ts";
import { PERSIST_ROOT } from "../../src/modules/nethack/persist.ts";

const SAVEDATA = "first tab's saved game";
const SCORE = "1000 player-Val-Hum-Fem-Neu died in The Gnomish Mines\n";

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };

/** One page load, held open until close() so tabs can genuinely overlap. */
async function tab() {
  let persist;
  const opts = {
    noInitialRun: true,
    print: () => {},
    printErr: (t) => console.warn("[nethack stderr]", t),
    preRun: [(m) => { persist = seedEngineFS(m); }],
  };
  await createModule(opts);
  await persist.ready;
  return {
    FS: opts.FS,
    persist,
    read: (p) => new TextDecoder().decode(opts.FS.readFile(p)),
    close: async () => { await persist.flush(); persist.release(); opts.IDBFS.quit(); },
  };
}

/**
 * The volume as IndexedDB holds it, read through nothing but a bare IDBFS
 * mount — the only vantage point from which one tab can see another's damage.
 * A tab's MEMFS lives in its own Emscripten heap and no other module instance
 * can reach it, so reading tab A's memory to find out what tab B did is an
 * assertion no behaviour could falsify (docs/DECISIONS.md, vect-hack-azf).
 *
 * Mirrors editVolume() in test-nethack-autosave.mjs, minus the write-back:
 * this one only populates, so inspecting the volume can never repair it.
 */
async function readVolume() {
  const opts = { noInitialRun: true, print: () => {}, printErr: () => {} };
  await createModule(opts);
  const FS = opts.FS;
  FS.mkdir(PERSIST_ROOT);
  FS.mount(FS.filesystems.IDBFS, {}, PERSIST_ROOT);
  await new Promise((done, die) => FS.syncfs(true, (e) => (e ? die(e) : done())));
  const read = (path) => (FS.analyzePath(PERSIST_ROOT + path).exists
    ? new TextDecoder().decode(FS.readFile(PERSIST_ROOT + path))
    : null);
  const stored = { save: read(SAVEFILE), record: read("/record") };
  opts.IDBFS.quit();
  return stored;
}

/** Both files, straight out of IndexedDB, or the reason they are wrong. */
async function checkVolume(when) {
  const stored = await readVolume();
  if (stored.save !== SAVEDATA)
    fail(`${when}: the stored save is ${JSON.stringify(stored.save)}`);
  if (stored.record !== SCORE)
    fail(`${when}: the stored score file is ${JSON.stringify(stored.record)}`);
}

// --- tab A owns the volume and saves a game ------------------------------
const a = await tab();
if (!a.persist.persistent) fail(`the first tab was denied the volume: ${a.persist.reason?.detail}`);
a.FS.writeFile(SAVEFILE, SAVEDATA);
a.FS.writeFile("/record", SCORE);
await a.persist.flush();

// --- tab B opens while A is still playing --------------------------------
const b = await tab();
if (b.persist.persistent) fail("the second tab was allowed to own the volume too");
if (!/another tab/i.test(b.persist.reason?.detail ?? "")) fail(`unexpected reason: ${b.persist.reason?.detail}`);
if (b.FS.analyzePath(PERSIST_ROOT).exists) fail("the second tab mounted the volume anyway");

// B plays: writes land on its own session-only filesystem, and its flush must
// not issue the reconcile that would delete what it cannot see.
b.FS.writeFile(SAVEFILE, "second tab's game");
b.FS.writeFile("/record", "second tab's scores\n");
await b.persist.flush();
await new Promise((done) => setTimeout(done, 50)); // let any stray autoPersist land

// --- A's stored game is unharmed while both are open ---------------------
// Reading a.FS here would prove only that two Emscripten heaps are separate.
// IndexedDB is the one thing both tabs share, so it is the only place B's
// reconcile could land — and the only place worth looking.
await checkVolume("with both tabs open");

// A goes first. If the writer closed last its flush would reconcile its own
// intact MEMFS back over the volume, recreating every entry B deleted before
// anything looked — which is exactly how the vect-hack-4ho wipe used to pass
// this test. The loser's flush must be the last write the volume sees.
await a.close();
await b.close();
await checkVolume("after both tabs closed");

// --- a later load sees tab A's game, not tab B's -------------------------
const c = await tab();
if (!c.persist.persistent) fail(`the third tab was denied the volume: ${c.persist.reason?.detail}`);
if (!c.FS.analyzePath(SAVEFILE).exists) fail("the save was wiped from IndexedDB");
if (c.read(SAVEFILE) !== SAVEDATA)
  fail(`wrong save survived: ${JSON.stringify(c.read(SAVEFILE))}`);
if (c.read("/record") !== SCORE)
  fail(`wrong score file survived: ${JSON.stringify(c.read("/record"))}`);
await c.close();

console.log("OK: a second tab cannot wipe the first tab's save (real Web Locks + IDBFS)");
process.exit(0);
