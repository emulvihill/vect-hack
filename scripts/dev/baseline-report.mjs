// Turn one gym batch into the three baseline artifacts a later phase is
// measured against:
//   <out>/<slug>-runs.csv       one canonical row per seed — the data file
//   <out>/<slug>-manifest.json  everything needed to re-run the batch
//   <out>/<slug>.md             the report: outcome split, intervals, shapes
// The CSV is the deliverable the Markdown cannot replace: paired per-seed
// comparison is the whole point of deterministic seeding, and an aggregate
// table cannot support it.
//
// Two rules the numbers here obey, because the report is quoted later by
// people who will not re-derive them:
//   1. died/won are game results; capped/timeout/fatal are harness results.
//      A loss rate that folds in a command cap measures the budget, not the
//      bot, so rates are computed over game results only.
//   2. Every rate carries a two-sided 95% Wilson interval. A pilot of 100
//      games cannot detect a small improvement, and the interval is the only
//      thing on the page that says so numerically.
//
// Distributions, never a lone central tendency: the seed bot's runs are
// bimodal (the town's volcanic shaft drops a level-1 character to depth 11,
// where it dies in a handful of commands), so a median over both populations
// describes no actual game.
//
// Usage:
//   node scripts/dev/baseline-report.mjs --batch .gym/baseline-2026-08-18 \
//     --out docs/reports --slug 2026-08-18-larn-baseline \
//     --train-master 20260818 --holdout-master 20260819 --cohort 100 \
//     --max-commands 3000 --timeout 300 --parallel 4 [--notes FILE]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { canonicalRecord } from "../../src/bot/canonical.ts";
import { childSeed, csvField } from "../../src/bot/scoreboard.ts";

const { values: opts } = parseArgs({
  options: {
    batch: { type: "string" },
    out: { type: "string", default: "docs/reports" },
    slug: { type: "string" },
    game: { type: "string", default: "larn" },
    wasm: { type: "string", default: "public/modules/larn/larn.wasm" },
    "train-master": { type: "string" },
    "holdout-master": { type: "string" },
    cohort: { type: "string", default: "100" },
    "max-commands": { type: "string", default: "3000" },
    timeout: { type: "string", default: "300" },
    parallel: { type: "string", default: "4" },
    notes: { type: "string" },
  },
});
function need(name) {
  if (!opts[name]) { console.error(`--${name} is required`); process.exit(2); }
  return opts[name];
}
function intOpt(name) {
  const n = Number(opts[name]);
  if (!Number.isInteger(n) || n < 1) { console.error(`--${name} must be a positive integer, got ${opts[name]}`); process.exit(2); }
  return n;
}
const batch = need("batch");
const slug = need("slug");
const outDir = opts.out;
const game = opts.game;
const trainMaster = intOpt("train-master");
const holdoutMaster = intOpt("holdout-master");
const cohort = intOpt("cohort");
const maxCommands = intOpt("max-commands");
const timeoutS = intOpt("timeout");
const parallel = intOpt("parallel");

// --- the two frozen cohorts -------------------------------------------------
// Drawn here and written into the manifest, so a later phase can reflect on
// the training seeds and be held to the evaluation ones. Overlap would let it
// learn its own test set, so it is an assertion, not a comment.
const train = Array.from({ length: cohort }, (_, i) => childSeed(trainMaster, i));
const holdout = Array.from({ length: cohort }, (_, i) => childSeed(holdoutMaster, i));
if (new Set([...train, ...holdout]).size !== train.length + holdout.length) {
  console.error("cohorts overlap or repeat a seed — refusing to freeze them");
  process.exit(1);
}

// --- the batch --------------------------------------------------------------
const runs = [];
for (const entry of readdirSync(batch, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const file = join(batch, entry.name, "summary.json");
  if (existsSync(file)) runs.push(JSON.parse(readFileSync(file, "utf8")));
}
if (runs.length === 0) { console.error(`no summary.json under ${batch}`); process.exit(1); }
runs.sort((a, b) => train.indexOf(a.seed) - train.indexOf(b.seed));

// The batch must be the training cohort and nothing else: a report that
// silently described a different seed list would be unreproducible and
// unpairable, which is the one thing these artifacts exist to prevent.
const played = runs.map((r) => r.seed);
const missing = train.filter((s) => !played.includes(s));
const extra = played.filter((s) => !train.includes(s));
if (missing.length || extra.length) {
  console.error(`batch is not the training cohort: ${missing.length} seeds missing, ${extra.length} unexpected`);
  process.exit(1);
}

const GAME_OUTCOMES = ["died", "won"];
const HARNESS_OUTCOMES = ["capped", "timeout", "fatal", "running"];
const seconds = (r) => (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000;
const larn = (r) => (r.details?.larn ?? {});
const mobuls = (r) => Number(larn(r).mobulsElapsed ?? 0);

function count(list, pick) {
  const m = new Map();
  for (const r of list) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
/** Linear-interpolated quantile (the R-7 definition), stated in the report so
 *  a later batch's numbers are compared under the same rule. */
function quantile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const round = (n, d = 2) => Number(n.toFixed(d));
function dist(values) {
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : 0,
    p25: round(quantile(values, 0.25)),
    median: round(quantile(values, 0.5)),
    p75: round(quantile(values, 0.75)),
    max: values.length ? Math.max(...values) : 0,
    mean: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : 0,
  };
}
/** Two-sided 95% Wilson score interval. Wilson rather than normal-approximate
 *  because at 0 successes the normal interval collapses to [0, 0], which reads
 *  as certainty the bot can never win. */
function wilson(successes, n, z = 1.959964) {
  if (n === 0) return { rate: 0, lo: 0, hi: 0 };
  const p = successes / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
const pc = (x) => `${(x * 100).toFixed(1)}%`;

const isGame = (r) => GAME_OUTCOMES.includes(r.outcome);
// Larn prints the score only on the end-of-game score line, so a run the
// harness cut short has no score at all — 0 there is a missing value, not a
// zero. Score distributions therefore run over game results only; gold is the
// continuous number every run does have.
const scored = (list) => list.filter(isGame).map((r) => r.score);
const gameRuns = runs.filter((r) => GAME_OUTCOMES.includes(r.outcome));
const harnessRuns = runs.filter((r) => !GAME_OUTCOMES.includes(r.outcome));
const wins = runs.filter((r) => r.outcome === "won").length;
const win = wilson(wins, gameRuns.length);

// The two modes. The town's volcanic shaft lands a level-1 character on
// depth 11; nothing else in the seed bot's ladder gets there, so depth is a
// clean split between the population that took it and the one that did not.
const SHAFT_DEPTH = 11;
const volcano = runs.filter((r) => r.depth >= SHAFT_DEPTH);
const surface = runs.filter((r) => r.depth < SHAFT_DEPTH);
const shaftRate = wilson(volcano.length, runs.length);

const COMMAND_BUCKETS = [
  ["0-9", (n) => n < 10], ["10-29", (n) => n < 30], ["30-99", (n) => n < 100],
  ["100-299", (n) => n < 300], ["300-999", (n) => n < 1000],
  [`1000-${maxCommands - 1}`, (n) => n < maxCommands], [`${maxCommands} (capped)`, () => true],
];
function commandHistogram(list) {
  const rows = COMMAND_BUCKETS.map(([label]) => [label, 0]);
  for (const r of list) {
    for (let i = 0; i < COMMAND_BUCKETS.length; i++) {
      if (COMMAND_BUCKETS[i][1](r.commands)) { rows[i][1]++; break; }
    }
  }
  return rows;
}

const startedAt = runs.map((r) => Date.parse(r.startedAt)).reduce((a, b) => Math.min(a, b));
const endedAt = runs.map((r) => Date.parse(r.endedAt)).reduce((a, b) => Math.max(a, b));
const perGame = runs.map(seconds);
const throughput = {
  concurrency: parallel,
  p50Seconds: round(quantile(perGame, 0.5), 3),
  p95Seconds: round(quantile(perGame, 0.95), 3),
  maxSeconds: round(Math.max(...perGame), 3),
  batchSeconds: round((endedAt - startedAt) / 1000, 3),
};

// --- provenance -------------------------------------------------------------
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return null; }
};
const EMCC = ["emcc", "external/emsdk/upstream/emscripten/emcc"];
let emcc = null;
for (const c of EMCC) { emcc = sh(c, ["--version"])?.split("\n")[0] ?? null; if (emcc) break; }
const wasmSha = createHash("sha256").update(readFileSync(opts.wasm)).digest("hex");
const commit = sh("git", ["rev-parse", "HEAD"]);
const dirty = sh("git", ["status", "--porcelain"]) !== "";

// --- artifacts --------------------------------------------------------------
mkdirSync(outDir, { recursive: true });

const CSV_COLUMNS = [
  "index", "seed", "game", "outcome", "kind", "depth", "xlevel", "hp", "hpmax",
  "commands", "score", "gold", "mobulsElapsed", "seconds", "cause", "lastMessages",
];
const csvLines = [CSV_COLUMNS.join(",")];
runs.forEach((r, i) => {
  const c = canonicalRecord(r);
  csvLines.push([
    i, c.seed, c.game, c.outcome, GAME_OUTCOMES.includes(c.outcome) ? "game" : "harness",
    c.depth, c.xlevel, c.hp, c.hpmax, c.commands, c.score, larn(r).gold ?? 0, mobuls(r),
    round(seconds(r), 3), c.cause, c.lastMessages.join(" | "),
  ].map((v) => csvField(String(v))).join(","));
});
const csvPath = join(outDir, `${slug}-runs.csv`);
writeFileSync(csvPath, csvLines.join("\n") + "\n");

const manifest = {
  generatedAt: new Date().toISOString(),
  game,
  batchDir: batch,
  gym: {
    command: `npm run bot:headless -- --game ${game} --games ${runs.length} --parallel ${parallel} --max-commands ${maxCommands} --timeout ${timeoutS} --seed ${trainMaster} --out ${batch}`,
    games: runs.length, parallel, maxCommands, timeoutSeconds: timeoutS, seedMaster: trainMaster,
  },
  cohorts: {
    size: cohort, trainMaster, holdoutMaster,
    derivation: "childSeed(master, i) from src/bot/scoreboard.ts, i = 0..size-1",
    overlap: 0,
    train, holdout,
  },
  build: {
    gitCommit: commit, gitDirtyAtGeneration: dirty,
    wasm: opts.wasm, wasmSha256: wasmSha,
    node: process.version, emcc,
  },
  batch: {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds: throughput.batchSeconds,
  },
  throughput,
};
const manifestPath = join(outDir, `${slug}-manifest.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const distRow = (name, values) => {
  const d = dist(values);
  return [name, d.n, d.min, d.p25, d.median, d.p75, d.max, d.mean];
};
function cohortBlock(name, list) {
  if (!list.length) return `**${name}** — no games.\n`;
  const outcomes = count(list, (r) => r.outcome).map(([k, v]) => `${k} ${v}`).join(", ");
  return [
    `**${name}** — ${list.length} of ${runs.length} games (${pc(list.length / runs.length)}); outcomes: ${outcomes}.`,
    "",
    table(["measure", "n", "min", "p25", "median", "p75", "max", "mean"], [
      distRow("depth", list.map((r) => r.depth)),
      distRow("commands", list.map((r) => r.commands)),
      distRow("score (game results only)", scored(list)),
      distRow("gold", list.map((r) => Number(larn(r).gold ?? 0))),
      distRow("mobuls elapsed", list.map(mobuls)),
    ]),
    "",
  ].join("\n");
}

const md = [];
md.push(`# Larn survivor bot — Phase 1a baseline (pilot, ${runs.length} games)`);
md.push("");
md.push(`Generated by \`scripts/dev/baseline-report.mjs\` from \`${batch}\`. Numbers come from the per-run \`summary.json\` files; the per-seed data is \`${slug}-runs.csv\` and the re-run recipe is \`${slug}-manifest.json\`.`);
md.push("");
md.push("## What was run");
md.push("");
md.push(table(["field", "value"], [
  ["command", `\`${manifest.gym.command}\``],
  ["git commit", `\`${commit}\`${dirty ? " (working tree dirty when this was generated)" : ""}`],
  ["larn.wasm sha256", `\`${wasmSha}\``],
  ["node / emcc", `${process.version} / ${emcc ?? "unavailable"}`],
  ["seed cohort", `training, master ${trainMaster}, ${cohort} seeds`],
  ["held-out cohort", `master ${holdoutMaster}, ${cohort} seeds — **not played here**`],
  ["batch window", `${manifest.batch.startedAt} → ${manifest.batch.endedAt}`],
]));
md.push("");
md.push("## Outcomes: game results and harness results are separate");
md.push("");
md.push("`died` and `won` are results of playing. `capped` (the `--max-commands` budget ran out), `timeout` and `fatal` are artifacts of the harness and say nothing about the bot's play. They are never folded into a loss rate.");
md.push("");
md.push(table(["kind", "outcome", "games", "share of all runs"],
  [...GAME_OUTCOMES, ...HARNESS_OUTCOMES]
    .map((o) => [GAME_OUTCOMES.includes(o) ? "game" : "harness", o, runs.filter((r) => r.outcome === o).length, pc(runs.filter((r) => r.outcome === o).length / runs.length)])
    .filter((r) => r[2] > 0)));
md.push("");
md.push(`Game results: **${gameRuns.length}**. Harness results: **${harnessRuns.length}**.`);
md.push("");
md.push("## Win rate, with its interval");
md.push("");
md.push(`Wins / game results = **${wins}/${gameRuns.length} = ${pc(win.rate)}**, two-sided 95% Wilson interval **[${pc(win.lo)}, ${pc(win.hi)}]**.`);
md.push("");
md.push(`**This is a pilot, not a promotion baseline.** With ${gameRuns.length} game results the interval's upper bound is ${pc(win.hi)}: any later change that lifted the true win rate to a few percent would be statistically indistinguishable from this batch. Nobody may quote "${pc(win.rate)} win rate" as evidence that a later improvement is real. Detecting a win rate of that size needs thousands of games, or a continuous metric — score and depth — instead.`);
md.push("");
md.push("## The distribution is bimodal — read the modes, not the median");
md.push("");
md.push(`The town holds a volcanic shaft straight to depth ${SHAFT_DEPTH}, and the seed bot takes any descent it is offered. **${volcano.length} of ${runs.length}** games (${pc(shaftRate.rate)}, 95% Wilson [${pc(shaftRate.lo)}, ${pc(shaftRate.hi)}]) reached depth ${SHAFT_DEPTH} or deeper, where a level-1 character with ${dist(volcano.map((r) => r.hpmax)).median} max HP dies almost immediately. The rest never leave the top few levels. A single median over both populations describes no game that was actually played, so every distribution below is given per mode as well as overall.`);
md.push("");
md.push("Quantiles are the linear-interpolated (R-7) definition. Larn prints a score only on its end-of-game score line, so a run the harness cut short has no score to read: the score rows below cover game results only, and the 0 those runs carry in the CSV is a missing value, not a zero. Gold is recorded for every run and is the continuous number that survives a cap.");
md.push("");
md.push("### Overall");
md.push("");
md.push(table(["measure", "n", "min", "p25", "median", "p75", "max", "mean"], [
  distRow("depth", runs.map((r) => r.depth)),
  distRow("commands", runs.map((r) => r.commands)),
  distRow("score (game results only)", scored(runs)),
  distRow("gold", runs.map((r) => Number(larn(r).gold ?? 0))),
  distRow("mobuls elapsed", runs.map(mobuls)),
  distRow("xlevel", runs.map((r) => r.xlevel)),
]));
md.push("");
md.push("### By mode");
md.push("");
md.push(cohortBlock(`Volcano mode — depth ≥ ${SHAFT_DEPTH}`, volcano));
md.push(cohortBlock(`Surface mode — depth < ${SHAFT_DEPTH}`, surface));
md.push("### Depth histogram");
md.push("");
md.push(table(["deepest level", "games"],
  count(runs, (r) => r.depth).sort((a, b) => a[0] - b[0]).map(([d, n]) => [d, n])));
md.push("");
md.push("### Commands-survived histogram");
md.push("");
md.push(table(["commands", "all", `depth ≥ ${SHAFT_DEPTH}`, `depth < ${SHAFT_DEPTH}`], (() => {
  const all = commandHistogram(runs), v = commandHistogram(volcano), s = commandHistogram(surface);
  return all.map((row, i) => [row[0], row[1], v[i][1], s[i][1]]).filter((r) => r[1] > 0);
})()));
md.push("");
md.push("## How the games ended");
md.push("");
md.push(table(["cause of death", "games", "share of deaths"], count(runs.filter((r) => r.outcome === "died"), (r) => r.cause || "(no epitaph)")
  .map(([c, n]) => [c, n, pc(n / Math.max(1, runs.filter((r) => r.outcome === "died").length))])));
md.push("");
md.push("## Throughput");
md.push("");
md.push(`At concurrency **${parallel}**, per-game wall clock is **p50 ${throughput.p50Seconds}s, p95 ${throughput.p95Seconds}s** (max ${throughput.maxSeconds}s). The whole batch of ${runs.length} games took **${throughput.batchSeconds}s**. Per-game seconds under parallel load are not a serial cost: they are only comparable against another run at the same concurrency, which is why the number is stated with one.`);
md.push("");
// Everything above is computed; interpretation is authored, so it lives in a
// file of its own and is spliced verbatim rather than templated into this
// script. Regenerating the report cannot silently rewrite it.
if (opts.notes) {
  md.push(`_The sections below are authored commentary, spliced verbatim from \`${opts.notes}\`._`, "");
  md.push(readFileSync(opts.notes, "utf8").trimEnd(), "");
}
const mdPath = join(outDir, `${slug}.md`);
writeFileSync(mdPath, md.join("\n"));

console.log(`${runs.length} runs — ${gameRuns.length} game results, ${harnessRuns.length} harness results`);
console.log(`win rate ${pc(win.rate)} 95% CI [${pc(win.lo)}, ${pc(win.hi)}]`);
console.log(`wrote ${csvPath}\nwrote ${manifestPath}\nwrote ${mdPath}`);
