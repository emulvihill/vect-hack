// Real engine + real IDBFS: native Larn checkpoints survive a closed tab and
// the next boot recovers them through main.c's ++ path, without an S-save.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { GRID, GRID_STRIDE, TERRAIN, TOP } from "../../src/modules/larn/mapRecords.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import { bootLarn, fail, park, until } from "./larn-play.mjs";

if (!existsSync(new URL("../../public/modules/larn/larn.data", import.meta.url)))
  fail("public/modules/larn/larn.{js,wasm,data} missing — run scripts/build/build-larn-wasm.sh");

const CHECKPOINT_INTERVAL = 400;
// bootLarn's inventory handshake supplies yylex input #1. Its pager closes
// through ttgetch(), which does not increment BYTESIN; the first task space
// below is therefore yylex input #2, leaving 398 delivered spaces before
// #400 saves.
const CHECKPOINT_SPACES = CHECKPOINT_INTERVAL - 2;
const checkpoint = `${VOLUMES.larn.mountpoint}/home/Larn12.0.ckp`;

/** A recovery fingerprint deliberately contains the hero plus fixed terrain
 * only. Visit 1 uses no-move commands, while bootLarn consumes one restored
 * '.' to obtain its post-restore map batch; the terrain underlay stays stable
 * when that synchronization turn moves a monster over or off a cell. */
const fingerprint = (records) => {
  if (!(records instanceof Int32Array) || records.length % GRID_STRIDE)
    fail("missing or malformed Larn map batch");
  const terrain = [];
  let hero = null;
  for (let offset = 0; offset < records.length; offset += GRID_STRIDE) {
    const record = records.subarray(offset, offset + GRID_STRIDE);
    if (record[GRID.TOP_CAT] === TOP.HERO)
      hero = { x: record[GRID.X], y: record[GRID.Y] };
    if (record[GRID.TERRAIN_CAT] !== TERRAIN.UNSEEN
      && record[GRID.TERRAIN_CHAR] !== 32
      && terrain.length < 8) {
      terrain.push({
        x: record[GRID.X],
        y: record[GRID.Y],
        category: record[GRID.TERRAIN_CAT],
        ch: String.fromCodePoint(record[GRID.TERRAIN_CHAR]),
      });
    }
  }
  if (!hero) fail("checkpoint map batch has no hero");
  if (terrain.length < 5)
    fail(`checkpoint map batch exposed only ${terrain.length} fixed terrain cells`);
  return { hero, terrain };
};

// --- Visit 1: bootLarn handed us a proven yylex() boundary. ---------------
let firstFingerprint;
let commands = 0;
let checkpointObserved = false;
let firstQuit = false;
const first = await bootLarn({
  onQuit: () => { firstQuit = true; },
  play: ({ lastMap, press, session }) => {
    if (session.saveLandings) {
      if (checkpointObserved) return park();
      checkpointObserved = true;
      // savegame(ckpfile) has completed, and this is the map it saved. Do
      // not resolve this key wait: another command could alter that state.
      firstFingerprint = fingerprint(lastMap);
      return park();
    }
    if (++commands > CHECKPOINT_SPACES)
      fail(`did not observe a checkpoint after ${CHECKPOINT_SPACES} counted no-move commands`);
    // main.c case ' ' sets nomove=1, keeping the command loop inside the
    // current turn. That avoids monster movement and random-map dependence.
    return press(" ");
  },
});

await until(() => checkpointObserved, 30000, "the native Larn checkpoint");
if (!first.sawBirth)
  fail("first visit never displayed Larn's birth/welcome screen");
if (firstQuit)
  fail("checkpoint visit quit instead of remaining live for the simulated tab close");
if (commands !== CHECKPOINT_SPACES)
  fail(`checkpoint landed after ${commands} no-move commands, expected ${CHECKPOINT_SPACES}`);
if (!firstFingerprint) fail("checkpoint did not provide a map fingerprint");
if (!first.FS.analyzePath(checkpoint).exists)
  fail(`native checkpoint was not written at ${checkpoint}`);

// The direct Node driver receives saveLanded synchronously from C; unlike the
// worker, it does not install the worker's fire-and-forget flush callback.
// Complete the same volume flush before simulating a tab close.
await first.persist.flush();
first.release();
first.FS.filesystems.IDBFS.quit();

// The first engine remains parked in its unresolved Asyncify key wait. It
// cannot call VectLarn again, so installing Visit 2's bridge is race-free.
const second = await bootLarn({ play: park });
await until(() => second.postRestoreMap, 30000, "the map batch after ++ recovery");

if (second.sawBirth)
  fail("checkpoint recovery entered Larn birth instead of ++ restore");
if (/altered|cheat/i.test(second.textHistory))
  fail(`honest checkpoint was marked as cheating: ${JSON.stringify(second.textHistory)}`);
const secondFingerprint = fingerprint(second.postRestoreMap);
if (JSON.stringify(secondFingerprint) !== JSON.stringify(firstFingerprint)) {
  fail(`checkpoint restored a different dungeon state:\n  saved:    ${JSON.stringify(firstFingerprint)}\n  restored: ${JSON.stringify(secondFingerprint)}`);
}

await second.persist.flush();
second.release();
second.FS.filesystems.IDBFS.quit();
console.log(`OK: native checkpoint survived a tab close and ++ restored ${JSON.stringify(firstFingerprint)}`);
