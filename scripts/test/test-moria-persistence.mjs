// Real Umoria + IDBFS gate: seed, score/save durability, portable export,
// validated pristine import, and real storage failure behavior.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { unpackSave } from "../../src/backplane/saveBlob.ts";
import { readPendingImport, stashPendingImport } from "../../src/backplane/pendingImport.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import { installMoriaImport, validateMoriaImport } from "../../src/modules/moria/saveImport.ts";
import {
  MORIA_GAME_SAVE, MORIA_RUNTIME_FILES, MORIA_SEED_ROOT,
} from "../../src/modules/moria/persist.ts";
import {
  bootMoria,
  bytesEqual,
  closeIdbfs,
  createAndSave,
  listFiles,
  restoreAndPark,
  restoreMoveAndSave,
  waitForExit,
} from "./moria-persist-play.mjs";

const root = VOLUMES.moria.mountpoint;
const gamePath = `${root}/game.sav`;
const scoresPath = `${root}/scores.dat`;

const driver = createAndSave({ roguelike: true });
const first = await bootMoria({ roguelike: true, input: driver.input });
assert.equal(first.persist.persistent, true, first.persist.reason?.detail ?? "first Moria session was not persistent");
await waitForExit(first);
assert.deepEqual(first.quitState, { saved: true, persistent: true, reason: null });
assert.equal(driver.snapshot.roguelike, true,
  "fresh roguelike startup never reached the native request discriminator");

assert.deepEqual(listFiles(first.FS, root).filter((path) => path !== "game.sav").sort(),
  [...MORIA_RUNTIME_FILES].sort(), "persistent volume did not contain the exact seed tree");
for (const relative of MORIA_RUNTIME_FILES) {
  if (relative === "scores.dat") continue;
  assert.ok(bytesEqual(
    first.FS.readFile(`${root}/${relative}`),
    first.FS.readFile(`${MORIA_SEED_ROOT}/${relative}`),
  ), `persistent immutable seed differs: ${relative}`);
}
const savedGame = Uint8Array.from(first.FS.readFile(gamePath));
const packagedScores = Uint8Array.from(first.FS.readFile(`${MORIA_SEED_ROOT}/scores.dat`));
const savedScores = Uint8Array.from(first.FS.readFile(scoresPath));
assert.ok(savedGame.byteLength > 4, "real Ctrl-X did not create a nonempty game.sav");
assert.equal(bytesEqual(savedScores, packagedScores), false,
  "real Ctrl-X left scores.dat byte-for-byte equal to the packaged seed");
assert.equal(savedScores.byteLength - packagedScores.byteLength, 73,
  "real Ctrl-X did not add exactly one whole 73-byte score record");

const exported = first.persist.exportSave(new Date(2026, 7, 8, 12, 34));
assert.match(exported.filename, /^vecthack-moria-\d{8}-\d{4}\.vhsave$/);
const contents = validateMoriaImport(first.FS, unpackSave(exported.bytes));
assert.ok(contents.files.some(({ path }) => path === "game.sav"), "Moria export omitted game.sav");
assert.ok(contents.files.some(({ path }) => path === "scores.dat"), "Moria export omitted scores.dat");

// Make the elected volume genuinely pristine and durable before installing;
// the following boot can therefore only restore the bytes from the blob.
first.FS.unlink(gamePath);
first.FS.writeFile(scoresPath, first.FS.readFile(`${MORIA_SEED_ROOT}/scores.dat`));
await first.persist.flush();
installMoriaImport(first.FS, contents);
await first.persist.flush();
assert.ok(bytesEqual(first.FS.readFile(gamePath), savedGame), "validated import changed game.sav");
assert.ok(bytesEqual(first.FS.readFile(scoresPath), savedScores), "validated import changed scores.dat");
await first.lifecycle.release();
closeIdbfs(first);

const restoredDriver = restoreAndPark();
const restored = await bootMoria({ roguelike: false, input: restoredDriver.input });
await restoredDriver.reachedOuter;
assert.equal(restoredDriver.sawBirth, false, "imported save booted character creation");
assert.equal(restoredDriver.snapshot.roguelike, true,
  "saved roguelike option did not override the opposite startup option");
assert.ok(bytesEqual(restored.FS.readFile(gamePath), savedGame), "imported game.sav did not survive reload");
assert.ok(bytesEqual(restored.FS.readFile(scoresPath), savedScores), "imported scores.dat did not survive reload");
await restored.lifecycle.release();
closeIdbfs(restored);

// The player-facing load path (vect-hack-9h1): the same blob parked in the
// Backplane's transfer store, applied by the mount rather than by a test
// calling installMoriaImport by hand. The Module's archive gate is wired as
// the mount's validateImport hook, so both outcomes are worth proving here.
{
  const parked = await bootMoria({ startEngine: false });
  parked.FS.unlink(gamePath);
  parked.FS.writeFile(scoresPath, parked.FS.readFile(`${MORIA_SEED_ROOT}/scores.dat`));
  await parked.persist.flush();
  await parked.lifecycle.release();
  closeIdbfs(parked);

  await stashPendingImport(VOLUMES.moria.id, exported.bytes);
  const loaded = await bootMoria({ startEngine: false });
  assert.equal(loaded.persist.persistent, true, loaded.persist.reason?.detail ?? "import session lost the volume");
  assert.ok(bytesEqual(loaded.FS.readFile(gamePath), savedGame),
    "the parked blob did not restore game.sav at mount");
  assert.ok(bytesEqual(loaded.FS.readFile(scoresPath), savedScores),
    "the parked blob did not restore scores.dat at mount");
  assert.equal(await readPendingImport(VOLUMES.moria.id), null,
    "the applied import stayed parked and would be reapplied on every reload");
  await loaded.lifecycle.release();
  closeIdbfs(loaded);

  // A blob this build did not make: the Module's own gate refuses it, and the
  // volume it was aimed at keeps the character that is already there.
  const foreign = unpackSave(exported.bytes);
  foreign.manifest.files.push({ path: "cheat.txt", size: 1 });
  foreign.files.push({ path: "cheat.txt", bytes: new Uint8Array([65]) });
  const header = new TextEncoder().encode(`VECTSAVE1\n${JSON.stringify(foreign.manifest)}\n`);
  const bodies = foreign.files.reduce((n, f) => n + f.bytes.byteLength, 0);
  const tampered = new Uint8Array(header.length + bodies);
  tampered.set(header, 0);
  let at = header.length;
  for (const file of foreign.files) { tampered.set(file.bytes, at); at += file.bytes.byteLength; }

  await stashPendingImport(VOLUMES.moria.id, tampered);
  const refused = await bootMoria({ startEngine: false });
  assert.ok(bytesEqual(refused.FS.readFile(gamePath), savedGame),
    "a refused import disturbed the volume it was aimed at");
  assert.equal(refused.FS.analyzePath(`${root}/cheat.txt`).exists, false,
    "a refused import left one of its files behind");
  assert.equal(await readPendingImport(VOLUMES.moria.id), null,
    "a refused import stayed parked and would be retried forever");
  await refused.lifecycle.release();
  closeIdbfs(refused);
}

// Real final-flush failure after a real restored move and Ctrl-X. Native save
// and score writes still complete, but durability provenance must be false.
const flushFailureDriver = restoreMoveAndSave({
  beforeSave(session) {
    const syncfs = session.FS.syncfs.bind(session.FS);
    session.FS.syncfs = (populate, callback) => {
      if (populate) syncfs(populate, callback);
      else queueMicrotask(() => callback(new Error("injected final flush failure")));
    };
  },
});
const flushFailure = await bootMoria({ input: flushFailureDriver.input });
await waitForExit(flushFailure);
assert.equal(flushFailure.quitState?.saved, false, "failed real sync claimed a durable save");
assert.equal(flushFailure.quitState?.persistent, true, "failed final sync lost writer provenance");
assert.match(flushFailure.quitState?.reason ?? "", /injected final flush failure/);
await flushFailure.lifecycle.release();
closeIdbfs(flushFailure);

// Inject populate failure through a real Emscripten Module option before the
// persistence preRun. Boot and release must both settle in session-only mode,
// and Emscripten's dependency monitor must finish at zero.
const populateFailureDriver = createAndSave();
const populateFailure = await bootMoria({
  input: populateFailureDriver.input,
  beforeMount(mod) {
    const syncfs = mod.FS.syncfs.bind(mod.FS);
    mod.FS.syncfs = (populate, callback) => {
      if (populate) queueMicrotask(() => callback(new Error("injected populate failure")));
      else syncfs(populate, callback);
    };
  },
});
assert.equal(populateFailure.persist.persistent, false, "failed populate retained writer ownership");
assert.match(populateFailure.persist.reason?.detail ?? "", /injected populate failure/);
assert.equal(populateFailure.FS.cwd(), MORIA_SEED_ROOT, "failed populate did not select session cwd");
assert.equal(populateFailure.dependencyCounts.at(-1), 0, "failed populate stranded a run dependency");
await waitForExit(populateFailure);
assert.equal(populateFailureDriver.moved, true,
  "populate-failed session did not drive a real character through movement and Ctrl-X");
assert.equal(populateFailure.quitState?.saved, false,
  "populate-failed session claimed its Ctrl-X save was durable");
assert.equal(populateFailure.quitState?.persistent, false,
  "populate-failed session changed its storage provenance at exit");
assert.match(populateFailure.quitState?.reason ?? "", /injected populate failure/);

// vect-hack-47a: that session is a real character, saved with a real Ctrl-X,
// living in the packaged seed tree because there was no volume to live in —
// and until now it was the one session the export refused. Moria is the
// awkward case: /moria-seed is the game's own installation, so the character
// sits mixed in among read-only build data and the export has to name what is
// a save and what is a copy of the build.
const sessionGame = Uint8Array.from(
  populateFailure.FS.readFile(`${MORIA_SEED_ROOT}/${MORIA_GAME_SAVE}`));
assert.ok(sessionGame.byteLength > 4,
  "the session-only session did not leave a real game.sav in its seed tree");
// Moria's session-only cwd is the game's INSTALLATION, not a volume, so what
// the export must not do is pack whatever it finds there. Nothing upstream
// writes a stray file into it today, which is exactly why the rule needs one
// put there by hand: without this the declared name list and a wholesale walk
// of /moria-seed agree, and a build that dropped the list would still pass.
populateFailure.FS.writeFile(`${MORIA_SEED_ROOT}/core.dump`, new Uint8Array([0, 1, 2]));
const sessionExport = populateFailure.persist.exportSave(new Date(2026, 7, 26, 9, 30));
assert.match(sessionExport.filename, /^vecthack-moria-\d{8}-\d{4}\.vhsave$/);
// The Module's OWN archive gate, unweakened, run over a blob a session-only
// tab produced. Nothing here special-cases it: the names the export packs are
// that gate's allow-list, and the immutable runtime files it compares against
// the packaged seed ARE the packaged seed, because that is where they were
// read from.
const sessionContents = validateMoriaImport(populateFailure.FS, unpackSave(sessionExport.bytes));
assert.ok(bytesEqual(
  sessionContents.files.find(({ path }) => path === MORIA_GAME_SAVE)?.bytes, sessionGame),
  "the session-only export did not pack the character it was playing");
assert.deepEqual(sessionContents.files.map(({ path }) => path).sort(),
  [...MORIA_RUNTIME_FILES, MORIA_GAME_SAVE].sort(),
  "the session-only export packed something that is not part of a Moria save");
await populateFailure.lifecycle.release();
closeIdbfs(populateFailure);

// And it loads: parked the way F4 parks a picked file, into a tab that does
// own the volume. A blob F4 cannot load is worse than no blob at all.
{
  await stashPendingImport(VOLUMES.moria.id, sessionExport.bytes);
  const rescued = await bootMoria({ startEngine: false });
  assert.equal(rescued.persist.persistent, true,
    rescued.persist.reason?.detail ?? "the rescuing session lost the volume");
  assert.ok(bytesEqual(rescued.FS.readFile(gamePath), sessionGame),
    "the session-only blob did not reach the volume through the parked-import path");
  assert.deepEqual(listFiles(rescued.FS, root).filter((path) => path !== MORIA_GAME_SAVE).sort(),
    [...MORIA_RUNTIME_FILES].sort(),
    "the imported volume is not the exact seed tree plus the character");
  assert.equal(await readPendingImport(VOLUMES.moria.id), null,
    "the applied import stayed parked and would be reapplied on every reload");
  await rescued.lifecycle.release();
  closeIdbfs(rescued);
}

console.log("OK: Moria seed/save/score/export/import, the parked-blob load path,"
  + " a session-only tab's own export loading back through it,"
  + " plus real populate/final-sync failure gates pass");
