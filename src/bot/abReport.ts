// The paired A/B: two batches over one held-out seed list — control (`--kb
// none`) and treatment (`--kb data/kb`) — reduced to the numbers the
// pre-registered contract decides on (spec
// docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md, "The
// measurement contract"). Pure and game-free: scripts/dev/kb-ab-report.mjs
// does every read and write, because the browser bot shares this directory.
//
// Three rules of that contract are load-bearing here, and each is the kind of
// thing that is easy to get subtly, invisibly wrong.
//
// **Strata come from the control arm.** Each seed is labelled `volcano` or
// `surface` by what the CONTROL run did on it — the town's volcanic shaft
// drops a level-1 character to depth 11, where it dies almost immediately, and
// roughly half the seed bot's games take it. The thing this phase is most
// likely to teach is "stop taking the shaft", which moves seeds out of that
// population. Labelling by the treatment run's own depth would be conditioning
// on an outcome the treatment caused, and would manufacture differences out of
// nothing. The control arm is the pre-treatment behaviour by construction, so
// it is the honest label source: a seed the control took to depth 11 stays
// `volcano` whatever the treatment did with it. The crossings are reported
// separately as migratedToSurface/migratedToVolcano — findings, not metrics.
//
// **A run the harness cut short is missing data, not a zero.** Larn prints a
// score only on its end-of-game line, so a capped/timed-out/fatal run has no
// score and the 0 in its summary is a hole. A pair cut short in EITHER arm
// leaves the score statistic entirely and is counted in `excluded`, so a
// change that capped more games cannot read as a score regression. Depth is
// recorded live and survives a cap, so those pairs stay in the depth statistic
// — which is what keeps the guard able to see a treatment that stopped
// descending and ran out its budget instead.
//
// **`ship` is the decision rule and nothing else**: pooled median per-seed
// score delta positive, wins over losses, and the guard. No composite metric,
// no significance machinery.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import { type RunSummary } from "./scoreboard.ts";

/** The town's volcanic shaft lands a level-1 character here. Nothing else in
 *  the seed bot's ladder reaches it, so depth splits the two populations
 *  cleanly (docs/reports/2026-08-18-larn-baseline.md). */
export const SHAFT_DEPTH = 11;

export type Stratum = "volcano" | "surface";

/** The game ended and Larn printed a score line. Everything else — capped,
 *  timeout, fatal, and the `running` progress snapshot a killed child leaves
 *  behind — is a harness result with no score to read. */
const GAME_OUTCOMES = new Set(["died", "won"]);

export interface SeedPair { seed: number; control: RunSummary; treatment: RunSummary }

export interface StratumReport {
  /** Pairs in this stratum. The score counts below cover only the scored
   *  ones, so `wins + losses + ties` is the score denominator and this is the
   *  depth denominator; they differ by the excluded pairs. */
  seeds: number;
  /** 0 with no scored pairs, which is "no data" rather than "no difference" —
   *  formatAbReport prints it as such. */
  scoreDeltaMedian: number;
  depthDeltaMedian: number;
  wins: number; losses: number; ties: number;
}

export interface AbReport {
  pairs: number; excluded: number;
  strata: Record<Stratum, StratumReport>;
  pooled: { scoreDeltaMedian: number; wins: number; losses: number; ties: number };
  /** The control-`surface` median depth delta is at least zero, measured over
   *  at least one seed. A bot that survives longer by never descending has not
   *  improved. The seed count is part of the test because median([]) is 0: an
   *  empty stratum would otherwise satisfy the guard without measuring
   *  anything, and an assertion that cannot fail is worse than none. */
  guardHolds: boolean;
  migratedToSurface: number; migratedToVolcano: number;
  ship: boolean;
}

/** The plain median of scoreboard.ts, not the interpolated R-7 quantile the
 *  1a baseline report uses: this one is applied to per-seed deltas, where the
 *  midpoint of the two middle seeds is the number the contract names. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const isGameResult = (r: RunSummary): boolean => GAME_OUTCOMES.has(r.outcome);
/** Both arms reached an end-of-game score line, so the delta means something. */
export const isScored = (p: SeedPair): boolean => isGameResult(p.control) && isGameResult(p.treatment);
export const stratumOf = (p: SeedPair): Stratum => (p.control.depth >= SHAFT_DEPTH ? "volcano" : "surface");
export const scoreDelta = (p: SeedPair): number => p.treatment.score - p.control.score;
export const depthDelta = (p: SeedPair): number => p.treatment.depth - p.control.depth;

/** The seeds both batches played, in control order, with the count of pairs
 *  that lost their score to the harness in one arm or both. A seed only one
 *  batch played is not a pair at all and is dropped silently here — the host
 *  script reports it, because "the two batches were not the same seed list" is
 *  a fact about the batches, not about the bot. A seed a batch played twice
 *  keeps its first run. */
export function pairBatches(control: RunSummary[], treatment: RunSummary[]): { pairs: SeedPair[]; excluded: number } {
  const bySeed = new Map<number, RunSummary>();
  for (const r of treatment) if (!bySeed.has(r.seed)) bySeed.set(r.seed, r);
  const pairs: SeedPair[] = [];
  const seen = new Set<number>();
  let excluded = 0;
  for (const c of control) {
    const t = bySeed.get(c.seed);
    if (t === undefined || seen.has(c.seed)) continue;
    seen.add(c.seed);
    const pair: SeedPair = { seed: c.seed, control: c, treatment: t };
    pairs.push(pair);
    if (!isScored(pair)) excluded++;
  }
  return { pairs, excluded };
}

function stratumReport(pairs: SeedPair[]): StratumReport {
  const scored = pairs.filter(isScored).map(scoreDelta);
  return {
    seeds: pairs.length,
    scoreDeltaMedian: median(scored),
    depthDeltaMedian: median(pairs.map(depthDelta)),
    wins: scored.filter((d) => d > 0).length,
    losses: scored.filter((d) => d < 0).length,
    ties: scored.filter((d) => d === 0).length,
  };
}

export function abReport(pairs: SeedPair[], excluded: number): AbReport {
  const strata: Record<Stratum, StratumReport> = {
    volcano: stratumReport(pairs.filter((p) => stratumOf(p) === "volcano")),
    surface: stratumReport(pairs.filter((p) => stratumOf(p) === "surface")),
  };
  const all = stratumReport(pairs);
  const pooled = { scoreDeltaMedian: all.scoreDeltaMedian, wins: all.wins, losses: all.losses, ties: all.ties };
  const guardHolds = strata.surface.seeds > 0 && strata.surface.depthDeltaMedian >= 0;
  return {
    pairs: pairs.length, excluded, strata, pooled, guardHolds,
    migratedToSurface: pairs.filter((p) => p.control.depth >= SHAFT_DEPTH && p.treatment.depth < SHAFT_DEPTH).length,
    migratedToVolcano: pairs.filter((p) => p.control.depth < SHAFT_DEPTH && p.treatment.depth >= SHAFT_DEPTH).length,
    ship: pooled.scoreDeltaMedian > 0 && pooled.wins > pooled.losses && guardHolds,
  };
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
const table = (head: string[], rows: (string | number)[][]): string =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

export function formatAbReport(r: AbReport): string {
  const scored = (s: { wins: number; losses: number; ties: number }) => s.wins + s.losses + s.ties;
  /** A stratum nothing scored has no delta to report; 0 there would read as
   *  "the arms tied", which is a claim the data cannot make. */
  const scoreCell = (s: AbReport["pooled"]) => (scored(s) === 0 ? "no data" : signed(s.scoreDeltaMedian));
  /** Same rule for depth: a stratum with no pairs in it has no median, and a
   *  printed 0 would read as a measurement rather than an empty column. */
  const depthCell = (s: StratumReport) => (s.seeds === 0 ? "no data" : signed(s.depthDeltaMedian));
  const row = (name: string, s: StratumReport) =>
    [name, s.seeds, scored(s), scoreCell(s), s.wins, s.losses, s.ties, depthCell(s)];

  const md: string[] = [];
  md.push(`## Decision: ${r.ship ? "SHIP" : "NO-SHIP"}`);
  md.push("");
  md.push("The rule was pre-registered before any batch ran: the knowledge base ships when the pooled median per-seed score delta is positive, the win count exceeds the loss count, and the guard holds. Nothing else enters the decision.");
  md.push("");
  md.push(table(["test", "required", "measured", "verdict"], [
    ["pooled median score delta", "> 0", scoreCell(r.pooled), r.pooled.scoreDeltaMedian > 0 ? "pass" : "fail"],
    ["wins vs losses", "wins > losses", `${r.pooled.wins} vs ${r.pooled.losses}`, r.pooled.wins > r.pooled.losses ? "pass" : "fail"],
    ["guard: control-surface median depth delta", "≥ 0 over ≥ 1 seed", depthCell(r.strata.surface), r.guardHolds ? "pass" : "fail"],
  ]));
  md.push("");
  md.push(`**${r.pairs} pairs, ${r.excluded} excluded.** A pair is one seed played in both arms. Larn prints a score only on its end-of-game line, so a pair the harness cut short in either arm (capped, timeout, fatal) has no score to compare and leaves the score statistic: a change that capped more games cannot read here as a score regression. Depth is recorded live and survives a cap, so those pairs stay in the depth column and in the guard.`);
  md.push("");
  md.push("## The paired numbers");
  md.push("");
  md.push(table(["stratum", "seeds", "scored", "median score Δ", "wins", "losses", "ties", "median depth Δ"], [
    row("volcano", r.strata.volcano),
    row("surface", r.strata.surface),
    ["**pooled**", r.pairs, scored(r.pooled), scoreCell(r.pooled), r.pooled.wins, r.pooled.losses, r.pooled.ties, "—"],
  ]));
  md.push("");
  md.push(`Every delta is treatment minus control on the same seed. **Strata are frozen from the control arm**: a seed is \`volcano\` when the control run reached depth ${SHAFT_DEPTH} or deeper — the town's volcanic shaft — and \`surface\` otherwise. The label never comes from the treatment run's own depth: the treatment is expected to change how often that shaft is taken, so labelling by it would be conditioning on an outcome the treatment caused.`);
  md.push("");
  md.push(r.strata.surface.seeds === 0
    ? `**Guard — fails: the control-\`surface\` stratum is empty.** No seed's control run stayed above depth ${SHAFT_DEPTH}, so there is no median per-seed depth delta to read and the guard has measured nothing. It fails rather than passing on an empty stratum: an assertion that cannot fail is worse than no assertion, and a batch shaped like this needs seeds, not a verdict.`
    : `**Guard — ${r.guardHolds ? "holds" : "fails"}.** The median per-seed depth delta in the control-\`surface\` stratum is ${signed(r.strata.surface.depthDeltaMedian)} over ${r.strata.surface.seeds} seed(s), and the contract requires at least 0. A bot that survives longer by never descending has not improved, and this is the assertion that says so.`);
  md.push("");
  md.push(`**Migration — a finding, not a metric.** ${r.migratedToSurface} control-\`volcano\` seed(s) ended shallower than depth ${SHAFT_DEPTH} under the treatment, and ${r.migratedToVolcano} control-\`surface\` seed(s) ended at depth ${SHAFT_DEPTH} or deeper. Both stay in the stratum their control run gave them; these counts describe how the treatment moved play, and no number above is conditioned on them.`);
  md.push("");
  return md.join("\n");
}
