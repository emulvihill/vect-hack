// A coarse search over the ladder's tuning knobs, judged by the bench
// (vect-hack-h9x.11). The gym plays 500 games in about 75 seconds, so a knob
// that has never been tried costs about a minute to try.
//
// It runs on the BENCH seed set and never on held-out, and that is the whole
// discipline of the thing: searching over a seed set is what burns it, so the
// search happens on the set that exists to be burned and the winner is
// validated ONCE against held-out by hand
// (docs/specs/2026-08-28-larn-bench-design.md).
//
// Each arm is a partial override of DEFAULT_TUNING
// (src/modules/larn/bot/policy.ts), handed to the gym as --tuning, so every
// game records the override it played under and no arm can be confused for
// another afterwards.
//
//   node scripts/dev/policy-sweep.mjs --knob restBelowHpFraction --values 0.5,0.7,0.9
//   node scripts/dev/policy-sweep.mjs --grid '[{"restBelowHpFraction":0.7,"restLimit":300}]'
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveTuning } from "../../src/modules/larn/bot/policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

const { values: opts } = parseArgs({
  options: {
    knob: { type: "string" },
    values: { type: "string" },
    grid: { type: "string" },
    set: { type: "string", default: "bench" },
    out: { type: "string", default: ".gym/sweep" },
    parallel: { type: "string", default: "16" },
  },
});
const die = (m) => { console.error(m); process.exit(2); };
if (opts.set === "held-out") {
  die("refusing to sweep on held-out: that set exists to decide, not to search.\n"
    + "  Sweep on --set bench, then validate the winner once by hand.");
}

/** The arms, each a partial tuning override. */
let arms;
if (opts.grid) arms = JSON.parse(opts.grid);
else if (opts.knob && opts.values) {
  arms = opts.values.split(",").map((v) => ({ [opts.knob]: JSON.parse(v.trim()) }));
} else {
  die("usage: policy-sweep.mjs --knob <name> --values a,b,c | --grid '<json array>' [--set bench] [--out DIR]");
}

// Every arm is checked against DEFAULT_TUNING before the first one plays, so
// a misspelt knob cannot cost the arms ahead of it.
for (const arm of arms) {
  try { resolveTuning(arm); } catch (e) { die(`arm ${JSON.stringify(arm)}: ${e.message}`); }
}

const label = (arm) => Object.entries(arm).map(([k, v]) => `${k}=${v}`).join(",");
const rows = [];
for (const arm of arms) {
  const name = label(arm).replace(/[^A-Za-z0-9=.,_-]/g, "_");
  const batch = join(repo, opts.out, `run-${name}`);
  rmSync(batch, { recursive: true, force: true });

  process.stderr.write(`\n=== ${label(arm)} ===\n`);
  const r = spawnSync(process.execPath, [
    join(here, "bench-larn.mjs"), "--set", opts.set, "--tuning", JSON.stringify(arm),
    "--out", batch, "--parallel", opts.parallel,
  ], { stdio: ["ignore", "inherit", "inherit"], cwd: repo });
  if (r.status !== 0) die(`arm ${label(arm)} exited ${r.status}`);
  const m = JSON.parse(readFileSync(join(batch, "bench.json"), "utf8")).metrics;
  rows.push({ arm: label(arm), ...m });
}

// The table, co-primaries first. Deliberately NOT sorted and NOT crowned: the
// bench is for iterating and the decision belongs to a held-out run a person
// starts on purpose.
console.log("\narm                                depth  xlvl   dmax  cmds   score  capped");
for (const r of rows) {
  console.log(
    `${r.arm.padEnd(34)}${String(r.dungeonDepthMedian).padStart(5)}`
    + `${String(r.xlevelMedian).padStart(6)}${String(r.dungeonDepthMax).padStart(7)}`
    + `${String(r.commandsMedian).padStart(7)}${String(r.scoreMedian).padStart(7)}`
    + `${String(r.outcomes.capped ?? 0).padStart(8)}`
    + (r.valid ? "" : "   INVALID"),
  );
}
const out = join(repo, opts.out, "sweep.json");
writeFileSync(out, JSON.stringify({ set: opts.set, at: new Date().toISOString(), rows }, null, 2) + "\n");
console.log(`\nartifact: ${out}`);
console.log("The bench decides nothing. Validate one arm against --set held-out, by hand, once.");
