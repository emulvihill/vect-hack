// Real engine, real IDBFS: a character saved with Ctrl-X comes back on the
// next page load. This is the test that makes play_game(GAME_LOAD) mean
// something — with GAME_NEW the engine would boot straight past the savefile
// into birth and overwrite it, which is indistinguishable from "restore
// worked" unless the test proves birth did NOT happen and the character is
// the same one.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { CTRL_X, bootAngband, fail, park, sidebar, until } from "./angband-play.mjs";
import { VOLUMES } from "../../src/backplane/volumes.ts";

if (!existsSync(new URL("../../public/modules/angband/angband.data", import.meta.url)))
  fail("public/modules/angband/angband.{js,wasm,data} missing — run scripts/build/build-angband-wasm.sh");

const saveDir = `${VOLUMES.angband.mountpoint}/save`;

// --- First visit: birth a character, then save and exit. ------------------
let quit = false;
let saved = null;
const first = await bootAngband({
  onQuit: () => { quit = true; },
  play: ({ press, session }) => {
    if (saved) return park(); // the engine is on its way out
    saved = sidebar(session.grid);
    return press(CTRL_X);
  },
});

await until(() => quit, 30000, "the engine to save and exit");
if (!saved) fail("never reached play on the first visit");
// Without this the sawBirth check below could pass for the wrong reason: a
// probe that never fires reports "no birth happened" on every run.
if (!first.sawBirth) fail("first visit never saw a birth screen — the sawBirth probe is broken");
await first.persist.flush();

const savedFiles = first.FS.readdir(saveDir).filter((n) => n !== "." && n !== "..");
if (savedFiles.length !== 1)
  fail(`expected exactly one savefile, got ${JSON.stringify(savedFiles)}`);
first.persist.release();
first.FS.filesystems.IDBFS.quit();

// --- Second visit: a fresh module over the same IndexedDB. ----------------
const second = await bootAngband({
  play: () => park(), // reached play; hold here while the test reads the screen
});
await until(() => second.level, 30000, "the restored game to reach play");

if (second.sawBirth)
  fail("restored session rolled a new character — play_game() ignored the savefile");

const restoredFiles = second.FS.readdir(saveDir).filter((n) => n !== "." && n !== "..");
if (JSON.stringify(restoredFiles) !== JSON.stringify(savedFiles))
  fail(`savefile changed across the reload: ${JSON.stringify(savedFiles)} -> ${JSON.stringify(restoredFiles)}`);

const restored = sidebar(second.grid);
if (restored !== saved)
  fail(`restored a different character:\n  saved:    ${saved}\n  restored: ${restored}`);

await second.close();
console.log(`OK: Ctrl-X saved ${savedFiles[0]} and the reload resumed the same character`);
process.exit(0);
