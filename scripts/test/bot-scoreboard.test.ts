// What a headless run leaves behind: the summary shape, the shared CSV
// columns every engine's rows share, and the batch stats line.
import { describe, expect, it } from "vitest";
import {
  SCOREBOARD_COLUMNS, SCOREBOARD_HEADER, buildRunSummary, childSeed, csvField, emptySummary,
  formatSummary, scoreboardRow, summarizeScoreboard, type RunSummary,
} from "../../src/bot/scoreboard";

const meta = { game: "larn", id: "r1", startedAt: "2026-08-17T10:00:00.000Z", endedAt: "2026-08-17T10:01:00.000Z", outcome: "died" as const, seed: 4242 };

describe("run summaries", () => {
  it("emptySummary carries the meta and zeros", () => {
    expect(emptySummary({ ...meta, outcome: "timeout" })).toEqual({
      game: "larn", id: "r1", startedAt: meta.startedAt, endedAt: meta.endedAt, outcome: "timeout", seed: 4242,
      kb: "",
      depth: 0, xlevel: 0, hp: 0, hpmax: 0, commands: 0, score: 0, events: 0, cause: "",
      lastMessages: [], details: {}, stderr: [], error: "",
    });
  });
  it("buildRunSummary merges the snapshot, the log's event count and the meta", () => {
    const s = buildRunSummary(
      { ...meta, stderr: ["x"] },
      { depth: 4, xlevel: 5, hp: 0, hpmax: 31, commands: 812, score: 1043, cause: "killed by a gnome",
        lastMessages: ["You die"], details: { larn: { gold: 250 } } },
      { events: 9001 },
    );
    expect(s).toEqual({
      game: "larn", id: "r1", startedAt: meta.startedAt, endedAt: meta.endedAt, outcome: "died", seed: 4242,
      kb: "",
      depth: 4, xlevel: 5, hp: 0, hpmax: 31, commands: 812, score: 1043, events: 9001, cause: "killed by a gnome",
      lastMessages: ["You die"], details: { larn: { gold: 250 } }, stderr: ["x"], error: "",
    });
  });
});

// The A/B arm (spec 2026-08-19-bot-phase1b-larn-reflect-design.md, "The two
// arms"): a summary that does not name the knowledge state it played under
// cannot be assigned to an arm afterwards.
describe("the knowledge state a run played under", () => {
  it("buildRunSummary keeps the meta's kb hash", () => {
    const s = buildRunSummary(
      { ...meta, kb: "1a2b3c4d" },
      { depth: 1, xlevel: 1, hp: 3, hpmax: 12, commands: 40, score: 0, cause: "", lastMessages: [] },
      { events: 300 },
    );
    expect(s.kb).toBe("1a2b3c4d");
  });

  it("stays off the shared columns: the CSV is compared across engines", () => {
    expect(SCOREBOARD_COLUMNS).not.toContain("kb");
  });
});

describe("scoreboard CSV", () => {
  const s: RunSummary = {
    ...meta, kb: "", depth: 3, xlevel: 2, hp: 0, hpmax: 20, commands: 500, score: 1043, events: 12000,
    cause: 'killed by a jackal, while "helpless"', lastMessages: [], stderr: [], error: "",
  };
  it("quotes fields with commas or quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a,b "c"')).toBe('"a,b ""c"""');
    expect(csvField("a\rb")).toBe('"a\rb"');
  });
  it("row columns match the header, in order", () => {
    expect(SCOREBOARD_HEADER).toBe("game,id,startedAt,endedAt,outcome,seed,depth,xlevel,hp,hpmax,commands,score,events,cause");
    expect(scoreboardRow(s)).toBe(
      `larn,r1,${meta.startedAt},${meta.endedAt},died,4242,3,2,0,20,500,1043,12000,"killed by a jackal, while ""helpless"""`,
    );
    expect(SCOREBOARD_COLUMNS.length).toBe(14);
  });
});

describe("per-game details", () => {
  it("stay off the shared columns: the CSV is compared across engines", () => {
    expect(SCOREBOARD_COLUMNS).not.toContain("details");
  });
});

describe("summarizeScoreboard", () => {
  const row = (outcome: RunSummary["outcome"], depth: number, commands: number) => ({ outcome, depth, commands });
  it("computes the outcome histogram, win rate, medians and max depth", () => {
    const stats = summarizeScoreboard([row("died", 1, 100), row("won", 4, 300), row("capped", 2, 5000), row("timeout", 6, 900)]);
    expect(stats).toEqual({
      games: 4, outcomes: { died: 1, won: 1, capped: 1, timeout: 1 }, winRate: 0.25,
      depthMedian: 3, depthMax: 6, commandsMedian: 600,
    });
    expect(formatSummary(stats)).toBe(
      "4 games — died 1, won 1, capped 1, timeout 1 · win rate 25% · depth median 3, max 6 · commands median 600",
    );
  });
  it("handles an odd count and no games", () => {
    expect(summarizeScoreboard([row("died", 2, 10), row("died", 5, 20), row("died", 3, 30)]).depthMedian).toBe(3);
    expect(summarizeScoreboard([])).toEqual({ games: 0, outcomes: {}, winRate: 0, depthMedian: 0, depthMax: 0, commandsMedian: 0 });
    expect(formatSummary(summarizeScoreboard([]))).toBe("0 games — none · win rate 0% · depth median 0, max 0 · commands median 0");
  });
});

describe("scoreboard seeds", () => {
  it("carries seed as a column", () => {
    expect(SCOREBOARD_COLUMNS).toContain("seed");
  });

  it("puts the seed on the summary", () => {
    const s = emptySummary({
      game: "larn", id: "larn-1", startedAt: "a", endedAt: "b", outcome: "died", seed: 77,
    });
    expect(s.seed).toBe(77);
  });

  it("derives distinct, stable child seeds from one master", () => {
    const seeds = Array.from({ length: 100 }, (_, i) => childSeed(4242, i));
    expect(new Set(seeds).size).toBe(100);
    expect(childSeed(4242, 0)).toBe(seeds[0]);
    expect(childSeed(4243, 0)).not.toBe(seeds[0]);
    for (const s of seeds) expect(s).toBeGreaterThan(0);
  });

  // The mix is a bijection over 32 bits, so exactly two inputs land on a zero
  // low 31 bits; this master/index pair is one of them. 0 means "seed from the
  // clock" at the C hook, so without the guard that one game of a batch would
  // silently be unreproducible.
  it("never returns the clock-seed sentinel", () => {
    expect(childSeed(2485276453, 0)).toBe(1);
  });
});
