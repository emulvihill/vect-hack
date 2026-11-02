// Real engine + real IDBFS: an explicit Larn S-save is consumed by the
// next boot, which restores the same dungeon state without entering birth.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { GRID, GRID_STRIDE, TOP } from "../../src/modules/larn/mapRecords.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import { bootLarn, fail, park, until } from "./larn-play.mjs";

if (!existsSync(new URL("../../public/modules/larn/larn.data", import.meta.url)))
  fail("public/modules/larn/larn.{js,wasm,data} missing — run scripts/build/build-larn-wasm.sh");

const saveDir = `${VOLUMES.larn.mountpoint}/home`;
const visible = (record) => String.fromCodePoint(
  record[GRID.TOP_CHAR] || record[GRID.TERRAIN_CHAR] || 32,
);

/** Coordinates plus visible glyphs give this build-independent engine test a
 * small, human-readable map fingerprint without pretending the sidebar has
 * player identity (Larn 12.0 does not show it). */
const fingerprint = (records) => {
  if (!(records instanceof Int32Array) || records.length % GRID_STRIDE)
    fail("missing or malformed post-play Larn map batch");
  const cells = [];
  let hero = null;
  for (let i = 0; i < records.length; i += GRID_STRIDE) {
    const record = records.subarray(i, i + GRID_STRIDE);
    if (record[GRID.TOP_CAT] === TOP.HERO)
      hero = { x: record[GRID.X], y: record[GRID.Y] };
    const ch = visible(record);
    if (ch !== " " && cells.length < 8)
      cells.push({ x: record[GRID.X], y: record[GRID.Y], ch });
  }
  if (!hero) fail("post-play map batch has no hero");
  if (cells.length < 3) fail(`post-play map batch exposed only ${cells.length} visible cells`);
  return { heroX: hero.x, heroY: hero.y, cells };
};

// --- Visit 1: play just far enough to make an explicit save. -------------
let quit = false;
let saved = false;
let firstFingerprint;
let firstSaveSent = false;
const first = await bootLarn({
  onQuit: (wasSaved) => { quit = true; saved = wasSaved === 1; },
  play: ({ lastMap, press }) => {
    if (firstSaveSent) return park();
    firstFingerprint = fingerprint(lastMap);
    firstSaveSent = true;
    return press("S");
  },
});

await until(() => quit, 30000, "the first Larn visit to save and exit");
if (!first.sawBirth)
  fail("first visit never displayed Larn's birth/welcome screen");
if (!saved) fail("S-save exited without a successful saved report");
if (!firstFingerprint) fail("first visit never reached a post-play map batch");
await first.persist.flush();

const savedFiles = first.FS.readdir(saveDir)
  .filter((name) => name !== "." && name !== "..");
if (JSON.stringify(savedFiles) !== JSON.stringify(["Larn.sav"]))
  fail(`expected exactly /lib/home/Larn.sav, got ${JSON.stringify(savedFiles)}`);
first.release();
first.FS.filesystems.IDBFS.quit();

// --- Visit 2: the native auto-restore deletes the save after loading it. --
// IDBFS reconstructs the MEMFS node during populate. Advance the JS clock
// past upstream's six-second tolerance so this run proves both volatile
// timestamps and the changed inode are ignored by the WASM portability shim.
const realDateNow = Date.now;
Date.now = () => realDateNow() + 10_000;
let second;
try {
  second = await bootLarn({ play: park });
} finally {
  Date.now = realDateNow;
}
await until(() => second.postRestoreMap, 30000, "the map batch after the restored command boundary");

if (second.sawBirth)
  fail("restored session entered Larn birth instead of loading the S-save");
if (/altered|cheat/i.test(second.textHistory))
  fail(`honest S-save was marked as cheating: ${JSON.stringify(second.textHistory)}`);
const restoredFiles = second.FS.readdir(saveDir)
  .filter((name) => name !== "." && name !== "..");
if (restoredFiles.length)
  fail(`restore did not delete /lib/home/Larn.sav: ${JSON.stringify(restoredFiles)}`);

const secondFingerprint = fingerprint(second.postRestoreMap);
if (JSON.stringify(secondFingerprint) !== JSON.stringify(firstFingerprint))
  fail(`restored a different dungeon state:\n  saved:    ${JSON.stringify(firstFingerprint)}\n  restored: ${JSON.stringify(secondFingerprint)}`);

await second.persist.flush();
second.release();
second.FS.filesystems.IDBFS.quit();
console.log(`OK: S-save restored ${JSON.stringify(firstFingerprint)} and was consumed`);
