// Real Emscripten IDBFS integration: Larn's writable roots survive a page
// reload, while a concurrent non-owner stays session-only and cannot
// reconcile the writer's files out of IndexedDB.
import "fake-indexeddb/auto";
import { fileURLToPath } from "node:url";
import createLarnModule from "../../public/modules/larn/larn.js";
import { mountLarnStorage, LARN_WRITABLE_DIRS } from "../../src/modules/larn/persist.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import { restoreSave, unpackSave } from "../../src/backplane/saveBlob.ts";
import { readPendingImport, stashPendingImport } from "../../src/backplane/pendingImport.ts";

const EXPECTED_DIRS = ["home", "scores"];
const DIRS = [...LARN_WRITABLE_DIRS];
const fail = (message) => { throw new Error("FAIL: " + message); };
const coreFile = (name) => fileURLToPath(new URL(`../../public/modules/larn/${name}`, import.meta.url));

if (DIRS.length !== EXPECTED_DIRS.length || DIRS.some((dir, i) => dir !== EXPECTED_DIRS[i]))
  fail(`unexpected Larn writable roots: ${JSON.stringify(DIRS)}`);

async function session() {
  let persist;
  const opts = {
    noInitialRun: true,
    locateFile: coreFile,
    print: () => {},
    printErr: (text) => console.warn("[larn stderr]", text),
    preRun: [(mod) => { persist = mountLarnStorage(mod); }],
  };
  await createLarnModule(opts);
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
    closeWithoutFlush: () => {
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
 * (vect-hack-azf). Mirrors editVolume() in
 * test-nethack-autosave.mjs, minus the write-back: this one only populates,
 * so inspecting the volume can never repair it.
 */
async function readVolume() {
  const opts = { noInitialRun: true, locateFile: coreFile, print: () => {}, printErr: () => {} };
  await createLarnModule(opts);
  const FS = opts.FS;
  const root = VOLUMES.larn.mountpoint;
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
  if (writer.read(`${VOLUMES.larn.mountpoint}/${dir}/marker`) !== marker)
    fail(`${dir} did not write through its volume link`);
}
// The character this volume's exports need (vect-hack-70x), written through
// the same link the markers travel.
writer.FS.writeFile("/lib/home/Larn.sav", "the writer's character");
await writer.persist.flush();

const loser = await session();
if (loser.persist.persistent) fail("concurrent session also owned the volume");
if (!/another tab/i.test(loser.persist.reason?.detail ?? ""))
  fail(`unexpected non-owner reason: ${loser.persist.reason?.detail}`);
if (loser.FS.analyzePath(VOLUMES.larn.mountpoint).exists)
  fail("non-owner mounted the persistent volume");
loser.FS.writeFile("/lib/home/marker", "loser");
// A real save name beside the marker: since vect-hack-70x an export refuses a
// volume with no character in it, and `marker` is a stand-in for save data
// rather than any name Larn writes. This is what the losing tab's engine would
// have put there — savegame() writes Larn.sav for the S command — and the
// marker below still proves which root the blob was packed from.
loser.FS.writeFile("/lib/home/Larn.sav", "loser-character");
await loser.persist.flush();

// vect-hack-47a: the losing tab is playing a real character into real
// writable paths and nothing behind it reaches IndexedDB, so it is the tab
// whose game most needs a way out — and it used to be the only one the export
// refused. Its blob has to carry the volume's own relative names, packed out
// of /lib, or F4 has nothing to load.
const sessionExport = loser.persist.exportSave(new Date());
if (!/^vecthack-larn-\d{8}-\d{4}\.vhsave$/.test(sessionExport.filename))
  fail(`unexpected session-only export filename: ${sessionExport.filename}`);
const sessionContents = unpackSave(sessionExport.bytes);
const sessionMarker = sessionContents.files.find((f) => f.path === "home/marker");
if (!sessionMarker)
  fail(`session-only export packed ${JSON.stringify(sessionContents.files.map((f) => f.path))}`);
if (new TextDecoder().decode(sessionMarker.bytes) !== "loser")
  fail("the session-only export did not pack the losing tab's own bytes");
// Reading the writer's own MEMFS here would prove only that two Emscripten
// heaps are separate. IndexedDB is the one thing both sessions share, so it is
// the only place the non-owner's reconcile could land.
await checkVolume("with both sessions open");

await loser.close();
// The writer was already flushed before the loser started. A final writer
// flush here would copy its live MEMFS over IndexedDB and mask a regression
// where the losing tab corrupted the persistent volume.
writer.closeWithoutFlush();
await checkVolume("after both sessions closed");

const restored = await session();
if (!restored.persist.persistent)
  fail(`reload did not own storage: ${restored.persist.reason?.detail}`);
for (const dir of DIRS) {
  const got = restored.read(`/lib/${dir}/marker`);
  if (got !== `marker-${dir}`)
    fail(`${dir} marker did not survive: ${JSON.stringify(got)}`);
}
const exported = restored.persist.exportSave(new Date());
if (!/^vecthack-larn-\d{8}-\d{4}\.vhsave$/.test(exported.filename))
  fail(`unexpected export filename: ${exported.filename}`);
const contents = unpackSave(exported.bytes);
for (const dir of DIRS) {
  if (!contents.files.some((f) => f.path === `${dir}/marker`))
    fail(`${dir}/marker is missing from the exported blob`);
}

restored.FS.unlink(`${VOLUMES.larn.mountpoint}/home/marker`);
restoreSave(restored.FS, VOLUMES.larn, contents);
if (restored.read("/lib/home/marker") !== "marker-home")
  fail("the exported blob did not restore the save it packed");

await restored.close();

// The whole trip the escape hatch has to survive: the losing tab's blob,
// parked the way F4 parks a picked file, mounted by a tab that does own the
// volume. Last, because a load is a replace: the writer's markers go with it.
await stashPendingImport(VOLUMES.larn.id, sessionExport.bytes);
const loaded = await session();
if (!loaded.persist.persistent)
  fail(`the importing session did not own storage: ${loaded.persist.reason?.detail}`);
if (loaded.read("/lib/home/marker") !== "loser")
  fail("the session-only blob did not reach the volume through the parked-import path");
if (loaded.FS.analyzePath(`${VOLUMES.larn.mountpoint}/scores/marker`).exists)
  fail("the imported volume kept a file the blob did not carry");
if (await readPendingImport(VOLUMES.larn.id) !== null)
  fail("the applied import stayed parked and would be reapplied on every reload");
await loaded.close();

console.log(
  "OK: Larn home and scores data survive; a losing tab cannot delete them;"
  + ` the volume exports as ${exported.filename} and restores from it;`
  + " and a session-only tab's own export loads back through the parked-import path");
