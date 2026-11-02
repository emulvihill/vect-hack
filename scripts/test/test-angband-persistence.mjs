// Real Emscripten IDBFS integration: all four Angband writable roots survive
// a page reload, while a concurrent non-owner stays session-only and cannot
// reconcile the writer's files out of IndexedDB.
import "fake-indexeddb/auto";
import { fileURLToPath } from "node:url";
import createAngbandModule from "../../public/modules/angband/angband.js";
import { mountAngbandStorage } from "../../src/modules/angband/persist.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import { restoreSave, unpackSave } from "../../src/backplane/saveBlob.ts";
import { readPendingImport, stashPendingImport } from "../../src/backplane/pendingImport.ts";

const DIRS = ["save", "scores", "user", "panic"];
const fail = (message) => { throw new Error("FAIL: " + message); };
const coreFile = (name) => fileURLToPath(new URL(`../../public/modules/angband/${name}`, import.meta.url));

async function session() {
  let persist;
  const opts = {
    noInitialRun: true,
    locateFile: coreFile,
    print: () => {},
    printErr: (text) => console.warn("[angband stderr]", text),
    preRun: [(mod) => { persist = mountAngbandStorage(mod); }],
  };
  await createAngbandModule(opts);
  await persist.ready;
  return {
    FS: opts.FS,
    persist,
    read: (path) => new TextDecoder().decode(opts.FS.readFile(path)),
    close: async () => {
      await persist.flush();
      persist.release();
      opts.FS.filesystems.IDBFS.quit();
    },
  };
}

/**
 * The volume as IndexedDB holds it, read through nothing but a bare IDBFS
 * mount. A session's MEMFS lives in its own Emscripten heap and no other
 * module instance can reach it, so reading the writer's memory to find out
 * what a losing tab did is an assertion no behaviour could falsify
 * (docs/DECISIONS.md, vect-hack-azf). Mirrors editVolume() in
 * test-nethack-autosave.mjs, minus the write-back: this one only populates,
 * so inspecting the volume can never repair it.
 */
async function readVolume() {
  const opts = { noInitialRun: true, locateFile: coreFile, print: () => {}, printErr: () => {} };
  await createAngbandModule(opts);
  const FS = opts.FS;
  const root = VOLUMES.angband.mountpoint;
  FS.mkdir(root);
  FS.mount(FS.filesystems.IDBFS, {}, root);
  await new Promise((done, die) => FS.syncfs(true, (err) => (err ? die(err) : done())));
  const stored = Object.fromEntries(DIRS.map((dir) => {
    const path = `${root}/${dir}/marker`;
    return [dir, FS.analyzePath(path).exists
      ? new TextDecoder().decode(FS.readFile(path))
      : null];
  }));
  FS.filesystems.IDBFS.quit();
  return stored;
}

/** Every writer marker, straight out of IndexedDB. */
async function checkVolume(when) {
  const stored = await readVolume();
  for (const dir of DIRS) {
    if (stored[dir] !== `marker-${dir}`)
      fail(`${when}: the stored ${dir} marker is ${JSON.stringify(stored[dir])}`);
  }
}

const writer = await session();
if (!writer.persist.persistent)
  fail(`first session did not own storage: ${writer.persist.reason?.detail}`);

for (const dir of DIRS) {
  const marker = `marker-${dir}`;
  if (!writer.FS.isLink(writer.FS.lstat(`/lib/${dir}`).mode))
    fail(`/lib/${dir} is not a symlink`);
  writer.FS.writeFile(`/lib/${dir}/marker`, marker);
  if (writer.read(`${VOLUMES.angband.mountpoint}/${dir}/marker`) !== marker)
    fail(`${dir} did not write through its volume link`);
}
await writer.persist.flush();

const loser = await session();
if (loser.persist.persistent) fail("concurrent session also owned the volume");
if (!/another tab/i.test(loser.persist.reason?.detail ?? ""))
  fail(`unexpected non-owner reason: ${loser.persist.reason?.detail}`);
if (loser.FS.analyzePath(VOLUMES.angband.mountpoint).exists)
  fail("non-owner mounted the persistent volume");
loser.FS.writeFile("/lib/save/marker", "loser");
await loser.persist.flush();

// vect-hack-47a: the losing tab plays a real character into real writable
// directories that nothing behind them will ever store, so it is the tab whose
// game most needs a way out — and it used to be the only one the export
// refused. What it packs has to be its own /lib bytes under the volume's own
// relative names, or F4 has nothing to load.
const sessionExport = loser.persist.exportSave(new Date());
if (!/^vecthack-angband-\d{8}-\d{4}\.vhsave$/.test(sessionExport.filename))
  fail(`unexpected session-only export filename: ${sessionExport.filename}`);
const sessionContents = unpackSave(sessionExport.bytes);
const sessionMarker = sessionContents.files.find((f) => f.path === "save/marker");
if (!sessionMarker)
  fail(`session-only export packed ${JSON.stringify(sessionContents.files.map((f) => f.path))}`);
if (new TextDecoder().decode(sessionMarker.bytes) !== "loser")
  fail("the session-only export did not pack the losing tab's own bytes");
// Reading the writer's own MEMFS here would prove only that two Emscripten
// heaps are separate. IndexedDB is the one thing both sessions share, so it is
// the only place the non-owner's reconcile could land.
await checkVolume("with both sessions open");

// The writer goes first. If it closed last its flush would reconcile its own
// intact MEMFS back over the volume, recreating every entry the loser deleted
// before the reload looked — which is how a losing tab's wipe used to pass
// this test. The loser's flush must be the last write the volume sees.
await writer.close();
await loser.close();
await checkVolume("after both sessions closed");

const restored = await session();
if (!restored.persist.persistent)
  fail(`reload did not own storage: ${restored.persist.reason?.detail}`);
for (const dir of DIRS) {
  const got = restored.read(`/lib/${dir}/marker`);
  if (got !== `marker-${dir}`)
    fail(`${dir} marker did not survive: ${JSON.stringify(got)}`);
}
// The export path against a real Emscripten FS, which is the only place the
// calls it needs (readdir/stat/isDir/isFile/readFile/writeFile/mkdirTree) are
// the real ones. A unit test can only prove the format.
const exported = restored.persist.exportSave(new Date());
if (!/^vecthack-angband-\d{8}-\d{4}\.vhsave$/.test(exported.filename))
  fail(`unexpected export filename: ${exported.filename}`);
const contents = unpackSave(exported.bytes);
for (const dir of DIRS) {
  if (!contents.files.some((f) => f.path === `${dir}/marker`))
    fail(`${dir}/marker is missing from the exported blob`);
}

// Put it back from the blob alone: the volume's own copy is gone first, so
// nothing but the export can be answering.
restored.FS.unlink(`${VOLUMES.angband.mountpoint}/save/marker`);
restoreSave(restored.FS, VOLUMES.angband, contents);
if (restored.read("/lib/save/marker") !== "marker-save")
  fail("the exported blob did not restore the save it packed");

await restored.close();

// The trip the escape hatch has to survive end to end: the losing tab's blob,
// parked the way F4 parks a picked file, mounted by a tab that owns the
// volume. Last, because a load is a replace — the writer's markers go with it.
await stashPendingImport(VOLUMES.angband.id, sessionExport.bytes);
const loaded = await session();
if (!loaded.persist.persistent)
  fail(`the importing session did not own storage: ${loaded.persist.reason?.detail}`);
if (loaded.read("/lib/save/marker") !== "loser")
  fail("the session-only blob did not reach the volume through the parked-import path");
if (loaded.FS.analyzePath(`${VOLUMES.angband.mountpoint}/scores/marker`).exists)
  fail("the imported volume kept a file the blob did not carry");
if (await readPendingImport(VOLUMES.angband.id) !== null)
  fail("the applied import stayed parked and would be reapplied on every reload");
await loaded.close();

console.log(
  "OK: Angband save, scores, user and panic data survive; a losing tab cannot delete them;"
  + ` the volume exports as ${exported.filename} and restores from it;`
  + " and a session-only tab's own export loads back through the parked-import path");
