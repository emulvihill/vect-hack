// Integration test: prove the persistence layer round-trips through IndexedDB
// using the real emscripten runtime and the real IDBFS (node has no IndexedDB,
// so fake-indexeddb supplies one).
//
// Each session is a page load. main() is held back with noInitialRun so the
// test observes exactly the filesystem the engine would wake up to; that the
// engine then boots on top of it is what test-nethack-boot.mjs checks.
import "fake-indexeddb/auto";
import createModule from "../../external/NetHack/targets/wasm/nethack.js";
import { PERSIST_ROOT } from "../../src/modules/nethack/persist.ts";
import { SAVEFILE, seedEngineFS } from "../../src/modules/nethack/engineBoot.ts";
import { restoreSave, unpackSave } from "../../src/backplane/saveBlob.ts";
import { readPendingImport, stashPendingImport } from "../../src/backplane/pendingImport.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";

const SAVEDATA = "pretend this is a saved game";
const SCORE = "1000 player-Val-Hum-Fem-Neu died in The Gnomish Mines\n";
const BONES = "pretend this is a ghost and its loot";
/** A line no exported blob carries, so a volume the import replaced and a
 *  volume the import was refused for cannot be confused for one another. */
const SENTINEL = "2000 player-Wiz-Elf-Mal-Cha escaped the dungeon\n";
/** The character a tab that cannot save is nonetheless playing. Distinct from
 *  SAVEDATA so "which tab's save came back" has two answers. */
const SESSION_SAVEDATA = "the save of a tab that could never store one";

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };

/** The blob the second load exports, carried to the import loads below. */
let blob;

/** Load a page: boot the module, hand back its FS and persistence handle. */
async function session() {
  let persist;
  const opts = {
    noInitialRun: true,
    print: () => {},
    printErr: (t) => console.warn("[nethack stderr]", t),
    preRun: [(m) => { persist = seedEngineFS(m); }],
  };
  await createModule(opts);
  return {
    FS: opts.FS,
    persist,
    read: (p) => new TextDecoder().decode(opts.FS.readFile(p)),
    /**
     * End the session the way closing the tab would, minus the tab. release()
     * matters here: all three loads share one process, and a browser would
     * have dropped the writer lock when the tab went away.
     */
    close: async () => { await persist.flush(); persist.release(); opts.IDBFS.quit(); },
  };
}

/**
 * The volume as IndexedDB holds it, read through nothing but a bare IDBFS
 * mount — no seed, no import, no engine. Mirrors editVolume() in
 * test-nethack-autosave.mjs, minus the write-back: this one only populates,
 * so inspecting the volume can never change it.
 */
async function readVolume() {
  const opts = { noInitialRun: true, print: () => {}, printErr: () => {} };
  await createModule(opts);
  const FS = opts.FS;
  FS.mkdir(PERSIST_ROOT);
  FS.mount(FS.filesystems.IDBFS, {}, PERSIST_ROOT);
  await new Promise((done, die) => FS.syncfs(true, (err) => (err ? die(err) : done())));
  const read = (path) => (FS.analyzePath(PERSIST_ROOT + path).exists
    ? new TextDecoder().decode(FS.readFile(PERSIST_ROOT + path))
    : null);
  const stored = { save: read(SAVEFILE), record: read("/record") };
  opts.IDBFS.quit();
  return stored;
}

// --- first load: the engine's paths exist, are writable, and are persistent
{
  const s = await session();
  if (!s.persist.persistent) fail("no persistent storage in the first session");
  if (!s.FS.isLink(s.FS.lstat("/save").mode)) fail("/save is not a symlink");
  if (!s.FS.isDir(s.FS.stat("/save").mode)) fail("/save does not resolve to a directory");
  if (s.read("/record") !== "") fail("a fresh /record should be empty");

  s.FS.writeFile(SAVEFILE, SAVEDATA); // as create_savefile() would
  s.FS.writeFile("/record", SCORE);   // as the top-ten writer would
  s.FS.writeFile("/bonD0.5", BONES);  // as commit_bonesfile() would, at death

  // Writing through the root symlinks must land inside the mounted volume.
  if (s.read(`${PERSIST_ROOT}${SAVEFILE}`) !== SAVEDATA)
    fail("save file did not land on the persistent volume");
  await s.close();
}

// --- second load: same IndexedDB, so the save and the score are still there
{
  const s = await session();
  if (!s.FS.analyzePath(SAVEFILE).exists) fail("save file did not survive the reload");
  if (s.read(SAVEFILE) !== SAVEDATA) fail("save file came back corrupted");
  if (s.read("/record") !== SCORE) fail("score file did not survive the reload");

  // vect-hack-nvx: bones must be back at the root, where open_bonesfile()
  // builds its dynamic name — a symlink can't cover them, so this is the
  // copy-out/copy-in seam being exercised through a real IDBFS.
  if (!s.FS.analyzePath("/bonD0.5").exists) fail("bones file did not survive the reload");
  if (s.read("/bonD0.5") !== BONES) fail("bones file came back corrupted");

  // The export path against a real Emscripten FS. NetHack's beforeFlush runs
  // first, so the live root bones the engine writes outside the volume are in
  // the blob too — the one thing a unit test cannot show.
  blob = s.persist.exportSave(new Date()).bytes;
  const contents = unpackSave(blob);
  for (const path of [SAVEFILE.replace(/^\//, ""), "record", "bones/bonD0.5"]) {
    if (!contents.files.some((f) => f.path === path))
      fail(`${path} is missing from the exported blob`);
  }

  // Put the save back from the blob alone, with the volume's own copy gone.
  s.FS.unlink(`${VOLUMES.nethack.mountpoint}${SAVEFILE}`);
  restoreSave(s.FS, VOLUMES.nethack, contents);
  if (s.read(SAVEFILE) !== SAVEDATA)
    fail("the exported blob did not restore the save it packed");

  s.FS.unlink(SAVEFILE);                     // as delete_savefile() would
  s.FS.writeFile("/record", SCORE + SCORE);  // the list has to accumulate
  s.FS.unlink("/bonD0.5");                   // as getbones() would, loading the ghost
  await s.close();
}

// --- third load: deletions persist too, appended scores are still growing
{
  const s = await session();
  if (s.FS.analyzePath(SAVEFILE).exists) fail("deleted save file came back");
  const got = s.read("/record");
  if (got !== SCORE + SCORE) fail(`score file lost an entry: ${JSON.stringify(got)}`);
  if (s.FS.analyzePath("/bonD0.5").exists) fail("consumed bones file came back");
  await s.close();
}

// --- fourth load: the import path (vect-hack-9h1). The blob the second load
// exported is parked as a pending import, exactly as the page's file picker
// parks one, and the mount applies it before the engine ever looks.
{
  await stashPendingImport(VOLUMES.nethack.id, blob);
  const s = await session();
  if (!s.persist.persistent) fail("no persistent storage in the import session");
  if (s.read(SAVEFILE) !== SAVEDATA) fail("the parked blob did not restore its save");
  // Replaced, not merged: the volume held two score lines and no save; the
  // blob held one score line and a save. What is here now is the blob's.
  if (s.read("/record") !== SCORE) fail("the import did not replace the score file");
  if (s.read("/bonD0.5") !== BONES) fail("the import did not restore the bones the blob carried");
  if (await readPendingImport(VOLUMES.nethack.id) !== null)
    fail("the applied import was not cleared, so it would be reapplied on every reload");
  await s.close();
}

// --- fifth load: the imported volume is in IndexedDB, not just in this
// session's memory — the point of loading a save at all.
{
  const s = await session();
  if (s.read(SAVEFILE) !== SAVEDATA) fail("the imported save did not survive the reload");
  if (s.read("/record") !== SCORE) fail("the imported score file did not survive the reload");
  // Move the volume away from the blob before the refusal below. The blob is
  // this volume's own export, so without this the volume and the blob's
  // payload are byte-identical and an applied foreign blob would leave exactly
  // the bytes a refusal leaves — a refusal no assertion could distinguish
  // from an acceptance (vect-hack-azf).
  s.FS.writeFile("/record", SCORE + SENTINEL);
  await s.close();
}

// --- sixth load: a blob for another game is refused, and the volume it was
// aimed at is left exactly as it was.
{
  const angband = unpackSave(blob);
  angband.manifest.game = "angband";
  const foreign = new TextEncoder().encode(
    `VECTSAVE1\n${JSON.stringify(angband.manifest)}\n`);
  const body = blob.subarray(blob.indexOf(10, blob.indexOf(10) + 1) + 1);
  const mixed = new Uint8Array(foreign.length + body.length);
  mixed.set(foreign, 0);
  mixed.set(body, foreign.length);

  await stashPendingImport(VOLUMES.nethack.id, mixed);
  const s = await session();
  if (s.read(SAVEFILE) !== SAVEDATA) fail("a refused import disturbed the volume");
  // The sentinel line load 5 left behind: applyImport empties the volume
  // before it restores a blob, so an accepted foreign blob loses this line and
  // a refused one cannot.
  if (s.read("/record") !== SCORE + SENTINEL)
    fail(`the foreign blob was applied: /record is ${JSON.stringify(s.read("/record"))}`);
  if (await readPendingImport(VOLUMES.nethack.id) !== null)
    fail("a refused import stayed parked and would be retried forever");
  await s.close();

  // And in IndexedDB, not just in the session that refused it: an import both
  // writes and removes files and syncs when it applies, so the durable volume
  // is where an accepted blob would have landed for good.
  const stored = await readVolume();
  if (stored.save !== SAVEDATA || stored.record !== SCORE + SENTINEL)
    fail(`a refused import changed the stored volume: ${JSON.stringify(stored)}`);
}

// --- seventh load (vect-hack-47a): the tab that cannot save at all. Two
// engines at once against node's real Web Locks; the second loses the
// election, so its seed puts real writable paths at the FS ROOT instead of
// linking a volume, and it plays a real character there. That character is the
// one most at risk — nothing behind it will ever reach IndexedDB — and it used
// to be the only one the export refused.
{
  const writer = await session();
  await writer.persist.ready;
  if (!writer.persist.persistent) fail("the writer session did not own the volume");

  const loser = await session();
  await loser.persist.ready;
  if (loser.persist.persistent) fail("a concurrent session also owned the volume");
  if (loser.FS.analyzePath(PERSIST_ROOT).exists) fail("the losing tab mounted the volume");
  // Real directory and real file, not the writer's symlink farm: this is the
  // layout the export has to know how to read.
  if (loser.FS.isLink(loser.FS.lstat("/save").mode))
    fail("the losing tab's /save is still a link into a volume");

  loser.FS.writeFile(SAVEFILE, SESSION_SAVEDATA); // as create_savefile() would
  loser.FS.writeFile("/record", SCORE);

  const exported = loser.persist.exportSave(new Date());
  if (!/^vecthack-nethack-\d{8}-\d{4}\.vhsave$/.test(exported.filename))
    fail(`unexpected session-only export filename: ${exported.filename}`);
  const contents = unpackSave(exported.bytes);
  const save = contents.files.find((f) => f.path === SAVEFILE.replace(/^\//, ""));
  if (!save)
    fail(`session-only export packed ${JSON.stringify(contents.files.map((f) => f.path))}`);
  if (new TextDecoder().decode(save.bytes) !== SESSION_SAVEDATA)
    fail("the session-only export did not pack the losing tab's own bytes");
  // The root is not a volume. NetHack's writable paths sit there beside /tmp,
  // /dev, /proc and the read-only embed, so an export that walked it wholesale
  // would call the whole filesystem a save — and produce a blob no import
  // would take.
  const stray = contents.files
    .map((f) => f.path)
    .filter((path) => path !== "record" && !path.startsWith("save/")
      && !["logfile", "xlogfile", "livelog"].includes(path));
  if (stray.length) fail(`the session-only export swept in ${JSON.stringify(stray)}`);

  await writer.close();
  await loser.close();

  // And it loads: parked the way F4 parks a picked file, into a tab that does
  // own the volume. A blob F4 cannot load is worse than no blob at all.
  await stashPendingImport(VOLUMES.nethack.id, exported.bytes);
  const rescued = await session();
  await rescued.persist.ready;
  if (!rescued.persist.persistent) fail("the rescuing session did not own the volume");
  if (rescued.read(SAVEFILE) !== SESSION_SAVEDATA)
    fail("the session-only blob did not reach the volume through the parked-import path");
  if (rescued.read("/record") !== SCORE)
    fail("the session-only blob did not replace the score file");
  if (await readPendingImport(VOLUMES.nethack.id) !== null)
    fail("the applied import stayed parked and would be reapplied on every reload");
  await rescued.close();
}

console.log(
  "OK: saves, scores and bones survive a reload (7 page loads, real IDBFS);"
  + " the volume exports and restores from its own blob, and a parked blob"
  + " replaces the volume at mount while another game's is refused; a tab that"
  + " cannot save exports its own character and that blob loads back");
process.exit(0);
