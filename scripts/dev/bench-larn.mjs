// npm run bench:larn — the one command Phase 2 is read against
// (bead vect-hack-h9x.1, spec docs/specs/2026-08-28-larn-bench-design.md).
//
// It plays a FROZEN seed set through the gym and reduces the batch to the
// pre-registered metrics. Frozen is the whole point: the master and the cohort
// are constants below, so a run today and a run next week are comparable. Move
// one and every earlier number stops meaning anything, so moving one is a spec
// amendment, not a flag.
//
// Two sets, and the wall between them is this file's comment and the runbook,
// not the code:
//   --set bench     master 20260828 — for iterating. Run it as often as you like.
//   --set held-out  master 20260829 — for deciding. Once per shipped change.
// A change tuned against held-out has burned held-out. Amend the spec.
//
// The arithmetic is in src/modules/larn/bot/bench.ts, which may not touch a
// filesystem; this script is the half that plays the batch and writes the
// artifact.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { benchMetrics, formatBench } from "../../src/modules/larn/bot/bench.ts";
import { resolveTuning } from "../../src/modules/larn/bot/policy.ts";

/** Frozen. See the header — changing either is a spec amendment. */
const SETS = {
  bench: { master: 20260828, games: 500 },
  "held-out": { master: 20260829, games: 500 },
};
/** The bench measures the BOT, so it must not also be measuring a truncation:
 *  3000 is the gym default and the budget every Phase 1 batch was played at. */
const MAX_COMMANDS = 3000;
/** The spec's budget. A bench that takes longer is a finding, not a wait. */
const BUDGET_MS = 15 * 60 * 1000;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

const { values: opts } = parseArgs({
  options: {
    set: { type: "string", default: "bench" },
    parallel: { type: "string", default: "16" },
    // A partial tuning override for the gym's --tuning (policy-sweep.mjs's
    // arms). "{}" is the bot as shipped.
    tuning: { type: "string", default: "{}" },
    out: { type: "string" },
    // Play into an existing batch directory instead of running the gym. For
    // re-reading a batch the metrics changed under, and for the tests.
    "read-only": { type: "boolean", default: false },
  },
});
const die = (msg) => { console.error(msg); process.exit(2); };

const set = SETS[opts.set];
if (!set) die(`--set must be one of ${Object.keys(SETS).join(", ")}, got ${opts.set}`);
const out = opts.out ?? join(repo, ".gym", `bench-${opts.set}`);
let tuning;
try {
  tuning = JSON.parse(opts.tuning);
  resolveTuning(tuning);
} catch (e) { die(`--tuning: ${e.message}`); }

if (!opts["read-only"]) {
  console.log(`bench:larn — set ${opts.set}, master ${set.master}, ${set.games} games, tuning ${JSON.stringify(tuning)}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [
    join(here, "bot-gym.mjs"),
    "--game", "larn",
    "--games", String(set.games),
    "--seed", String(set.master),
    "--max-commands", String(MAX_COMMANDS),
    "--parallel", opts.parallel,
    "--tuning", JSON.stringify(tuning),
    "--out", out,
  ], { stdio: ["ignore", "ignore", "inherit"], cwd: repo });
  if (r.status !== 0) die(`gym exited ${r.status}`);
  const elapsed = Date.now() - started;
  console.log(`played in ${(elapsed / 1000).toFixed(1)}s`);
  if (elapsed > BUDGET_MS) {
    console.error(`WARNING: over the spec's ${BUDGET_MS / 60000}-minute budget — re-time it and amend the spec`);
  }
}

if (!existsSync(out)) die(`no batch at ${out}`);
// A directory can hold rows from more than one invocation (the gym appends).
// Read the summaries rather than the CSV: the chain depths live in
// details.larn, which is deliberately not a scoreboard column.
const rows = [];
for (const name of readdirSync(out)) {
  const f = join(out, name, "summary.json");
  if (!existsSync(f)) continue;
  const s = JSON.parse(readFileSync(f, "utf8"));
  // A `running` snapshot is a progress write from a game that was killed
  // before it finished. It is not a result.
  if (s.outcome !== "running") rows.push(s);
}
if (rows.length === 0) die(`no summaries under ${out}`);

const metrics = benchMetrics(rows);
console.log(formatBench(metrics));

const artifact = join(out, "bench.json");
writeFileSync(artifact, JSON.stringify({
  set: opts.set, master: set.master, games: set.games, maxCommands: MAX_COMMANDS,
  tuning, at: new Date().toISOString(), metrics,
}, null, 2) + "\n");
console.log(`artifact: ${artifact}`);

// A harness fault means the numbers describe a broken run. Fail loudly: this
// is the bench's only assertion, and without it a red batch prints a tidy
// table and exits 0.
process.exit(metrics.valid ? 0 : 1);
