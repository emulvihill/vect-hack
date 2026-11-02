// The instrument that decides whether Phase 1b worked: two batches over one
// held-out seed list, paired seed by seed, read under the pre-registered
// contract (spec 2026-08-19-bot-phase1b-larn-reflect-design.md, "The
// measurement contract").
//
// Three rules of that contract are what these tests exist to hold:
//   1. A seed's stratum comes from the CONTROL run's depth and never from the
//      treatment's. The treatment is expected to stop taking the volcanic
//      shaft, so labelling by treatment depth would condition on an outcome
//      the treatment caused.
//   2. Larn prints a score only on its end-of-game line, so a run the harness
//      cut short has no score: a pair capped/timed out/fatal in EITHER arm
//      leaves the score statistic entirely. A change that capped more games
//      must not be able to read as a score regression.
//   3. `ship` is the decision rule and nothing else — pooled median score
//      delta positive, wins over losses, and the guard.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { abReport, formatAbReport, pairBatches, type SeedPair } from "../../src/bot/abReport";
import type { Outcome, RunSummary } from "../../src/bot/scoreboard";

const run = (seed: number, outcome: Outcome, depth: number, score: number): RunSummary => ({
  game: "larn", id: `larn-${seed}-${outcome}`,
  startedAt: "2026-08-19T10:00:00.000Z", endedAt: "2026-08-19T10:01:00.000Z",
  outcome, seed, kb: "", depth, xlevel: 1, hp: 0, hpmax: 12, commands: 500, score,
  events: 100, cause: "killed by a gnome", lastMessages: [], stderr: [], error: "",
});

// The fixture both arms share. Control depths freeze the strata: seeds 1-3 are
// volcano (>= 11), seeds 4-6 surface. Seed 2's treatment run stays shallow —
// it is a migration, and it stays in the volcano stratum.
const CONTROL = [
  run(1, "died", 11, 100), run(2, "died", 11, 200), run(3, "died", 11, 50),
  run(4, "died", 3, 300), run(5, "died", 2, 100), run(6, "died", 4, 400),
];
const TREATMENT = [
  run(1, "died", 11, 150), run(2, "died", 2, 180), run(3, "died", 11, 90),
  run(4, "died", 4, 300), run(5, "died", 2, 130), run(6, "died", 5, 200),
];
const paired = (control = CONTROL, treatment = TREATMENT) => {
  const { pairs, excluded } = pairBatches(control, treatment);
  return abReport(pairs, excluded);
};

describe("pairing two batches", () => {
  it("keeps only the seeds both batches played, in control order", () => {
    const control = [run(1, "died", 2, 10), run(2, "died", 2, 10), run(3, "died", 2, 10)];
    const treatment = [run(3, "died", 2, 10), run(2, "died", 2, 10), run(9, "died", 2, 10)];
    const { pairs } = pairBatches(control, treatment);
    expect(pairs.map((p: SeedPair) => p.seed)).toEqual([2, 3]);
    expect(pairs[0]!.control.id).toBe("larn-2-died");
    expect(pairs[0]!.treatment.id).toBe("larn-2-died");
  });

  it("counts a pair cut short in either arm as excluded", () => {
    const control = [run(1, "died", 2, 10), run(2, "capped", 2, 0), run(3, "died", 2, 10), run(4, "won", 2, 10)];
    const treatment = [run(1, "timeout", 2, 0), run(2, "died", 2, 10), run(3, "fatal", 2, 0), run(4, "died", 2, 10)];
    const { pairs, excluded } = pairBatches(control, treatment);
    expect(pairs.length).toBe(4);
    expect(excluded).toBe(3);
  });

  it("counts a running snapshot as cut short too — it has no end-of-game score", () => {
    const { excluded } = pairBatches([run(1, "running", 2, 0)], [run(1, "died", 2, 10)]);
    expect(excluded).toBe(1);
  });
});

describe("strata are frozen from the control arm", () => {
  const r = paired();

  it("labels each seed by the control run's depth, never the treatment's", () => {
    expect(r.strata.volcano.seeds).toBe(3);
    expect(r.strata.surface.seeds).toBe(3);
  });

  it("keeps a seed whose treatment run stayed shallow in the volcano stratum", () => {
    const shallower = TREATMENT.map((t) => (t.seed === 2 ? t : run(t.seed, t.outcome, 1, t.score)));
    const moved = paired(CONTROL, shallower);
    expect(moved.strata.volcano.seeds).toBe(3);
    expect(moved.strata.surface.seeds).toBe(3);
  });

  it("reports the crossings separately, as findings rather than metrics", () => {
    expect(r.migratedToSurface).toBe(1);
    expect(r.migratedToVolcano).toBe(0);
    const other = paired(CONTROL, TREATMENT.map((t) => (t.seed === 5 ? run(5, "died", 12, 130) : t)));
    expect(other.migratedToSurface).toBe(1);
    expect(other.migratedToVolcano).toBe(1);
  });
});

describe("the paired medians and the win/loss/tie counts", () => {
  const r = paired();

  it("computes them per stratum", () => {
    // volcano score deltas +50, -20, +40; depth deltas 0, -9, 0
    expect(r.strata.volcano).toEqual({ seeds: 3, scoreDeltaMedian: 40, depthDeltaMedian: 0, wins: 2, losses: 1, ties: 0 });
    // surface score deltas 0, +30, -200; depth deltas +1, 0, +1
    expect(r.strata.surface).toEqual({ seeds: 3, scoreDeltaMedian: 0, depthDeltaMedian: 1, wins: 1, losses: 1, ties: 1 });
  });

  it("computes them pooled over every stratum", () => {
    // sorted: -200, -20, 0, +30, +40, +50 -> median 15
    expect(r.pooled).toEqual({ scoreDeltaMedian: 15, wins: 3, losses: 2, ties: 1 });
    expect(r.pairs).toBe(6);
    expect(r.excluded).toBe(0);
  });
});

describe("a run the harness cut short is missing data, not a zero", () => {
  // Seed 7's control run was capped, so Larn never printed its score. The
  // treatment run scored 500 on it; counting that as a +500 win would be the
  // command cap talking, not the bot.
  const control = [...CONTROL, run(7, "capped", 5, 0)];
  const treatment = [...TREATMENT, run(7, "died", 6, 500)];
  const r = paired(control, treatment);

  it("leaves the pair out of the score statistic and reports the count", () => {
    expect(r.pairs).toBe(7);
    expect(r.excluded).toBe(1);
    expect(r.pooled).toEqual({ scoreDeltaMedian: 15, wins: 3, losses: 2, ties: 1 });
    expect(r.strata.surface.wins + r.strata.surface.losses + r.strata.surface.ties).toBe(3);
  });

  it("still counts its depth: the guard reads a number every run has", () => {
    expect(r.strata.surface.seeds).toBe(4);
    // depth deltas +1, 0, +1 and the capped pair's +1
    expect(r.strata.surface.depthDeltaMedian).toBe(1);
  });
});

describe("the guard against surviving by never descending", () => {
  it("holds when the control-surface median depth delta is at least zero", () => {
    expect(paired().guardHolds).toBe(true);
  });

  it("fails when the treatment stopped descending on the surface seeds", () => {
    const shallow = TREATMENT.map((t) => (t.seed >= 4 ? run(t.seed, t.outcome, 1, t.score) : t));
    const r = paired(CONTROL, shallow);
    expect(r.strata.surface.depthDeltaMedian).toBeLessThan(0);
    expect(r.guardHolds).toBe(false);
    expect(r.ship).toBe(false);
  });

  // median([]) is 0, so a guard reading the median alone passes on a stratum
  // holding nothing — the one shape where it certifies a result it never
  // measured, and the shape it would take if every control run took the shaft.
  it("cannot be satisfied by an empty control-surface stratum", () => {
    const r = paired([run(1, "died", 11, 100)], [run(1, "died", 11, 150)]);
    expect(r.strata.surface.seeds).toBe(0);
    expect(r.strata.surface.depthDeltaMedian).toBe(0);
    // Everything else the rule asks for is satisfied, so the guard is the only
    // thing standing between this batch and a SHIP it did not earn.
    expect([r.pooled.scoreDeltaMedian > 0, r.pooled.wins > r.pooled.losses]).toEqual([true, true]);
    expect(r.guardHolds).toBe(false);
    expect(r.ship).toBe(false);
  });

  it("says so in the report rather than printing a zero that reads as a pass", () => {
    const md = formatAbReport(paired([run(1, "died", 11, 100)], [run(1, "died", 11, 150)]));
    expect(md).toContain("Decision: NO-SHIP");
    expect(md).toContain("the control-`surface` stratum is empty");
    expect(md).toContain("no data");
  });

  it("reads the control-surface stratum only — a volcano collapse cannot fail it", () => {
    const noShaft = TREATMENT.map((t) => (t.seed <= 3 ? run(t.seed, t.outcome, 1, t.score) : t));
    const r = paired(CONTROL, noShaft);
    expect(r.strata.volcano.depthDeltaMedian).toBeLessThan(0);
    expect(r.guardHolds).toBe(true);
  });
});

describe("the decision rule", () => {
  it("ships on a positive pooled median, more wins than losses, and the guard", () => {
    const r = paired();
    expect([r.pooled.scoreDeltaMedian > 0, r.pooled.wins > r.pooled.losses, r.guardHolds]).toEqual([true, true, true]);
    expect(r.ship).toBe(true);
  });

  it("does not ship on a pooled median of zero", () => {
    // Flatten the two volcano wins to ties: deltas -200, -20, 0, 0, 0, +30
    // -> median 0. Zero is not positive, so the rule refuses.
    const flat = TREATMENT.map((t) => (t.seed === 1 ? run(1, "died", 11, 100) : t.seed === 3 ? run(3, "died", 11, 50) : t));
    const r = paired(CONTROL, flat);
    expect(r.pooled.scoreDeltaMedian).toBe(0);
    expect(r.ship).toBe(false);
  });

  it("does not ship when losses match or beat wins, however good the median", () => {
    // Three small wins, two small losses and one rout: deltas -1900, -1, -1,
    // +2, +3, +4. The median is positive and the count is a tie, so the rule
    // refuses — a median alone cannot see a loss that big.
    const control = [
      run(1, "died", 11, 100), run(2, "died", 11, 100), run(3, "died", 11, 100),
      run(4, "died", 3, 100), run(5, "died", 3, 100), run(6, "died", 3, 2000),
    ];
    const treatment = [
      run(1, "died", 11, 102), run(2, "died", 11, 103), run(3, "died", 11, 104),
      run(4, "died", 3, 99), run(5, "died", 3, 99), run(6, "died", 3, 100),
    ];
    const r = paired(control, treatment);
    expect(r.pooled.scoreDeltaMedian).toBeGreaterThan(0);
    expect(r.pooled.wins).toBeLessThanOrEqual(r.pooled.losses);
    expect(r.ship).toBe(false);
  });

  it("is those three tests and nothing else", () => {
    const r = paired();
    expect(r.ship).toBe(r.pooled.scoreDeltaMedian > 0 && r.pooled.wins > r.pooled.losses && r.guardHolds);
  });
});

describe("the markdown body", () => {
  it("states the decision, the excluded count and the frozen strata", () => {
    const md = formatAbReport(paired());
    expect(md).toContain("Decision: SHIP");
    expect(md).not.toContain("NO-SHIP");
    expect(md).toContain("0 excluded");
    expect(md).toContain("control");
    expect(md).toContain("guard");
  });

  it("says NO-SHIP when the rule says so, and still reports every number", () => {
    const shallow = TREATMENT.map((t) => (t.seed >= 4 ? run(t.seed, t.outcome, 1, t.score) : t));
    const control = [...CONTROL, run(7, "capped", 5, 0)];
    const md = formatAbReport(paired(control, [...shallow, run(7, "died", 6, 500)]));
    expect(md).toContain("Decision: NO-SHIP");
    expect(md).toContain("1 excluded");
    expect(md).toContain("volcano");
    expect(md).toContain("surface");
  });

  it("marks a stratum with no scored pairs as having no data, not a zero delta", () => {
    const md = formatAbReport(paired([run(1, "capped", 2, 0)], [run(1, "capped", 2, 0)]));
    expect(md).toContain("no data");
  });
});

// kb-ab-report.mjs loads abReport.ts straight from source under node's own
// type stripping, exactly as the reflect host loads the digest builder, so the
// same no-bundler rules bind it (scripts/test/bot-node-import.test.ts).
describe("the report host's chain loads under plain node", () => {
  it("imports abReport.ts", () => {
    const url = new URL("../../src/bot/abReport.ts", import.meta.url).href;
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); console.log(typeof m.abReport);`],
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe("function");
  });
});
