// The Phase 2 bench metrics (bead vect-hack-h9x.1, spec
// docs/specs/2026-08-28-larn-bench-design.md).
//
// The load-bearing test is `distinguishes a shaft ride from a staircase
// descent`. AGENTS.md: a test that pins a CHOICE must be shown failing on the
// wrong choice — so that test asserts BOTH halves. It pins the new
// chain-separated median AND asserts that the old pooled `depth` column gives
// a different, wrong answer on the same fixture. Drop the chain split and the
// first assertion fails; make `depth` mean the new thing and the second one
// does. Either way the test cannot pass by accident, which is exactly what the
// old fixture-with-one-terrain mistake (vect-hack-b5f.6) taught.
import { describe, expect, it } from "vitest";
import { benchMetrics, chainDepths, median } from "../../src/modules/larn/bot/bench";
import type { Outcome, RunSummary } from "../../src/bot/scoreboard";

/** One finished game. `depth` is the OLD pooled column — the largest level
 *  number ever displayed, which is what the chain fields exist to replace. */
const run = (
  seed: number,
  outcome: Outcome,
  { dungeon, volcano }: { dungeon: number; volcano: number },
  extra: Partial<RunSummary> = {},
): RunSummary => ({
  game: "larn", id: `larn-${seed}`,
  startedAt: "2026-08-28T10:00:00.000Z", endedAt: "2026-08-28T10:01:00.000Z",
  outcome, seed, tuning: {},
  depth: Math.max(dungeon, volcano),
  xlevel: 2, hp: 0, hpmax: 12, commands: 500, score: 100,
  events: 100, cause: "killed by a gnome", lastMessages: [], stderr: [], error: "",
  details: { larn: { dungeonDepth: dungeon, volcanoDepth: volcano } },
  ...extra,
});

/** The population Larn actually produces: roughly half the seed bot's games
 *  ride the town's volcanic shaft to internal 11 and die in a couple of dozen
 *  commands, having never walked a dungeon level. The rest fight down the
 *  staircase chain. Five of each. */
const shaftRide = (seed: number) => run(seed, "died", { dungeon: 0, volcano: 11 }, { commands: 19 });
const descent = (seed: number, to: number) => run(seed, "died", { dungeon: to, volcano: 0 });
const BATCH: RunSummary[] = [
  shaftRide(1), shaftRide(2), shaftRide(3), shaftRide(4), shaftRide(5),
  descent(6, 1), descent(7, 2), descent(8, 2), descent(9, 3), descent(10, 5),
];

describe("larn bench metrics", () => {
  it("distinguishes a shaft ride from a staircase descent", () => {
    const m = benchMetrics(BATCH);

    // The new co-primary reads the dungeon chain alone. Five riders contribute
    // 0 and five descenders contribute 1,2,2,3,5, so the median of the ten is
    // 0.5 — and it is a claim about the route to the Eye.
    expect(m.dungeonDepthMedian).toBe(0.5);
    expect(m.dungeonDepthMax).toBe(5);
    // The volcano chain is reported beside it, never folded in.
    expect(m.volcanoDepthMax).toBe(11);
    expect(m.shaftRideRate).toBe(0.5);

    // ...and this is the half that fails if the split is removed. The old
    // pooled column reads the same batch as median 8 — a level no run in
    // either population reached, and the kind of number every report to date
    // quoted.
    const pooled = median(BATCH.map((r) => r.depth));
    expect(pooled).toBe(8);
    expect(pooled).not.toBe(m.dungeonDepthMedian);
  });

  it("refuses a batch played before the chain fields existed", () => {
    const old = run(1, "died", { dungeon: 3, volcano: 0 });
    delete old.details;
    // Reading a missing chain as 0 would report every pre-h9x.1 batch as
    // "never left the town", which is a plausible-looking lie.
    expect(chainDepths(old)).toBeNull();
    expect(() => benchMetrics([old])).toThrow(/played before/);
  });

  it("counts a capped run's depth but not its score", () => {
    const capped = run(11, "capped", { dungeon: 7, volcano: 0 }, { score: 0, commands: 3000 });
    const m = benchMetrics([...BATCH, capped]);
    // Depth is recorded live and survives a cap: this is what keeps the metric
    // able to see a change that stopped descending and ran out its budget.
    expect(m.dungeonDepthMax).toBe(7);
    expect(m.played).toBe(11);
    // Larn prints a score only on its end-of-game line, so the capped run's 0
    // is a hole. Ten scored runs, not eleven.
    expect(m.scored).toBe(10);
    expect(m.scoreMedian).toBe(100);
  });

  it("invalidates a batch with any harness fault", () => {
    const fatal = run(12, "fatal", { dungeon: 0, volcano: 0 });
    const m = benchMetrics([...BATCH, fatal]);
    expect(m.valid).toBe(false);
    expect(m.faults).toBe(1);
    // The fault is excluded from the metrics themselves — it is not a run that
    // reached depth 0, it is a run that did not happen.
    expect(m.played).toBe(10);
    expect(m.dungeonDepthMedian).toBe(0.5);
  });
});
