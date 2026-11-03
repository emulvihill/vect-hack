// How long a run lasted after it rode the town's volcanic shaft — the interim
// curriculum goal: can the learning loop get a character PAST the first stage
// rather than merely change its score?
//
// Why this metric and not depth or score. Roughly half the seed bot's games
// take the shaft from the town straight to depth 11 at experience level 1, and
// die there in tens of commands. Depth cannot see the difference (every one of
// them reaches 11) and score barely can (they all score almost nothing), so the
// A/B's volcano stratum ties 52 times in 54 and reports a bot that learned
// nothing and a bot that learned something as the same
// (docs/reports/2026-08-22-larn-r3.md). Survival after the drop
// separates them: it is the number that moves when the hero starts handling
// what is down there — or when it stops going down at the wrong size.
//
// Two populations, and the report keeps them apart, because a treatment can
// improve either one and they mean different things:
//   - `rode` — runs that took the shaft. Their survival is the goal.
//   - `declined` — runs that never did. A treatment that moves runs out of the
//     first group and into this one has also progressed, and the two batches'
//     `declined` counts are where that shows.
//
// Reads only.
//
//   node scripts/dev/larn-shaft-survival.mjs --batch DIR [--batch DIR ...]
//
// ".ts" import specifiers: node loads src/bot straight from source.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readTrajectoryLines } from "./trajectory-read.mjs";
import { buildLarnDigest } from "../../src/modules/larn/bot/digest.ts";

/** The town's volcanic shaft, as the screen draws it. */
const SHAFT = { category: "stairs", ch: "V" };

const batches = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--batch") batches.push(args[++i]);
}
if (batches.length === 0) {
  console.error("usage: larn-shaft-survival.mjs --batch DIR [--batch DIR ...]");
  process.exit(2);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The median, reported rather than the mean: one run that survived unusually
 *  long must not read as the batch improving. */
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(xs, q) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

for (const dir of batches) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "summary.json")))
    .map((e) => e.name).sort();

  const survived = [];       // commands after the shaft, for runs that rode it
  const capacities = [];     // hpmax the shaft was taken with
  let rode = 0, declined = 0, capped = 0;
  for (const name of names) {
    const runDir = join(dir, name);
    const summary = readJson(join(runDir, "summary.json"));
    const d = buildLarnDigest(await readTrajectoryLines(join(runDir, "trajectory.jsonl.gz")), summary);
    const drop = d.descents.find((s) => s.category === SHAFT.category && s.ch === SHAFT.ch);
    if (drop === undefined) { declined++; continue; }
    rode++;
    if (summary.outcome !== "died" && summary.outcome !== "won") capped++;
    // Commands, not mobuls: the trajectory counts them directly and a run cut
    // short by the harness still has an honest count up to the cut.
    survived.push(Math.max(0, summary.commands - drop.atCommand));
    capacities.push(drop.hpmax);
  }

  console.log(`${dir}  (${names.length} runs)`);
  console.log(`  rode the shaft      ${rode}`);
  console.log(`  declined it         ${declined}`);
  console.log(`  of the riders, cut short by the harness ${capped}`);
  console.log(`  commands survived after the drop:`);
  console.log(`    median ${median(survived)}  p75 ${quantile(survived, 0.75)}  p90 ${quantile(survived, 0.9)}  max ${survived.length ? Math.max(...survived) : null}`);
  for (const bar of [25, 50, 100, 250, 500]) {
    const n = survived.filter((v) => v >= bar).length;
    console.log(`    lasted >= ${String(bar).padStart(4)} commands: ${n} of ${rode}`);
  }
  console.log(`  capacity the shaft was taken with: median hpmax ${median(capacities)}, max ${capacities.length ? Math.max(...capacities) : null}`);
}
