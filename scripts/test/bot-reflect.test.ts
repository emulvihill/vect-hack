// The reflection prompt and the leak probe (spec: 2026-08-19-bot-phase1b-larn-
// reflect-design.md, "The Brain" and "The ablation probe").
//
// The probe is the black-box rule's only enforcement: a claim the model would
// have emitted from a digest that no longer contains the evidence came from
// its priors, not from the dungeon. So the machinery is held to the sabotage
// standard — the planted-leak test below fails a probe that cannot see a leak
// it was handed deliberately, because a probe that always passes certifies the
// premise falsely.
import { describe, expect, it } from "vitest";
import { type RunDigest } from "../../src/bot/digest.ts";
import { type FactDelta } from "../../src/bot/factDelta.ts";
import { claimId, type Fact } from "../../src/bot/kb.ts";
import { buildReflectPrompt, leakedSubjects, partitionLeaks, stripDeathEvidence } from "../../src/bot/reflect.ts";

const DIGEST: RunDigest = {
  game: "larn",
  seed: 12345,
  outcome: "died",
  cause: "killed by a platinum dragon",
  depth: 11,
  xlevel: 1,
  hp: 0,
  hpmax: 12,
  hpBeforeDeath: 9,
  commands: 468,
  mobulsElapsed: 3,
  lastMessages: ["The platinum dragon hits you.", "You die..."],
  finalAdjacent: [{ ch: "D", color: 1, atCommand: 466 }],
  killer: { ch: "D", color: 1, atCommand: 466, capacity: { hp: 9, hpmax: 12 } },
  finalTerrain: [{ category: "floor", ch: ".", kind: "", atCommand: 466 }],
  descents: [{ category: "stairs", ch: "V", kind: "down", fromDepth: 0, toDepth: 11, xlevel: 1, hp: 10, hpmax: 12, atCommand: 412 }],
};

const FACTS: Fact[] = [
  {
    id: "larn/avoid-terrain/stairs:V",
    claim: { kind: "avoid-terrain", category: "stairs", ch: "V" },
    text: "the V shaft drops a level-1 character into the volcano",
    value: null,
    confidence: 0.67,
    support: [{ trajectory: "run-0", from: 400, to: 460 }],
    refute: [],
    retired: null,
    updated: "2026-08-19T12:00:00Z",
    seed: false,
  },
];

const ev = (from: number, to: number) => [{ trajectory: "run-1", from, to }];
const threatD = (): FactDelta => ({
  op: "assert",
  claim: { kind: "threat", ch: "D", color: 1, depth: 11 },
  value: 0.95,
  text: "a D on level 11 killed a level-1 character in two commands",
  evidence: ev(460, 468),
});
const noteShaft = (): FactDelta => ({
  op: "assert",
  claim: { kind: "note", topic: "descent-pacing" },
  text: "the run descended eleven levels at experience level 1",
  evidence: ev(400, 468),
});

describe("buildReflectPrompt", () => {
  const req = buildReflectPrompt(DIGEST, FACTS, "run-1", 900);

  it("shows the model the digest, the trajectory id and the event window", () => {
    expect(req.user).toContain(JSON.stringify(DIGEST, null, 2));
    expect(req.user).toContain("run-1");
    expect(req.user).toContain("900");
  });

  it("lists every current fact by id and text", () => {
    for (const f of FACTS) {
      expect(req.user).toContain(f.id);
      expect(req.user).toContain(f.text);
    }
  });

  it("names all four claim kinds and the delta shape in the system message", () => {
    for (const kind of ["threat", "avoid-terrain", "item-value", "note"]) {
      expect(req.system).toContain(`"kind": "${kind}"`);
    }
    for (const key of ['"op"', '"claim"', '"value"', '"text"', '"evidence"']) {
      expect(req.system).toContain(key);
    }
    for (const op of ["assert", "confirm", "refute", "retire"]) {
      expect(req.system).toContain(op);
    }
  });

  it("states the black-box framing and the empty-answer escape", () => {
    expect(req.system).toContain("ONE game the bot just played");
    expect(req.system).toContain("do not use outside knowledge of the game");
    expect(req.system).toContain("return []");
  });

  it("states the evidence rule: this trajectory, ranges inside [0, events)", () => {
    expect(req.system).toContain("trajectory");
    expect(req.system).toContain("[0, events)");
  });

  // The parser recovers an array out of prose on either side, but by picking
  // the most delta-like candidate — a guess. Asking for a bare array is what
  // keeps it from having to make one.
  it("demands a bare JSON array and nothing around it", () => {
    expect(req.system).toContain("Reply with a JSON array of deltas and nothing else.");
  });

  // vect-hack-b5f.6. The 1b prompt listed the four kinds as peers and the
  // model filed its terrain lessons as prose: 84 notes and 2 avoid-terrain
  // claims over 100 training runs, and of the 53 runs that rode the town's
  // volcanic shaft to depth 11, none filed `stairs:V`. These pin the two
  // things that changed — a routing rule that says a note is the last resort,
  // and a run block that names the keys this run can actually ground.
  it("routes a lesson to the kind that changes behaviour, and says a note does not", () => {
    expect(req.system).toContain("changes nothing");
    expect(req.system).toContain("MUST be filed as that kind");
    // Not merely "notes exist": the model has to be told which lessons may not
    // go in one, or `descent-pacing` swallows the shaft again.
    expect(req.system).toContain("Do not file a lesson here when it is about the run's killer or about one of the eligible terrain keys");
  });

  /** The eligible-keys block alone. The digest is quoted whole a few lines
   *  above it, so a substring search over the message finds the digest's own
   *  fields and proves nothing about what was offered. */
  const eligible = (user: string) => user.slice(user.indexOf("Eligible claim keys"));

  it("offers the exits this run chose as the eligible avoid-terrain keys", () => {
    const block = eligible(req.user);
    expect(block).toContain('"category": "stairs", "ch": "V"');
    expect(block).toContain("depth 0 to 11");
    expect(block).toContain('"ch": "D", "color": 1');
  });

  it("shows the capacity the killer's own fight beat, not the last living reading", () => {
    // hpBeforeDeath is 9 here too, so the phrase is what separates the two:
    // "going into that fight" is the killer's engagement peak
    // (vect-hack-b5f.20), and a block that quoted a "still held" reading
    // would be back to measuring what the fatal blow finished.
    const block = eligible(req.user);
    expect(block).toContain("the hero held 9 of 12 hit points going into that fight");
    expect(block).not.toContain("still held");
  });

  it("offers the ground the hero stood on to nothing — standing somewhere is not choosing it", () => {
    // finalTerrain says where the hero was over the last frames, which is not
    // a decision about terrain: a hero dies on the floor of the room the fight
    // was in. The trap here is the case that separates the rule from the
    // category allowlist — "trap" IS an avoidable category, so a digest whose
    // hero merely stood on one must still offer nothing, or the run block is
    // sourcing from the wrong field and the floor case only passes by luck.
    const stoodOn = {
      ...DIGEST,
      finalTerrain: [
        { category: "trap", ch: "^", kind: "trap-arrow", atCommand: 460 },
        { category: "floor", ch: ".", kind: "", atCommand: 466 },
      ],
    };
    const block = eligible(buildReflectPrompt(stoodOn, FACTS, "run-1", 900).user);
    expect(block).toContain('"category": "stairs", "ch": "V"');
    expect(block).not.toContain('"category": "trap"');
    expect(block).not.toContain('"category": "floor"');
  });

  // The counterweight, and the reason the heading is worded the way it is:
  // 1b lost its A/B to over-claiming, so a list of eligible keys must not read
  // as a list of findings.
  it("says the eligible keys are not conclusions", () => {
    expect(req.user).toContain("not what it concluded");
    expect(req.user).toContain("is not evidence that it hurt");
  });

  it("offers nothing when the run showed no killer and chose no exit", () => {
    // A capped run that fell through an undiscovered trap door: the floor it
    // was standing on is not a choice it could have declined, so there is no
    // terrain key, and no killer means no threat key. Offering either would
    // invite a claim the applier then rejects.
    const fell = {
      ...DIGEST, killer: null,
      descents: [{ category: "floor", ch: ".", kind: "", fromDepth: 1, toDepth: 2, xlevel: 1, hp: 8, hpmax: 12, atCommand: 12 }],
    };
    const block = eligible(buildReflectPrompt(fell, FACTS, "run-1", 900).user);
    expect(block).toContain("threat: none");
    expect(block).toContain("avoid-terrain: none");
    expect(block).not.toContain('"category": "floor"');
  });

  // DIGEST_LIMITS caps element counts, never bytes: one runaway message would
  // otherwise cost the batch its reflection.
  it("truncates a runaway free-text field rather than emitting it whole", () => {
    const huge = { ...DIGEST, cause: "x".repeat(5000), lastMessages: ["y".repeat(5000)] };
    const out = buildReflectPrompt(huge, FACTS, "run-1", 900);
    expect(out.user).not.toContain("x".repeat(1000));
    expect(out.user).not.toContain("y".repeat(1000));
    expect(out.user).toContain("x".repeat(64));
  });
});

describe("stripDeathEvidence", () => {
  it("blanks exactly the outcome, cause, messages, adjacent beings, killer and HP", () => {
    const s = stripDeathEvidence(DIGEST);
    expect(s.outcome).toBe("capped");
    expect(s.cause).toBe("");
    expect(s.lastMessages).toEqual([]);
    expect(s.finalAdjacent).toEqual([]);
    // The strongest death evidence in the digest: it names the being outright.
    // A probe that removed the prose and left the killer behind would ask the
    // model to repeat a fact it had just been handed.
    expect(s.killer).toBeNull();
    expect(DIGEST.killer).not.toBeNull(); // not mutated
    // `hp: 0` under `outcome: capped` REPORTS the death the other four fields
    // just removed, and a real probe transcript proved a model reads it that
    // way — "the run ended capped with hp 0 immediately after"
    // (docs/reports/2026-08-22-larn-r3.md). The hero must read as
    // alive, so hp is carried to the character's own ceiling.
    expect(s.hp).toBe(12);
    expect(s.hpmax).toBe(12);
    expect(s.hp).toBeGreaterThan(0);
    expect(DIGEST.hp).toBe(0); // not mutated
  });

  it("leaves the descents — the probe swaps the death, not the route", () => {
    const s = stripDeathEvidence(DIGEST);
    expect(s.descents).toEqual(DIGEST.descents);
    expect(s.finalTerrain).toEqual(DIGEST.finalTerrain);
    expect(s.depth).toBe(DIGEST.depth);
    expect(s.seed).toBe(DIGEST.seed);
    expect(DIGEST.cause).toBe("killed by a platinum dragon"); // not mutated
  });
});

describe("leakedSubjects", () => {
  it("reports a threat subject that survived the probe", () => {
    expect(leakedSubjects([threatD()], [threatD()])).toEqual([
      claimId("larn", { kind: "threat", ch: "D", color: 1, depth: 11 }),
    ]);
  });

  it("reports an avoid-terrain subject that survived the probe", () => {
    const avoid: FactDelta = {
      op: "assert", claim: { kind: "avoid-terrain", category: "stairs", ch: "V" }, evidence: ev(400, 420),
    };
    expect(leakedSubjects([avoid], [avoid])).toEqual(["larn/avoid-terrain/stairs:V"]);
  });

  it("does not report a note in both lists — a note is not a policy subject", () => {
    expect(leakedSubjects([noteShaft()], [noteShaft()])).toEqual([]);
  });

  it("reports an item-value subject that survived the probe", () => {
    // Three kinds compile into policy tables (kbCompile.ts), not two. The
    // probe used to check the first two while the compiler read all three, so
    // an item claim recited from priors reached a table with nothing to catch
    // it (vect-hack-b5f.6, found in review).
    const item: FactDelta = {
      op: "assert", claim: { kind: "item-value", ch: ")" }, value: 0.8, evidence: ev(400, 420),
    };
    expect(leakedSubjects([item], [item])).toEqual(["larn/item-value/)"]);
  });

  it("does not report a threat the probe did not re-emit", () => {
    expect(leakedSubjects([threatD()], [noteShaft()])).toEqual([]);
    expect(leakedSubjects([threatD()], [])).toEqual([]);
  });

  it("reports each shared subject once, whatever the op", () => {
    const confirmD: FactDelta = { ...threatD(), op: "confirm" };
    expect(leakedSubjects([threatD(), threatD()], [confirmD])).toEqual([
      "larn/threat/D|1|11",
    ]);
  });

  // The sabotage standard: a probe that cannot see a planted leak is worse
  // than no probe, so plant one and require it to be found.
  it("detects a planted leak and passes an honest probe", () => {
    const original = [threatD(), noteShaft()];

    // The model was handed a digest with the death stripped out and named the
    // dragon anyway: it knew, it did not learn.
    const leaky = [
      { ...threatD(), text: "dragons on the deep levels are lethal" },
      noteShaft(),
    ];
    expect(leakedSubjects(original, leaky)).toEqual(["larn/threat/D|1|11"]);

    // The honest probe concludes only what the stripped digest still supports:
    // the descent is still visible, the killer is not.
    const honest: FactDelta[] = [
      { ...noteShaft(), text: "the run reached level 11 at experience level 1" },
    ];
    expect(leakedSubjects(original, honest)).toEqual([]);
  });
});

describe("partitionLeaks", () => {
  const avoidV = (): FactDelta => ({
    op: "assert", claim: { kind: "avoid-terrain", category: "stairs", ch: "V" }, evidence: ev(400, 420),
  });
  const itemGem = (): FactDelta => ({
    op: "assert", claim: { kind: "item-value", ch: ")" }, value: 0.8, evidence: ev(400, 420),
  });

  // The 2026-08-24 decision (vect-hack-b5f.23) in one assertion. This test
  // pins a CHOICE, so it has to fail on the other one: add "threat" to
  // PRIOR_ADMISSIBLE_KINDS and the next case goes red, drop "avoid-terrain"
  // and this one does.
  it("admits an avoid-terrain leak instead of failing the batch", () => {
    const { admitted, fatal } = partitionLeaks([avoidV()], [avoidV()]);
    expect(admitted).toEqual(["larn/avoid-terrain/stairs:V"]);
    expect(fatal).toEqual([]);
  });

  it("still fails the batch on a threat leak — the hole is one kind wide", () => {
    const { admitted, fatal } = partitionLeaks([threatD()], [threatD()]);
    expect(fatal).toEqual(["larn/threat/D|1|11"]);
    expect(admitted).toEqual([]);
  });

  it("still fails the batch on an item-value leak", () => {
    const { admitted, fatal } = partitionLeaks([itemGem()], [itemGem()]);
    expect(fatal).toEqual(["larn/item-value/)"]);
    expect(admitted).toEqual([]);
  });

  it("splits a mixed probe rather than letting the terrain claim cover the threat", () => {
    const original = [threatD(), avoidV(), noteShaft()];
    const probed = [threatD(), avoidV()];
    const { admitted, fatal } = partitionLeaks(original, probed);
    expect(admitted).toEqual(["larn/avoid-terrain/stairs:V"]);
    expect(fatal).toEqual(["larn/threat/D|1|11"]);
  });

  it("keeps detecting everything: leakedSubjects still names an admitted leak", () => {
    // Detection did not move, only the consequence. A rule that stopped
    // LOOKING could not be audited afterwards or reversed later, and the
    // transcript would lose the only record that a terrain fact may be the
    // model's prior rather than the bot's experience.
    expect(leakedSubjects([avoidV()], [avoidV()])).toEqual(["larn/avoid-terrain/stairs:V"]);
    expect(leakedSubjects([threatD(), avoidV()], [threatD(), avoidV()])).toEqual([
      "larn/avoid-terrain/stairs:V", "larn/threat/D|1|11",
    ]);
  });
});
