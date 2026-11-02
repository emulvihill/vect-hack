// The paired per-seed diagnostic the bench spec requires beside every Phase 2
// co-primary (docs/specs/2026-08-28-larn-bench-design.md, the
// same-day amendment).
//
// WHY IT EXISTS. The bench's co-primary is a median of a small integer —
// dungeon depth runs 0..6 — and over 500 games that is a coarse reading: a
// change can help a hundred seeds by a level each and leave the median exactly
// where it was. Both verbs measured on 2026-08-28 did precisely that, with two
// THIRDS of their comparisons landing on exact ties. "The median did not move"
// was being written as "no effect", and those are different claims.
//
// WHAT IT IS NOT. It is not the ship rule and must never become one. A
// statistically detectable gain of 0.08 dungeon levels is not progress toward
// the Eye, and goal-alignment is the whole reason the medians are primary. This
// says whether an instrument could have SEEN the thing it reported.
//
//   node scripts/dev/bench-pair.mjs --control .gym/x-control --treatment .gym/x-treatment
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chainDepths } from "../../src/modules/larn/bot/bench.ts";

const { values: opts } = parseArgs({
  options: { control: { type: "string" }, treatment: { type: "string" } },
});
const die = (m) => { console.error(m); process.exit(2); };
if (!opts.control || !opts.treatment) {
  die("usage: bench-pair.mjs --control <batch dir> --treatment <batch dir>");
}

/** Summaries by the seed they were played on. A batch is a set of games over a
 *  seed list, so the seed is what pairs them; the run id never can. */
function bySeed(batch) {
  const out = new Map();
  if (!existsSync(batch)) die(`no batch at ${batch}`);
  for (const d of readdirSync(batch)) {
    const f = join(batch, d, "summary.json");
    if (!existsSync(f)) continue;
    const s = JSON.parse(readFileSync(f, "utf8"));
    if (s.outcome !== "running") out.set(s.seed, s);
  }
  return out;
}

/** Two-sided sign test over the untied pairs, normal approximation. Under "no
 *  effect", `up` is Binomial(up + down, 0.5). Ties carry no information about
 *  direction and are excluded, which is the whole point of the instrument. */
function signTest(up, down) {
  const k = up + down;
  if (k === 0) return 1;
  const z = (up - k / 2) / Math.sqrt(k * 0.25);
  return 2 * (1 - normalCdf(Math.abs(z)));
}
function normalCdf(x) {
  // Abramowitz & Stegun 7.1.26 for erf; plenty for a diagnostic.
  const t = 1 / (1 + 0.3275911 * (x / Math.SQRT2));
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-((x / Math.SQRT2) ** 2));
  return 0.5 * (1 + erf);
}

const control = bySeed(opts.control);
const treatment = bySeed(opts.treatment);

const METRICS = [
  ["dungeon depth", (s) => chainDepths(s)?.dungeon ?? null],
  ["xlevel", (s) => s.xlevel],
  ["commands", (s) => s.commands],
];

console.log(`control   ${opts.control} (${control.size} games)`);
console.log(`treatment ${opts.treatment} (${treatment.size} games)`);
console.log("\nmetric          n    up  down  tied   mean delta   sign test");
for (const [name, get] of METRICS) {
  let up = 0, down = 0, tied = 0, sum = 0, n = 0;
  for (const [seed, c] of control) {
    const t = treatment.get(seed);
    if (!t) continue;
    const a = get(c), b = get(t);
    if (a === null || b === null) continue;
    n++; sum += b - a;
    if (b > a) up++; else if (b < a) down++; else tied++;
  }
  const p = signTest(up, down);
  console.log(
    `${name.padEnd(14)}${String(n).padStart(4)}${String(up).padStart(6)}`
    + `${String(down).padStart(6)}${String(tied).padStart(6)}`
    + `${(sum / (n || 1)).toFixed(3).padStart(13)}`
    + `${(p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`).padStart(12)}`,
  );
}
console.log("\nThis is a sensitivity check, not a ship rule. The bench's co-primaries decide.");
