import { describe, expect, it } from "vitest";
import { canonicalLine, canonicalRecord } from "../../src/bot/canonical";
import type { RunSummary } from "../../src/bot/scoreboard";

const base: RunSummary = {
  game: "larn", id: "larn-20260818T101010Z-4242-0001",
  startedAt: "2026-08-18T10:10:10.000Z", endedAt: "2026-08-18T10:12:00.000Z",
  outcome: "died", seed: 991, tuning: {}, depth: 3, xlevel: 2, hp: 0, hpmax: 19,
  commands: 412, score: 1043, events: 5183, cause: "killed by a gnome", lastMessages: [],
  stderr: [], error: "",
};

describe("canonical gameplay record", () => {
  it("ignores the fields that cannot match across runs", () => {
    const other = { ...base, id: "larn-20260819T000000Z-9999-0001",
      startedAt: "later", endedAt: "later still", events: 5184 };
    expect(canonicalRecord(other)).toEqual(canonicalRecord(base));
  });

  it("notices a different game", () => {
    expect(canonicalRecord({ ...base, depth: 4 })).not.toEqual(canonicalRecord(base));
    expect(canonicalRecord({ ...base, commands: 413 })).not.toEqual(canonicalRecord(base));
    expect(canonicalRecord({ ...base, cause: "killed by a bat" })).not.toEqual(canonicalRecord(base));
    expect(canonicalRecord({ ...base, seed: 992 })).not.toEqual(canonicalRecord(base));
  });

  // Both sides of a toEqual lose a dropped field together, so the tests above
  // cannot see one go missing. This pins the record's exact shape in both
  // directions — an omission and an accidental addition each fail here.
  it("carries exactly the gameplay fields", () => {
    expect(Object.keys(canonicalRecord(base)).sort()).toEqual([
      "cause", "commands", "depth", "game", "hp", "hpmax", "lastMessages",
      "outcome", "score", "seed", "xlevel",
    ]);
  });

  it("notices a different transcript", () => {
    expect(canonicalRecord({ ...base, lastMessages: ["you hit the gnome"] }))
      .not.toEqual(canonicalRecord(base));
  });

  it("renders a stable one-line form keyed by seed", () => {
    expect(canonicalLine(base)).toBe(canonicalLine({ ...base, id: "x", startedAt: "y", endedAt: "z" }));
    expect(canonicalLine(base).startsWith("991 ")).toBe(true);
  });
});
