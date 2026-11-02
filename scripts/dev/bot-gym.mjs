// The gym: play N unattended games of --game with that game's bot, one child
// process each (scripts/dev/bot-gym-<game>.mjs — the child contract is in
// bot-gym-utils.mjs), K at a time, each under a wall-clock timeout, and keep
// the score:
//   <out>/scoreboard.csv          one row per game, appended across runs and games
//   <out>/<id>/summary.json       RunSummary (src/bot/scoreboard.ts)
//   <out>/<id>/trajectory.jsonl.gz
// Prints one line per game and a stats line at the end. This is Phase 0 of
// the self-teaching bot (docs/specs/2026-08-17-self-teaching-bot-design.md):
// the fast, observable, replayable environment; no LLM anywhere in it.
import { spawn } from "node:child_process";
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";
import {
  SCOREBOARD_HEADER, childSeed, emptySummary, formatSummary, scoreboardRow, summarizeScoreboard,
} from "../../src/bot/scoreboard.ts";

const { values: opts } = parseArgs({
  options: {
    game: { type: "string" },
    games: { type: "string", default: "10" },
    parallel: { type: "string", default: String(Math.max(1, Math.floor(availableParallelism() / 2))) },
    "max-commands": { type: "string", default: "3000" },
    timeout: { type: "string", default: "300" }, // seconds per game
    out: { type: "string", default: ".gym" },
    seed: { type: "string", default: "0" },
    // The evaluation arm. "none" is the untaught seed bot, and it is the
    // default on purpose: a KB sitting in the working tree must never reach a
    // run that did not ask for it, or the control arm and the frozen
    // keystroke trace would both quietly be measuring something else.
    kb: { type: "string", default: "none" },
  },
});
const here = dirname(fileURLToPath(import.meta.url));
const game = opts.game;
const child = game ? join(here, `bot-gym-${game}.mjs`) : null;
if (!child || !existsSync(child)) {
  console.error(`usage: bot-gym.mjs --game <name> [--games N] [--parallel K] [--max-commands N] [--timeout S] [--out DIR] [--seed N] [--kb DIR|none]`);
  console.error(`  --game names scripts/dev/bot-gym-<name>.mjs; available: larn`);
  process.exit(2);
}
// Every numeric flag comes through here: a bare Number() turns a typo like
// `--games 1O` into NaN, and a batch of NaN games plays nothing and exits 0.
function intOpt(name, min) {
  const n = Number(opts[name]);
  if (!Number.isInteger(n) || n < min) {
    console.error(`--${name} must be ${min === 0 ? "a non-negative" : "a positive"} integer, got ${opts[name]}`);
    process.exit(2);
  }
  return n;
}
const games = intOpt("games", 1);
const parallel = intOpt("parallel", 1);
const maxCommands = intOpt("max-commands", 1);
const timeoutMs = intOpt("timeout", 1) * 1000;
const out = opts.out;
// 0 = every game seeds from the clock (Phase 0 behaviour). A non-zero master
// makes the whole batch one reproducible list: game i always gets the same
// dungeon, which is what paired per-seed comparison later depends on.
const master = intOpt("seed", 0);
const seedFor = (i) => (master === 0 ? 0 : childSeed(master, i));
// A misspelled KB directory must not quietly become the control arm: every
// child would then play untaught and the batch would look like a valid run of
// the arm it was asked for. Fail here, before the first game.
if (opts.kb !== "none" && !(existsSync(opts.kb) && statSync(opts.kb).isDirectory())) {
  console.error(`--kb must be "none" or an existing directory, got ${opts.kb}`);
  process.exit(2);
}

mkdirSync(out, { recursive: true });
const scoreboard = join(out, "scoreboard.csv");
if (!existsSync(scoreboard)) writeFileSync(scoreboard, SCOREBOARD_HEADER + "\n");

// Ids sort by time and stay unique across invocations: <game>-<utc stamp>-<pid>-<n>.
// The stamp has second resolution, so the pid is what keeps two batches launched
// in the same second out of each other's run directory.
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const runId = (i) => `${game}-${stamp}-${process.pid}-${String(i + 1).padStart(4, "0")}`;

async function gzipTrajectory(dir) {
  const raw = join(dir, "trajectory.jsonl");
  if (!existsSync(raw)) return;
  await pipeline(createReadStream(raw), createGzip(), createWriteStream(raw + ".gz"));
  unlinkSync(raw);
}

// An unseeded child falls back to the engine's own clock seeding — Larn's is
// time() at second resolution (io.c newgame) — so two children born in the same
// second play the same game, and spacing the starts is the only thing keeping
// such a batch varied. A seeded batch hands every child its own seed
// (vect-hack-1x5), where the gap buys nothing and costs 1.1s per game.
const spawnGapMs = master === 0 ? 1100 : 0;
let nextSpawnAt = 0;

async function playOne(i) {
  const id = runId(i);
  const dir = join(out, id);
  // Claim the slot before awaiting it: lanes that read the same nextSpawnAt and
  // only advanced it afterwards would all wake at the same instant.
  const startAt = Math.max(Date.now(), nextSpawnAt);
  nextSpawnAt = startAt + spawnGapMs;
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [
      child, "--out", dir, "--id", id, "--max-commands", String(maxCommands),
      "--seed", String(seedFor(i)), "--kb", opts.kb,
    ], { stdio: ["ignore", "inherit", "inherit"] });
    let killed = false;
    let settled = false;
    const timer = setTimeout(() => { killed = true; proc.kill("SIGKILL"); }, timeoutMs);
    // A child that never starts (ENOENT, EAGAIN) emits 'error' and may never emit
    // 'exit', so a lane listening for 'exit' alone would never settle and the whole
    // batch would hang. Either event ends the game here; node may emit both, and the
    // second one finds the game already settled.
    async function finish(code, signal, spawnErr) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const endedAt = new Date().toISOString();
      const file = join(dir, "summary.json");
      // Nothing here may throw: an unhandled rejection in this callback would take
      // the whole batch down and orphan the children still playing.
      const wrote = !spawnErr && existsSync(file);
      let summary;
      try {
        summary = wrote
          ? JSON.parse(readFileSync(file, "utf8"))
          : emptySummary({
            game, id, startedAt, endedAt, outcome: "fatal", seed: seedFor(i),
            error: spawnErr ? `spawn failed: ${String(spawnErr)}` : `child exited ${code ?? signal} without a summary`,
          });
      } catch (err) {
        summary = emptySummary({ game, id, startedAt, endedAt, outcome: killed ? "timeout" : "fatal", seed: seedFor(i), error: `summary.json unreadable: ${String(err)}` });
      }
      // A killed child left at most a `running` snapshot: keep its numbers, name the
      // outcome. But a game that ended in the same tick the timer fired wrote a real
      // verdict, and the child's own verdict outranks the harness's clock.
      if (killed && (!wrote || summary.outcome === "running")) summary = { ...summary, endedAt, outcome: "timeout" };
      else if (summary.outcome === "running") summary = { ...summary, endedAt, outcome: "fatal", error: `child exited ${code ?? signal} mid-game` };
      mkdirSync(dir, { recursive: true });
      // A trajectory that would not compress does not change how the game ended.
      try {
        await gzipTrajectory(dir);
      } catch (err) {
        summary = { ...summary, error: (summary.error ? summary.error + "; " : "") + `gzip failed: ${String(err)}` };
      }
      writeFileSync(file, JSON.stringify(summary, null, 2));
      resolve(summary);
    }
    proc.on("error", (err) => { void finish(null, null, err); });
    proc.on("exit", (code, signal) => { void finish(code, signal, null); });
  });
}

// Report in launch order, not completion order: game i is always row i, so two
// batches over the same seed list read against each other line by line. A
// finished game waits only on the games launched before it, so a long batch
// still reports as it goes.
const results = new Array(games);
let reported = 0;
function report() {
  while (reported < games && results[reported]) {
    const summary = results[reported++];
    appendFileSync(scoreboard, scoreboardRow(summary) + "\n");
    console.log(`${summary.id}  ${summary.outcome.padEnd(7)} depth ${summary.depth}  xl ${summary.xlevel}  commands ${summary.commands}  ${summary.cause || summary.error}`);
  }
}

let next = 0;
async function lane() {
  while (next < games) {
    const i = next++;
    results[i] = await playOne(i);
    report();
  }
}
await Promise.all(Array.from({ length: Math.min(parallel, games) }, lane));

console.log(formatSummary(summarizeScoreboard(results)));
console.log(`scoreboard: ${scoreboard}`);
process.exit(results.some((r) => r.outcome === "fatal") ? 1 : 0);
