// Real engine, real IDBFS: a checkpoint taken mid-play survives a tab that
// never exits cleanly. The save-restore test proves Ctrl-X works; this one
// proves the player does not have to press it — which is the whole point of
// the checkpoint, and the only path that exercises save_game_checked() from
// inside the key wait (native/main-wasm.c) rather than from the quit path.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { bootAngband, fail, park, sidebar, until } from "./angband-play.mjs";
import { createAngbandCheckpoint } from "../../src/modules/angband/angbandCheckpoint.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";

if (!existsSync(new URL("../../public/modules/angband/angband.data", import.meta.url)))
  fail("public/modules/angband/angband.{js,wasm,data} missing — run scripts/build/build-angband-wasm.sh");

const saveDir = `${VOLUMES.angband.mountpoint}/save`;
const entries = (FS) => FS.readdir(saveDir).filter((n) => n !== "." && n !== "..");

// --- First visit: walk, let a checkpoint land, then vanish. ---------------
// Every command is due, so the checkpoint fires at the first safe boundary.
const checkpoint = createAngbandCheckpoint({ commands: 1, minIntervalMs: 0 });
let before = null;

const first = await bootAngband({
  checkpoint,
  play: ({ press, session }) => {
    if (!before) before = sidebar(session.grid);
    // Park on the first REPORT, not the first success: an ok=0 must reach the
    // assertion below as itself. Answering more keys instead starves node's
    // timer queue (see park()), so the run would die in the driver with an
    // unrelated message.
    if (session.lastCheckpointOk !== undefined) return park();
    return press(","); // hold still: a real command that cannot wander into trouble
  },
});

// Wait for the engine to REPORT an attempt, not for a truthy one: until()
// returns the first truthy value, so waiting on lastCheckpointOk itself could
// only ever hand back 1 and the failure named on the next line could never
// print — an ok=0 would have surfaced as a timeout blaming the checkpoint
// cadence instead (vect-hack-8r0). checkpointLanded() is what sets the field,
// so "defined" means save_game_checked() answered.
await until(() => first.lastCheckpointOk !== undefined, 60000, "a checkpoint attempt");
const landed = first.lastCheckpointOk;
if (landed !== 1) fail(`save_game_checked() reported failure (ok=${landed})`);
// Same guard as the save-restore test: a probe that never fires would make
// the sawBirth assertion below pass on every run, including a broken one.
if (!first.sawBirth) fail("first visit never saw a birth screen — the sawBirth probe is broken");

await first.persist.flush();
const savedFiles = entries(first.FS);
if (savedFiles.length !== 1)
  fail(`checkpoint wrote ${JSON.stringify(savedFiles)}, expected exactly one savefile`);

// No Ctrl-X and no quit: the tab simply goes away, as a closed tab does.
first.persist.release();
first.FS.filesystems.IDBFS.quit();

// --- Second visit: the character is still there. --------------------------
const second = await bootAngband({ play: () => park() });
await until(() => second.level, 30000, "the checkpointed game to reach play");

if (second.sawBirth)
  fail("no character was recovered — the checkpoint never reached the volume");
if (JSON.stringify(entries(second.FS)) !== JSON.stringify(savedFiles))
  fail("the savefile changed across the reload");

const after = sidebar(second.grid);
if (after !== before)
  fail(`recovered a different character:\n  before: ${before}\n  after:  ${after}`);

await second.close();
console.log(`OK: a checkpoint alone brought ${savedFiles[0]} back after a tab that never quit`);
process.exit(0);
