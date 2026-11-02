import { describe, expect, it } from "vitest";
import { applyDeltas, parseDeltaDocument, serializeFacts, type FactDelta } from "../../src/bot/factDelta.ts";
import { type RunGrounds } from "../../src/bot/digest.ts";
import { type Evidence, type Fact } from "../../src/bot/kb.ts";

const NOW = "2026-08-19T12:00:00Z";
const ev = (t: string, from = 0, to = 10, value?: number): Evidence =>
  value === undefined ? { trajectory: t, from, to } : { trajectory: t, from, to, value };
const exists = (e: Evidence) => e.trajectory.startsWith("run-") && e.from >= 0 && e.to > e.from;
/** The run this delta set came from, unless a test says otherwise: a D in
 *  colour 1 killed the hero, and the one exit the hero chose was the V shaft.
 *  Threat deltas about any other being are the bystander bug
 *  (vect-hack-b5f.4); avoid-terrain deltas about any other cell are terrain
 *  the run never chose to step onto (vect-hack-b5f.6). Neither may reach a
 *  fact. */
const RUN: RunGrounds = { killer: { ch: "D", color: 1 }, terrain: [{ category: "stairs", ch: "V", power: 12 }], killedAtCapacity: 0.5 };
const apply = (facts: Fact[], deltas: FactDelta[], grounds: RunGrounds = RUN) =>
  applyDeltas(facts, deltas, { engine: "larn", now: NOW, evidenceExists: exists, grounds });

const avoidV: FactDelta = {
  op: "assert",
  claim: { kind: "avoid-terrain", category: "stairs", ch: "V" },
  text: "a level-1 character taking the V shaft died in 18 commands",
  evidence: [ev("run-1", 400, 460)],
};

describe("applyDeltas", () => {
  it("assert creates a fact with derived id and arithmetic confidence", () => {
    const r = apply([], [avoidV]);
    expect(r.rejections).toEqual([]);
    expect(r.facts).toHaveLength(1);
    const f = r.facts[0]!;
    expect(f.id).toBe("larn/avoid-terrain/stairs:V");
    expect(f.confidence).toBeCloseTo(2 / 3);
    expect(f.seed).toBe(false);
    expect(f.updated).toBe(NOW);
  });
  it("same subject from two runs merges into one fact", () => {
    const twice = { ...avoidV, evidence: [ev("run-2", 100, 150)] };
    const r = apply(apply([], [avoidV]).facts, [twice]);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]!.support).toHaveLength(2);
    expect(r.facts[0]!.confidence).toBeCloseTo(3 / 4);
  });
  // item-value is the one numeric kind still stated rather than measured: the
  // run cannot say what a `)` was worth. threat and avoid-terrain ratchet on
  // the capacity the run recorded instead — see the ratchet suite below.
  it("a stated numeric claim takes the median of supporting values", () => {
    const mk = (t: string, v: number): FactDelta => ({
      op: "assert", claim: { kind: "item-value", ch: ")" },
      value: v, text: "a weapon", evidence: [ev(t, 0, 10, v)],
    });
    let facts: Fact[] = [];
    for (const d of [mk("run-1", 0.9), mk("run-2", 0.5), mk("run-3", 0.8)]) facts = apply(facts, [d]).facts;
    expect(facts[0]!.value).toBeCloseTo(0.8);
  });
  it("refute lowers confidence without deleting; retire keeps a tombstone", () => {
    let facts = apply([], [avoidV]).facts;
    facts = apply(facts, [{ op: "refute", claim: avoidV.claim, evidence: [ev("run-3", 5, 30)] }]).facts;
    expect(facts[0]!.confidence).toBeCloseTo(0.5);
    facts = apply(facts, [{ op: "retire", claim: avoidV.claim, reason: "town shaft is fine after level 5", evidence: [ev("run-4", 5, 30)] }]).facts;
    expect(facts[0]!.retired?.reason).toContain("level 5");
    expect(facts).toHaveLength(1);
  });
  it("evidence is deduplicated by (trajectory, from, to)", () => {
    const r = apply(apply([], [avoidV]).facts, [avoidV]);
    expect(r.facts[0]!.support).toHaveLength(1);
    expect(r.facts[0]!.confidence).toBeCloseTo(2 / 3);
  });
  it("rejects: unknown evidence, missing evidence, missing value, out-of-range value, confirm of nothing", () => {
    const bad: [FactDelta, RegExp][] = [
      [{ ...avoidV, evidence: [ev("ghost", 0, 10)] }, /evidence/],
      [{ ...avoidV, evidence: [] }, /evidence/],
      [{ op: "assert", claim: { kind: "threat", ch: "D", color: 1, depth: 11 }, evidence: [ev("run-1", 0, 9)] }, /value/],
      [{ op: "assert", claim: { kind: "threat", ch: "D", color: 1, depth: 11 }, value: 1.4, evidence: [ev("run-1", 0, 9, 1.4)] }, /value/],
      [{ op: "confirm", claim: { kind: "note", topic: "nothing" }, evidence: [ev("run-1", 0, 9)] }, /no such fact/],
    ];
    for (const [d, want] of bad) {
      const r = apply([], [d]);
      expect(r.facts).toHaveLength(0);
      expect(r.rejections[0]!.reason).toMatch(want);
    }
  });
});

describe("idempotence", () => {
  const deltas: FactDelta[] = [avoidV, { op: "assert" as const, claim: { kind: "threat" as const, ch: "D", color: 1, depth: 11 }, value: 0.9, text: "dragon", evidence: [ev("run-1", 0, 20, 0.9)] }];
  it("applying the same delta set twice is byte-identical", () => {
    const once = serializeFacts(apply([], deltas).facts);
    const twice = serializeFacts(apply(apply([], deltas).facts, deltas).facts);
    expect(twice).toBe(once);
  });
  // The pass above shares one clock, so an applier that restamped `updated`
  // unconditionally would still satisfy it. The real host runs a day later.
  const LATER = "2027-01-01T00:00:00Z";
  const applyAt = (facts: Fact[], ds: FactDelta[], now: string) =>
    applyDeltas(facts, ds, { engine: "larn", now, evidenceExists: exists, grounds: RUN });
  it("a second pass under a later clock does not restamp an unchanged fact", () => {
    const once = applyAt([], deltas, NOW).facts;
    const again = applyAt(once, deltas, LATER).facts;
    expect(again.every((f) => f.updated === NOW)).toBe(true);
    expect(serializeFacts(again)).toBe(serializeFacts(once));
  });
  it("re-retiring for the same reason does not restamp the tombstone", () => {
    const retire: FactDelta = { op: "retire", claim: avoidV.claim, reason: "town shaft is fine after level 5", evidence: [] };
    const once = applyAt(applyAt([], [avoidV], NOW).facts, [retire], NOW).facts;
    const again = applyAt(once, [retire], LATER).facts;
    expect(again[0]!.retired?.updated).toBe(NOW);
    expect(serializeFacts(again)).toBe(serializeFacts(once));
  });
});

describe("parseDeltaDocument", () => {
  it("parses a bare array and a fenced one", () => {
    const doc = JSON.stringify([avoidV]);
    expect(parseDeltaDocument(doc).deltas).toHaveLength(1);
    expect(parseDeltaDocument("Here are my findings:\n```json\n" + doc + "\n```\n").deltas).toHaveLength(1);
  });
  it("keeps backticks that live inside a string value", () => {
    const quoting: FactDelta = { ...avoidV, text: "the run's own note said ```json before the shaft" };
    const r = parseDeltaDocument("```json\n" + JSON.stringify([quoting]) + "\n```\n");
    expect(r.error).toBe(null);
    expect(r.deltas[0]!.text).toBe(quoting.text);
  });
  // The configured local model reasons before it answers, and reasoning prose
  // brackets things. First-"[" to last-"]" reads that prose as the document
  // and silently costs a run every delta it earned.
  it("finds the array under prose that brackets before it", () => {
    const doc = JSON.stringify([avoidV]);
    const r = parseDeltaDocument(`The hero took the [V] shaft at command 412, as noted in [1].\n${doc}`);
    expect(r.error).toBe(null);
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas[0]!.claim).toEqual(avoidV.claim);
  });
  it("finds the array under prose that brackets after it", () => {
    const doc = JSON.stringify([avoidV]);
    const r = parseDeltaDocument(`${doc}\nThat is what the digest supports [1].`);
    expect(r.error).toBe(null);
    expect(r.deltas).toHaveLength(1);
  });
  it("finds the array under a reasoning preamble on both sides", () => {
    const doc = JSON.stringify([avoidV, { ...avoidV, op: "confirm" }]);
    const r = parseDeltaDocument(
      `<think>Options: [1] the shaft, [2] the staircase. I will report [the shaft].</think>\n`
      + `${doc}\nEnd of answer [done].`);
    expect(r.error).toBe(null);
    expect(r.deltas).toHaveLength(2);
  });
  it("keeps a bracket inside a delta's own text out of the scan", () => {
    const bracketed: FactDelta = { ...avoidV, text: "the shaft [V] killed it] and the log said so" };
    const r = parseDeltaDocument(`Here you go:\n${JSON.stringify([bracketed])}`);
    expect(r.error).toBe(null);
    expect(r.deltas[0]!.text).toBe(bracketed.text);
  });
  it("reports malformed input as an error, never a throw", () => {
    const r = parseDeltaDocument("I could not find anything to conclude.");
    expect(r.deltas).toEqual([]);
    expect(r.error).toMatch(/no JSON array/);
  });
  it("drops non-conforming entries with an error naming the index", () => {
    const r = parseDeltaDocument(JSON.stringify([avoidV, { op: "invent", claim: { kind: "threat" } }]));
    expect(r.deltas).toHaveLength(1);
    expect(r.error).toMatch(/entry 1/);
  });
});

// The bystander gate (vect-hack-b5f.4). The first earned knowledge base blamed
// a creature that merely stood next to the hero in 5 of its 38 threat facts,
// one of them on a run an arrow trap killed. The prompt now says only the
// killer may be claimed, but an instruction is not a gate: this is.
describe("applyDeltas: only the killer may become a threat", () => {
  const threat = (ch: string, color = 1, op: FactDelta["op"] = "assert"): FactDelta => ({
    op,
    claim: { kind: "threat", ch, color, depth: 11 },
    value: 1,
    text: `${ch} was beside the hero at the end`,
    evidence: [ev("run-1", 400, 460)],
  });

  it("accepts an assert about the being that landed the blow", () => {
    const r = apply([], [threat("D")]);
    expect(r.rejections).toEqual([]);
    expect(r.facts.map((f) => f.id)).toEqual(["larn/threat/D|1|11"]);
  });

  it("rejects an assert about a bystander and writes no fact", () => {
    const r = apply([], [threat("B")]);
    expect(r.facts).toEqual([]);
    expect(r.accepted).toBe(0);
    expect(r.rejections[0]!.reason).toMatch(/killed by D in colour 1, not B/);
  });

  it("rejects a confirm about a bystander: the cheaper op is the same claim", () => {
    // The dangerous shape: an earlier run really was killed by a B, so the
    // fact exists and a confirm would raise its confidence on no evidence at
    // all. Without the gate this is how a bystander's threat value climbs.
    const earned = apply([], [threat("B")], { ...RUN, killer: { ch: "B", color: 1 } }).facts;
    const r = apply(earned, [threat("B", 1, "confirm")]);
    expect(r.accepted).toBe(0);
    expect(r.facts[0]!.support).toHaveLength(1);
    expect(r.rejections[0]!.reason).toMatch(/killed by D in colour 1, not B/);
  });

  it("rejects a confirm about the killer's glyph in a colour the screen did not draw", () => {
    // Colour is part of the claim id, so this would open a second fact about
    // the same being rather than confirming the first (vect-hack-b5f.7).
    const earned = apply([], [threat("D", 4)], { ...RUN, killer: { ch: "D", color: 4 } }).facts;
    const r = apply(earned, [threat("D", 4, "confirm")]);
    expect(r.accepted).toBe(0);
    expect(r.rejections[0]!.reason).toMatch(/colour 1, not D in colour 4/);
  });

  it("rejects every threat from a run that names no killer", () => {
    // A trap death, a win, a capped run, a killer the screen never drew: the
    // digest reports them all as null and none of them shows a being is
    // dangerous.
    const r = apply([], [threat("D")], { ...RUN, killer: null });
    expect(r.facts).toEqual([]);
    expect(r.rejections[0]!.reason).toMatch(/names no killer/);
  });

  it("still lets a killerless run refute and retire: taking a claim away needs no killer", () => {
    const earned = apply([], [threat("D")]).facts;
    const refuted = apply(earned, [threat("D", 1, "refute")], { ...RUN, killer: null });
    expect(refuted.rejections).toEqual([]);
    expect(refuted.facts[0]!.refute).toHaveLength(1);
    const retire: FactDelta = { op: "retire", claim: threat("D").claim, reason: "outgrown", evidence: [] };
    const retired = apply(refuted.facts, [retire], { ...RUN, killer: null });
    expect(retired.rejections).toEqual([]);
    expect(retired.facts[0]!.retired!.reason).toBe("outgrown");
  });

  it("leaves the other claim kinds alone — the gate is about beings", () => {
    const item: FactDelta = {
      op: "assert", claim: { kind: "item-value", ch: ")" }, value: 0.8,
      text: "a ) was worth taking", evidence: [ev("run-1")],
    };
    const r = apply([], [avoidV, item], { ...RUN, killer: null });
    expect(r.rejections).toEqual([]);
    expect(r.facts).toHaveLength(2);
  });
});

// vect-hack-b5f.6. The prompt now names the exits a run chose and tells the
// model to file its terrain lessons against them instead of into a note. That
// invitation is worth nothing unless the applier holds the same line: a claim
// about terrain the run never chose to step onto is a claim about somewhere
// else's dungeon.
describe("the terrain gate", () => {
  const avoid = (ch: string, op: FactDelta["op"] = "assert", category = "stairs"): FactDelta => ({
    op, claim: { kind: "avoid-terrain", category, ch },
    text: `the ${ch} exit cost this run the game`, evidence: [ev("run-1", 400, 460)],
  });

  it("takes a claim about the exit this run chose", () => {
    const r = apply([], [avoid("V")]);
    expect(r.rejections).toEqual([]);
    expect(r.facts[0]!.id).toBe("larn/avoid-terrain/stairs:V");
  });

  it("rejects a claim about an exit this run never took", () => {
    // The hero rode the shaft. An ordinary staircase is the route the ladder
    // needs, and this run says nothing whatever about it — a fact keyed on
    // stairs:% would come from somewhere other than the dungeon.
    const r = apply([], [avoid("%")]);
    expect(r.facts).toEqual([]);
    expect(r.rejections[0]!.reason).toMatch(/stairs:% is not terrain this run chose/);
    expect(r.rejections[0]!.reason).toMatch(/stairs:V/);
  });

  it("rejects a claim about the same glyph under another category", () => {
    // The key the consumer reads is "<category>:<ch>", so a claim that keeps
    // the glyph and changes the category is a different row, about terrain
    // this run did not show (the b5f.7 argument, for terrain).
    const r = apply([], [avoid("V", "assert", "feature")]);
    expect(r.facts).toEqual([]);
    expect(r.rejections[0]!.reason).toMatch(/feature:V is not terrain/);
  });

  it("gates confirm as hard as assert", () => {
    // A confirm raises confidence, so it needs the evidence an assert needs,
    // or the whole gate is walked around through the cheaper op.
    const earned = apply([], [avoid("V")]).facts;
    const r = apply(earned, [avoid("V", "confirm")], { ...RUN, terrain: [{ category: "stairs", ch: "%", power: 12 }] });
    expect(r.accepted).toBe(0);
    expect(r.facts[0]!.support).toHaveLength(1);
  });

  it("rejects every terrain claim from a run that chose no exit", () => {
    // A run that never left the level it started on, or fell through a trap
    // door it never saw: there is no exit it declined to take.
    const r = apply([], [avoid("V")], { ...RUN, terrain: [] });
    expect(r.facts).toEqual([]);
    expect(r.rejections[0]!.reason).toMatch(/took no exit it could have declined/);
  });

  it("still lets any run refute and retire: taking a claim away needs no exit", () => {
    const earned = apply([], [avoid("V")]).facts;
    const none = { ...RUN, terrain: [] };
    const refuted = apply(earned, [avoid("V", "refute")], none);
    expect(refuted.rejections).toEqual([]);
    expect(refuted.facts[0]!.refute).toHaveLength(1);
    const retire: FactDelta = { op: "retire", claim: avoid("V").claim, reason: "fine after level 5", evidence: [] };
    expect(apply(refuted.facts, [retire], none).rejections).toEqual([]);
  });
});

// vect-hack-b5f.17. A value used to be whatever the model said, and the third
// learning run's 43 threat keys came back almost all valued exactly 1.0 — true
// of a level-1 character and useless for picking fights. The run itself holds
// the number, so the applier takes it from the digest and the model's is only
// a fallback for a subject the run could not measure.
describe("a value is measured from the run, and ratchets upward", () => {
  const threatD = (op: FactDelta["op"] = "assert", value = 1): FactDelta => ({
    op, claim: { kind: "threat", ch: "D", color: 1, depth: 11 },
    value, text: "a D killed the hero", evidence: [ev("run-1", 460, 468)],
  });
  const avoidV = (op: FactDelta["op"] = "assert"): FactDelta => ({
    op, claim: { kind: "avoid-terrain", category: "stairs", ch: "V" },
    text: "the shaft", evidence: [ev("run-1", 400, 460)],
  });

  it("takes the capacity the run recorded, not the value the model stated", () => {
    // The model says 1.0 — lethal to everything. The run says the hero still
    // held half their hit points when the blow landed, which is the number
    // that decides whether a healthy hero should take this fight.
    const r = apply([], [threatD("assert", 1)]);
    expect(r.facts[0]!.value).toBe(0.5);
  });

  it("falls back to the model's value when the run measured none", () => {
    const r = apply([], [threatD("assert", 0.8)], { ...RUN, killedAtCapacity: null });
    expect(r.facts[0]!.value).toBe(0.8);
  });

  it("a death at higher capacity raises the bar; a death below it does not lower it", () => {
    const first = apply([], [threatD()]).facts;
    expect(first[0]!.value).toBe(0.5);
    // A second run dies to the same being while nearly untouched: this being
    // kills healthy heroes, and the table has to say so.
    const worse = apply(first, [{ ...threatD("confirm"), evidence: [ev("run-1", 10, 20)] }],
      { ...RUN, killedAtCapacity: 0.95 });
    expect(worse.facts[0]!.value).toBe(0.95);
    // A third dies at a crawl. A median would drag the bar back down and
    // certify a being already seen killing a healthy hero.
    const weaker = apply(worse.facts, [{ ...threatD("confirm"), evidence: [ev("run-1", 30, 40)] }],
      { ...RUN, killedAtCapacity: 0.1 });
    expect(weaker.facts[0]!.value).toBe(0.95);
  });

  it("an exit's threshold is the capacity it was taken with, and ratchets the same way", () => {
    const small = apply([], [avoidV()]);
    expect(small.facts[0]!.value).toBe(12);   // RUN's hero took the shaft at hpmax 12
    const bigger = apply(small.facts, [{ ...avoidV("confirm"), evidence: [ev("run-1", 10, 20)] }],
      { ...RUN, terrain: [{ category: "stairs", ch: "V", power: 40 }] });
    // A 40-hp character died after taking it too, so 40 is not big enough
    // either — exactly the indication the bar should rise.
    expect(bigger.facts[0]!.value).toBe(40);
  });
});
