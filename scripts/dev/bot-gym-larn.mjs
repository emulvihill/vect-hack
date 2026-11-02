// One headless Larn game: boot the real WASM engine in this process, let the
// LarnBotPlayer play it at full speed against no view, record every event
// and key, and leave
//   <out>/trajectory.jsonl   one {i, name, ev, reply} line per event (gzipped by bot-gym.mjs)
//   <out>/summary.json       RunSummary (src/bot/scoreboard.ts)
// then exit. One process per game on purpose: a fresh dungeon, a fresh wasm
// heap, and a wedged engine is the orchestrator's SIGKILL, not a leak.
//
// Same boot as scripts/test/test-larn-boot.mjs; the VectLarn object is the
// shared bridge (src/modules/larn/shimBridge.ts) every host installs, with the
// bot behind it instead of postMessage. Larn ends through exit(): __wrap_exit
// calls quit() first, and everything owed to disk is written synchronously
// there.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import createLarnModule from "../../public/modules/larn/larn.js";
import { mountLarnStorage } from "../../src/modules/larn/persist.ts";
import { LarnBotPlayer } from "../../src/modules/larn/bot/LarnBotPlayer.ts";
import { LarnRecorder } from "../../src/modules/larn/bot/recorder.ts";
import { installLarnShim } from "../../src/modules/larn/shimBridge.ts";
import { buildRunSummary } from "../../src/bot/scoreboard.ts";
import { childArgs, openRunWriter } from "./bot-gym-utils.mjs";
import { larnKb } from "./bot-kb.mjs";

const { outDir, id, maxCommands, seed, kbDir } = childArgs("bot-gym-larn.mjs");
const CORE = (name) => fileURLToPath(new URL(`../../public/modules/larn/${name}`, import.meta.url));
if (!existsSync(CORE("larn.data"))) {
  console.error("public/modules/larn/larn.{js,wasm,data} missing — run npm run build:larn");
  process.exit(2);
}
const PROGRESS_EVERY = 200;

/** No view: the bot answers every key; display events need no reply. */
const nullView = () => ({ onNotice: () => {}, handle: () => {}, nextKey: () => null });

const writer = openRunWriter(outDir);
const kb = larnKb(kbDir);
const bot = new LarnBotPlayer(nullView(), kb, 0); // no pacing: full speed
const rec = new LarnRecorder(bot, (line) => writer.line(line));
const startedAt = new Date().toISOString();
const stderr = [];
let finished = false;

// diedsub() always prints an epitaph on a real death; an exit with none is a fault.
const endOutcome = () => (bot.model.won() ? "won" : bot.model.snapshot().cause ? "died" : "fatal");
function summary(outcome, error = "") {
  return buildRunSummary(
    // The control arm names no knowledge state: an empty KB's hash is a real
    // hash of empty tables, and writing it here would let a control run be
    // mistaken for a treatment run whose facts all happened to be filtered out.
    { game: "larn", id, startedAt, endedAt: new Date().toISOString(), outcome, seed,
      kb: kbDir ? kb.hash : "", stderr: stderr.slice(-20), error },
    bot.model.snapshot(),
    rec.log,
  );
}
/** Synchronous by design: quit() is followed by __real_exit. */
function finish(outcome, error = "") {
  if (finished) return;
  finished = true;
  writer.close();
  writer.summary(summary(outcome, error));
  process.exit(outcome === "fatal" ? 1 : 0);
}
process.on("unhandledRejection", (e) => finish(bot.model.gameOver ? endOutcome() : "fatal", String(e)));
process.on("uncaughtException", (e) => finish(bot.model.gameOver ? endOutcome() : "fatal", String(e)));

installLarnShim({
  name: "scripts/dev/bot-gym-larn.mjs",
  // Gym mode (main-wasm.c __wrap_newgame): 0 means "seed from the clock".
  gymSeed: () => seed,
  // Headless: no human is watching an animation frame (main-wasm.c
  // __wrap_sleep). Flushes still happen; only the waiting is gone.
  gymFast: () => 1,
  // Every display callback, already decoded and copied out of the heap by the
  // bridge, straight into the recorder.
  onEvent: (ev) => rec.handle(ev),
  saveLanded: () => {},
  notice: (text) => rec.onNotice(text),
  quit: () => {
    bot.onQuit();
    const outcome = endOutcome();
    finish(outcome, outcome === "fatal" ? "engine exited without an epitaph" : "");
  },
  gatherKey: async (wait, cmd) => {
    const key = await rec.nextKey(wait, cmd);
    if (cmd && wait) {
      const n = bot.model.commands;
      if (n >= maxCommands) finish("capped");
      else if (n % PROGRESS_EVERY === 0) writer.summary(summary("running"));
    }
    return key;
  },
});

/** Mount after the preload package, before main().
 *
 * The --preload-file package appends its own unpack to Module.preRun, so this
 * one runs first and /lib does not exist yet — and session-only storage
 * (locks: null) never awaits, so its seed would mkdir /lib/home right then and
 * fail with ENOENT, leaving Larn to print "Can't write scoreboard" and exit.
 * Hold main() with a run dependency instead (run() awaits the ones preRun
 * adds) and mount on the microtask after the whole preRun pass. */
function mountAfterPreload(m) {
  m.addRunDependency("gym-mount");
  queueMicrotask(() => {
    mountLarnStorage(m, { locks: null });
    if (!m.FS.analyzePath("/lib/home").exists) throw new Error("session-only storage has no /lib/home");
    m.removeRunDependency("gym-mount");
  });
}

createLarnModule({
  locateFile: (p) => CORE(p),
  // Under node emscripten hands process.argv.slice(2) to main(): without this
  // the child's own --out/--id reach Larn's option parser, which prints
  // "Unknown option <--out>" and exits before the first key wait.
  arguments: [],
  print: () => {},
  printErr: (t) => { stderr.push(String(t)); },
  preRun: [mountAfterPreload],
}).catch((e) => finish("fatal", String(e)));
