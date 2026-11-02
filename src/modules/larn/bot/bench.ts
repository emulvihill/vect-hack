// The Larn bench metrics: a batch of RunSummary in, the numbers
// docs/specs/2026-08-28-larn-bench-design.md pre-registered out.
// Pure and filesystem-free — scripts/dev/bench-larn.mjs does every read and
// write, the same split kb-ab-report.mjs uses, because this directory is also
// loaded by the browser bot.
//
// The one idea worth stating twice: DEPTH IS TWO NUMBERS, not one. Larn's town
// holds a volcanic shaft that drops a level-1 character straight to internal 11
// (create.c:396-410), bypassing the dungeon chain the Eye sits at the bottom
// of. `RunSummary.depth` is the largest level number ever displayed, so a
// shaft rider who dies on command 19 posts 11 and a hero who fought down five
// staircases posts 5. Every batch median quoted before this file — including
// the 1000-game `.gym/bughunt-01` median of 5 — pooled those two populations
// and described neither. The model records the chains apart
// (LarnBotModel.maxDungeonDepth / maxVolcanoDepth) and publishes them in
// `details.larn`; this file reads those and never `depth`.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import type { RunSummary } from "../../../bot/scoreboard.ts";
import { VOLCANO_FIRST } from "./model.ts";

/** Outcomes that are the GAME's answer. `capped` is the bot running out of
 *  budget with a live character — its depth and xlevel are real and stay in
 *  every metric; only its score is missing (Larn prints one at end of game). */
const PLAYED: ReadonlySet<string> = new Set(["died", "won", "capped"]);
/** Outcomes that mean the harness broke, not the bot. Any of these invalidates
 *  the whole bench run: it is a bug report, not a measurement. */
const HARNESS_FAULTS: ReadonlySet<string> = new Set(["fatal", "timeout"]);

export interface BenchMetrics {
  games: number;
  /** Rows the metrics were computed over: PLAYED outcomes only. */
  played: number;
  outcomes: Record<string, number>;
  /** True when no run in the batch was a harness fault. A false here means
   *  every number below is describing a broken run and must not be quoted. */
  valid: boolean;
  faults: number;
  // Co-primary.
  dungeonDepthMedian: number;
  xlevelMedian: number;
  // Reported, never primary.
  dungeonDepthMax: number;
  volcanoDepthMedian: number;
  volcanoDepthMax: number;
  shaftRideRate: number;
  commandsMedian: number;
  /** Median over runs that HAVE a score. A capped run's 0 is a hole, not a
   *  zero, and averaging it in would let a change that capped more games read
   *  as a score regression (the same rule abReport.ts states for pairs). */
  scoreMedian: number;
  scored: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The Larn detail block a summary carries, or nulls when it has none. A
 *  summary written before vect-hack-h9x.1 has no chain fields at all; reading
 *  a missing one as 0 would silently report every old batch as "never left the
 *  town", so it is `null` and the caller is told the batch is unreadable. */
export function chainDepths(s: RunSummary): { dungeon: number; volcano: number } | null {
  const d = (s.details as { larn?: Record<string, unknown> } | undefined)?.larn;
  if (!d || typeof d.dungeonDepth !== "number" || typeof d.volcanoDepth !== "number") return null;
  return { dungeon: d.dungeonDepth, volcano: d.volcanoDepth };
}

export function benchMetrics(rows: RunSummary[]): BenchMetrics {
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const faults = rows.filter((r) => HARNESS_FAULTS.has(r.outcome)).length;
  const played = rows.filter((r) => PLAYED.has(r.outcome));

  const chains = played.map((r) => chainDepths(r));
  if (chains.some((c) => c === null)) {
    throw new Error(
      "batch has summaries with no details.larn.dungeonDepth: it was played before " +
      "vect-hack-h9x.1 and its depths cannot be split by chain. Re-run it.",
    );
  }
  const dungeon = chains.map((c) => c!.dungeon);
  const volcano = chains.map((c) => c!.volcano);
  const scored = played.filter((r) => r.outcome !== "capped");

  return {
    games: rows.length,
    played: played.length,
    outcomes,
    valid: faults === 0,
    faults,
    dungeonDepthMedian: median(dungeon),
    xlevelMedian: median(played.map((r) => r.xlevel)),
    dungeonDepthMax: dungeon.reduce((m, d) => Math.max(m, d), 0),
    volcanoDepthMedian: median(volcano),
    volcanoDepthMax: volcano.reduce((m, d) => Math.max(m, d), 0),
    shaftRideRate: played.length ? volcano.filter((d) => d >= VOLCANO_FIRST).length / played.length : 0,
    commandsMedian: median(played.map((r) => r.commands)),
    scoreMedian: median(scored.map((r) => r.score)),
    scored: scored.length,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatBench(m: BenchMetrics): string {
  const hist = Object.entries(m.outcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  return [
    `games ${m.games} (${m.played} played) — ${hist}`,
    m.valid ? "" : `  INVALID: ${m.faults} harness fault(s) — this is a bug report, not a measurement`,
    `  CO-PRIMARY  dungeon depth median ${m.dungeonDepthMedian}   xlevel median ${m.xlevelMedian}`,
    `  reported    dungeon max ${m.dungeonDepthMax} · volcano median ${m.volcanoDepthMedian} max ${m.volcanoDepthMax}`,
    `              shaft rides ${pct(m.shaftRideRate)} · commands median ${m.commandsMedian}`,
    `              score median ${m.scoreMedian} (over ${m.scored} scored runs)`,
  ].filter(Boolean).join("\n");
}
