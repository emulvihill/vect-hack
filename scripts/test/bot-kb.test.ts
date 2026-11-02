// The fact model: ids derived from the typed claim, confidence as arithmetic
// over evidence, and the three policy tables compiled from the facts rather
// than stored beside them.
//
// Two of these tests build facts the Fact type forbids (a learned fact naming
// no evidence; a confidence outside 0..1). Facts arrive as parsed JSON, where
// the type system polices nothing, so the runtime validator has to.
import { describe, expect, it } from "vitest";
import { claimId, confidenceOf, loadKb, type Fact, type PolicyTuning } from "../../src/bot/kb.ts";
import { compileFacts } from "../../src/bot/kbCompile.ts";

const TUNING: PolicyTuning = {
  restLimit: 150, stuckLimit: 3, restBelowHpFraction: 0.5,
  factFloor: 0.6, engageLevelCap: 10, engageLevelWeight: 0.5, disengageLimit: 4,
  shaftMinXlevel: 8, descendMinHpFraction: 0, wieldProbes: 40, castAtRange: false,
};

function learned(partial: Partial<Fact> & { claim: Fact["claim"] }): Fact {
  return {
    id: claimId("larn", partial.claim), text: "", value: null,
    confidence: confidenceOf(1, 0), support: [{ trajectory: "r1", from: 0, to: 5 }],
    refute: [], retired: null, updated: "2026-08-19T00:00:00Z", seed: false,
    ...partial,
  };
}

describe("claimId", () => {
  it("derives stable ids from typed subjects", () => {
    expect(claimId("larn", { kind: "threat", ch: "D", color: 1, depth: 11 })).toBe("larn/threat/D|1|11");
    expect(claimId("larn", { kind: "threat", ch: "D", color: 1, depth: "*" })).toBe("larn/threat/D|1|*");
    expect(claimId("larn", { kind: "avoid-terrain", category: "stairs", ch: "V" })).toBe("larn/avoid-terrain/stairs:V");
    expect(claimId("larn", { kind: "item-value", ch: ")" })).toBe("larn/item-value/)");
    expect(claimId("larn", { kind: "note", topic: "volcano-shaft" })).toBe("larn/note/volcano-shaft");
  });
});

describe("confidenceOf", () => {
  it("is (s+1)/(s+r+2)", () => {
    expect(confidenceOf(0, 0)).toBeCloseTo(0.5);
    expect(confidenceOf(1, 0)).toBeCloseTo(2 / 3);
    expect(confidenceOf(1, 1)).toBeCloseTo(0.5);
    expect(confidenceOf(3, 0)).toBeCloseTo(0.8);
  });
});

describe("compileFacts", () => {
  it("compiles active facts into the three tables", () => {
    const facts = [
      learned({ claim: { kind: "threat", ch: "D", color: 1, depth: 11 }, value: 0.9, confidence: 0.75 }),
      learned({ claim: { kind: "avoid-terrain", category: "stairs", ch: "V" }, confidence: 0.67 }),
      learned({ claim: { kind: "item-value", ch: ")" }, value: 0.8, confidence: 0.75 }),
      learned({ claim: { kind: "note", topic: "x" }, confidence: 0.9 }),
    ];
    const t = compileFacts(facts, 0.6);
    expect(t.threat).toEqual({ "D|1|11": 0.9 });
    expect(t.avoidTerrain).toEqual({ "stairs:V": Infinity });   // no threshold recorded
    expect(t.itemValue).toEqual({ ")": 0.8 });
  });
  it("a fact below the floor, retired, or valueless compiles to nothing", () => {
    const facts = [
      learned({ claim: { kind: "threat", ch: "a", color: 2, depth: 1 }, value: 0.4, confidence: 0.5 }),
      learned({ claim: { kind: "avoid-terrain", category: "stairs", ch: "V" }, confidence: 0.9, retired: { reason: "wrong", updated: "2026-08-19T00:00:00Z" } }),
      learned({ claim: { kind: "threat", ch: "b", color: 2, depth: 1 }, value: null, confidence: 0.9 }),
    ];
    const t = compileFacts(facts, 0.6);
    expect(t.threat).toEqual({});
    expect(t.avoidTerrain).toEqual({});
  });
  it("empty facts compile to empty tables", () => {
    expect(compileFacts([], 0.6)).toEqual({ threat: {}, itemValue: {}, avoidTerrain: {} });
  });
});

describe("loadKb", () => {
  it("empty facts are inert and hash stably", () => {
    const kb = loadKb({ meta: { facts: [] }, engine: { facts: [] }, policy: TUNING });
    expect(kb.threat("D", 1, 11)).toBeNull();
    expect(kb.itemValue(")")).toBeNull();
    expect(kb.avoidTerrain("stairs:V", 12)).toBe(false);
    const again = loadKb({ meta: { facts: [] }, engine: { facts: [] }, policy: TUNING });
    expect(kb.hash).toBe(again.hash);
  });
  it("compiled facts are consultable, engine tier wins, hash moves with the tables", () => {
    const empty = loadKb({ meta: { facts: [] }, engine: { facts: [] }, policy: TUNING });
    const kb = loadKb({
      meta: { facts: [learned({ claim: { kind: "threat", ch: "D", color: 1, depth: "*" }, value: 0.3, confidence: 0.75 })] },
      engine: {
        facts: [
          learned({ claim: { kind: "threat", ch: "D", color: 1, depth: 11 }, value: 0.9, confidence: 0.75 }),
          learned({ claim: { kind: "avoid-terrain", category: "stairs", ch: "V" }, confidence: 0.67 }),
        ],
      },
      policy: TUNING,
    });
    expect(kb.threat("D", 1, 11)).toBe(0.9);   // exact depth beats the meta wildcard
    expect(kb.threat("D", 1, 4)).toBe(0.3);    // wildcard fallback
    expect(kb.avoidTerrain("stairs:V", 12)).toBe(true);   // no threshold recorded: avoid at any size
    expect(kb.avoidTerrain("stairs:%", 12)).toBe(false);
    expect(kb.hash).not.toBe(empty.hash);
  });

  // vect-hack-b5f.17. A flat avoid set made the third learning run's five
  // terrain keys unusable: every exit was avoided, the descend step found none
  // eligible, and 0 of 54 volcano seeds changed course. The threshold is what
  // makes the same fact a preference a growing character outgrows.
  it("an avoidance is a capacity threshold, not a veto", () => {
    const kb = loadKb({
      meta: { facts: [] },
      engine: {
        facts: [learned({
          claim: { kind: "avoid-terrain", category: "stairs", ch: "V" },
          value: 14, confidence: 0.99,
        })],
      },
      policy: TUNING,
    });
    expect(kb.avoidTerrain("stairs:V", 10)).toBe(true);    // a 10-hp character stays away
    expect(kb.avoidTerrain("stairs:V", 14)).toBe(true);    // the bar itself is not enough
    expect(kb.avoidTerrain("stairs:V", 15)).toBe(false);   // past it the exit is ordinary
    expect(kb.avoidTerrain("stairs:V", 90)).toBe(false);
  });

  it("two thresholds for one key are two knowledge states", () => {
    const at = (value: number) => loadKb({
      meta: { facts: [] },
      engine: { facts: [learned({ claim: { kind: "avoid-terrain", category: "stairs", ch: "V" }, value, confidence: 0.99 })] },
      policy: TUNING,
    }).hash;
    // A hash that could not tell 14 from 40 would let an A/B report two
    // different bots as one arm.
    expect(at(14)).not.toBe(at(40));
  });
  it("rejects a learned fact with no evidence, and a bad confidence", () => {
    const bad = learned({ claim: { kind: "note", topic: "y" } });
    bad.support = [];
    expect(() => loadKb({ meta: { facts: [] }, engine: { facts: [bad] }, policy: TUNING })).toThrow(/no evidence/);
    const conf = learned({ claim: { kind: "note", topic: "z" }, confidence: 1.5 });
    expect(() => loadKb({ meta: { facts: [] }, engine: { facts: [conf] }, policy: TUNING })).toThrow(/confidence/);
  });
  it("accepts a seed fact with no evidence", () => {
    const seed: Fact = {
      id: "meta/note/kiting", claim: { kind: "note", topic: "kiting" }, text: "keep distance from faster monsters",
      value: null, confidence: 0.8, support: [], refute: [], retired: null,
      updated: "2026-08-19T00:00:00Z", seed: true,
    };
    const kb = loadKb({ meta: { facts: [seed] }, engine: { facts: [] }, policy: TUNING });
    expect(kb.fact("meta/note/kiting")?.text).toContain("distance");
  });
});
