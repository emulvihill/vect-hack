// The paired A/B report: two gym batches over one held-out seed list in, the
// pre-registered decision out (spec
// docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md, "The
// measurement contract"). All the arithmetic lives in src/bot/abReport.ts,
// which may not touch a filesystem because the browser bot shares that
// directory; this script is the half that reads the batches and writes the
// artifacts.
//
// Two artifacts, as 1a's baseline report had:
//   <prefix>.md         front matter (what was compared) + the report body
//   <prefix>-pairs.csv  one row per paired seed — the data file
// The CSV is the deliverable the Markdown cannot replace: the whole point of
// deterministic seeding is that somebody else can re-derive every number here
// per seed, and an aggregate table cannot support that.
//
// The score columns are deliberately EMPTY for a run the harness cut short.
// Larn prints a score only on its end-of-game line, so the 0 in that run's
// summary.json is missing data; writing it into a delta column would let a
// batch that capped more games read as a score regression.
//
// Usage:
//   node scripts/dev/kb-ab-report.mjs --control .gym/holdout-kb-none \
//     --treatment .gym/holdout-kb-data --out docs/reports/2026-08-19-larn-phase1b-ab \
//     [--seed-master 20260819] [--cohort 100]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { abReport, depthDelta, formatAbReport, isScored, pairBatches, scoreDelta, stratumOf } from "../../src/bot/abReport.ts";
import { childSeed, csvField } from "../../src/bot/scoreboard.ts";

const USAGE = `usage: kb-ab-report.mjs --control <dir> --treatment <dir> [--out <path-prefix>]
       [--seed-master <n>] [--cohort <n>]`;

const { values: opts } = parseArgs({
  options: {
    control: { type: "string" },
    treatment: { type: "string" },
    out: { type: "string" },
    "seed-master": { type: "string" },
    cohort: { type: "string" },
  },
});
const die = (msg) => { console.error(msg); process.exit(2); };
if (!opts.control || !opts.treatment) die(USAGE);

/** Every run of a batch, in run-id order. Which directory the filesystem hands
 *  back first must not change a single number in the report. */
function readBatch(arm, dir) {
  if (!existsSync(dir)) die(`--${arm} ${dir} does not exist`);
  const runs = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "summary.json");
    if (existsSync(file)) runs.push(JSON.parse(readFileSync(file, "utf8")));
  }
  if (runs.length === 0) die(`no summary.json under ${dir}`);
  return runs.sort((a, b) => a.seed - b.seed);
}
const control = readBatch("control", opts.control);
const treatment = readBatch("treatment", opts.treatment);

// A seed only one batch played is not a pair. That is a fact about the
// batches, so it is reported here rather than inside the pure code.
const controlSeeds = new Set(control.map((r) => r.seed));
const treatmentSeeds = new Set(treatment.map((r) => r.seed));
const controlOnly = [...controlSeeds].filter((s) => !treatmentSeeds.has(s));
const treatmentOnly = [...treatmentSeeds].filter((s) => !controlSeeds.has(s));

const { pairs, excluded } = pairBatches(control, treatment);
if (pairs.length === 0) die("the two batches share no seed — there is nothing to pair");
const report = abReport(pairs, excluded);

// The cohort check, when the caller names the master: a report that silently
// described the training seeds while claiming the held-out ones would be the
// one failure this whole contract exists to prevent.
let seedMaster = "not stated";
if (opts["seed-master"]) {
  const master = Number(opts["seed-master"]);
  if (!Number.isInteger(master) || master < 1) die(`--seed-master must be a positive integer, got ${opts["seed-master"]}`);
  const size = opts.cohort ? Number(opts.cohort) : new Set([...controlSeeds, ...treatmentSeeds]).size;
  if (!Number.isInteger(size) || size < 1) die(`--cohort must be a positive integer, got ${opts.cohort}`);
  const cohort = new Set(Array.from({ length: size }, (_, i) => childSeed(master, i)));
  const strays = pairs.map((p) => p.seed).filter((s) => !cohort.has(s));
  if (strays.length) die(`${strays.length} paired seed(s) are not childSeed(${master}, i) for i < ${size} — this is not that cohort`);
  seedMaster = `${master} — every paired seed is \`childSeed(${master}, i)\`, i < ${size}`;
}

/** The knowledge states a batch's runs recorded, with how many runs each.
 *  Recorded, not inferred: a run that does not name its own knowledge state
 *  cannot be assigned to an arm afterwards. */
function kbStates(runs) {
  const counts = new Map();
  for (const r of runs) counts.set(r.kb ?? "", (counts.get(r.kb ?? "") ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kb, n]) => `${kb === "" ? '`""` (no KB loaded)' : `\`${kb}\``} × ${n}`);
  return (counts.size > 1 ? "**mixed — this arm is not one knowledge state:** " : "") + parts.join(", ");
}
const controlKb = kbStates(control);
const treatmentKb = kbStates(treatment);
if (controlKb.startsWith("**mixed") || treatmentKb.startsWith("**mixed")) {
  console.error("warning: an arm holds runs from more than one knowledge state");
}

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return null; }
};
const commit = sh("git", ["rev-parse", "HEAD"]);
const dirty = sh("git", ["status", "--porcelain"]) !== "";
const games = [...new Set([...control, ...treatment].map((r) => r.game))].join(", ");

// --- the markdown -----------------------------------------------------------
const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const csvPath = opts.out ? `${opts.out}-pairs.csv` : null;
const md = [];
md.push(`# ${games} bot — Phase 1b held-out A/B (knowledge base on vs off)`);
md.push("");
md.push(`Generated by \`scripts/dev/kb-ab-report.mjs\`. Numbers come from the per-run \`summary.json\` files of the two batches${csvPath ? `; the per-seed data is \`${csvPath.split("/").pop()}\`` : ""}.`);
md.push("");
md.push("## What was compared");
md.push("");
md.push(table(["field", "value"], [
  ["generated", new Date().toISOString()],
  ["git commit", `\`${commit ?? "unavailable"}\`${dirty ? " (working tree dirty when this was generated)" : ""}`],
  ["game", games],
  ["control batch", `\`${opts.control}\` — ${control.length} runs`],
  ["treatment batch", `\`${opts.treatment}\` — ${treatment.length} runs`],
  ["control knowledge state", controlKb],
  ["treatment knowledge state", treatmentKb],
  ["seed master", seedMaster],
  ["paired seeds", `${pairs.length} (control only: ${controlOnly.length}, treatment only: ${treatmentOnly.length})`],
]));
md.push("");
md.push("Each arm's knowledge state is read from what its runs recorded, and it is the only thing that assigns a run to an arm. Two arms can record the same hash and still be different arms: with both fact tiers empty, an untaught knowledge base and the shipped `data/kb` compile to identical tables and therefore to the same hash, so a hash that matches proves nothing either way. `\"\"` is what a run that loaded no knowledge base records, and it is the control arm's marker.");
if (controlOnly.length || treatmentOnly.length) {
  md.push("");
  md.push(`**The batches are not the same seed list.** ${controlOnly.length} seed(s) were played only in the control arm and ${treatmentOnly.length} only in the treatment arm. Those are not pairs and take no part in any number below.`);
}
md.push("");
md.push(formatAbReport(report));
const body = md.join("\n");
console.log(body);

// --- the artifacts ----------------------------------------------------------
if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(`${opts.out}.md`, body.endsWith("\n") ? body : `${body}\n`);

  const CSV_COLUMNS = [
    "seed", "stratum", "controlScore", "treatmentScore", "scoreDelta",
    "controlDepth", "treatmentDepth", "depthDelta", "excludedReason",
  ];
  const lines = [CSV_COLUMNS.join(",")];
  for (const p of [...pairs].sort((a, b) => a.seed - b.seed)) {
    const scored = isScored(p);
    // Missing, not zero: an arm the harness cut short printed no score line.
    const reason = [["control", p.control], ["treatment", p.treatment]]
      .filter(([, r]) => r.outcome !== "died" && r.outcome !== "won")
      .map(([arm, r]) => `${arm} ${r.outcome}`).join("; ");
    lines.push([
      p.seed, stratumOf(p),
      scored ? p.control.score : "", scored ? p.treatment.score : "", scored ? scoreDelta(p) : "",
      p.control.depth, p.treatment.depth, depthDelta(p), reason,
    ].map((v) => csvField(String(v))).join(","));
  }
  writeFileSync(csvPath, lines.join("\n") + "\n");
  console.error(`wrote ${opts.out}.md\nwrote ${csvPath}`);
}
