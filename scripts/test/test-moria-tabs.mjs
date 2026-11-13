// Two real live engines over one real IDBFS. The restored writer is parked
// while a losing engine plays and saves only to its private packaged tree.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import {
  bootMoria,
  bytesEqual,
  closeIdbfs,
  createAndSave,
  restoreAndPark,
  waitForExit,
} from "./moria-persist-play.mjs";

const root = VOLUMES.moria.mountpoint;
const gamePath = `${root}/game.sav`;
const scoresPath = `${root}/scores.dat`;

async function readRemote(path) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(root);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("FILE_DATA", "readonly").objectStore("FILE_DATA").get(path);
      request.onsuccess = () => resolve(request.result?.contents);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const seedDriver = createAndSave();
const seed = await bootMoria({ input: seedDriver.input });
await waitForExit(seed);
assert.equal(seed.quitState?.saved, true, seed.quitState?.reason ?? "seed save was not durable");
await seed.lifecycle.release();
closeIdbfs(seed);

const writerDriver = restoreAndPark();
const writer = await bootMoria({ input: writerDriver.input });
await writerDriver.reachedOuter;
assert.equal(writer.persist.persistent, true, writer.persist.reason?.detail ?? "restored writer lost ownership");
const writerGame = Uint8Array.from(writer.FS.readFile(gamePath));
const writerScores = Uint8Array.from(writer.FS.readFile(scoresPath));
assert.ok(bytesEqual(await readRemote(gamePath), writerGame), "writer game.sav was not durable before loser boot");
assert.ok(bytesEqual(await readRemote(scoresPath), writerScores), "writer scores.dat was not durable before loser boot");

const loserDriver = createAndSave();
const loser = await bootMoria({ input: loserDriver.input });
assert.equal(loser.persist.persistent, false, "concurrent engine also mounted /vect-moria");
assert.match(loser.persist.reason?.detail ?? "", /another tab/i);
assert.equal(loser.FS.analyzePath(root).exists, false, "losing engine exposed the persistent mount");
assert.ok(bytesEqual(await readRemote(gamePath), writerGame),
  "loser storage setup altered durable writer game.sav");
assert.ok(bytesEqual(await readRemote(scoresPath), writerScores),
  "loser storage setup altered durable writer scores.dat");
await waitForExit(loser);
assert.deepEqual(loser.quitState, {
  saved: false,
  persistent: false,
  reason: "another tab is already playing; only it can save",
});
assert.ok(loser.FS.analyzePath("/moria-seed/game.sav").exists,
  "losing real engine did not remain playable/save into its private seed tree");
// Nothing reads writer.FS here. The writer's MEMFS lives in its own Emscripten
// heap and the losing engine cannot reach it under any implementation, so
// comparing it against itself is an assertion no behaviour could falsify
// (vect-hack-azf). IndexedDB is the substrate the two
// engines share, and it is what the checks below read.
const remoteAfterLoserGame = await readRemote(gamePath);
const remoteAfterLoserScores = await readRemote(scoresPath);
assert.ok(bytesEqual(remoteAfterLoserGame, writerGame),
  `loser altered durable writer game.sav (${writerGame.byteLength} -> ${remoteAfterLoserGame?.byteLength ?? "missing"})`);
assert.ok(bytesEqual(remoteAfterLoserScores, writerScores),
  `loser altered durable writer scores.dat (${writerScores.byteLength} -> ${remoteAfterLoserScores?.byteLength ?? "missing"})`);
await loser.lifecycle.release();
closeIdbfs(loser);

// Test-only crash: no production lifecycle release, therefore no last flush
// can conceal a reconcile bug caused by the loser.
writer.persist.release();
closeIdbfs(writer);
assert.ok(bytesEqual(await readRemote(gamePath), writerGame), "crash close altered durable writer game.sav");
assert.ok(bytesEqual(await readRemote(scoresPath), writerScores), "crash close altered durable writer scores.dat");

const thirdDriver = restoreAndPark();
const third = await bootMoria({ input: thirdDriver.input });
await thirdDriver.reachedOuter;
assert.equal(thirdDriver.sawBirth, false, "third engine did not restore writer save");
assert.deepEqual(thirdDriver.snapshot, writerDriver.snapshot,
  "third engine restored state other than the parked writer's exact state");
assert.ok(bytesEqual(third.FS.readFile(gamePath), writerGame), "wrong game.sav survived the tab race");
const thirdScores = third.FS.readFile(scoresPath);
assert.ok(bytesEqual(thirdScores, writerScores),
  `wrong scores.dat survived the tab race (${writerScores.byteLength} -> ${thirdScores.byteLength})`);
await third.lifecycle.release();
closeIdbfs(third);

console.log("OK: concurrent Moria loser stays session-only and cannot wipe the crashed writer");
