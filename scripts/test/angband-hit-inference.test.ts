// Angband hit inference (spec 2026-08-06): typed message + last direction /
// last ranged-effect cell -> the victim's cell, or null. Pure; no engine.
// MON_HIT additionally reads the message text (vect-hack-xqg): see the header
// of hitInference.ts for why that one type crosses the typed-vs-text line.
import { describe, expect, it } from "vitest";
import { KC_MOD_KEYPAD, KC_MOD_SHIFT } from "../../src/modules/angband/keys";
import { MSG, angbandKeyDir, inferAngbandHit } from "../../src/modules/angband/hitInference";

const HERO = { x: 10, y: 5 };
const EAST = { dx: 1, dy: 0 };

describe("angbandKeyDir", () => {
  it("decodes all eight keypad digits, y-down, run bit ignored", () => {
    const CASES: Array<[string, { dx: number; dy: number }]> = [
      ["8", { dx: 0, dy: -1 }], ["9", { dx: 1, dy: -1 }], ["6", { dx: 1, dy: 0 }],
      ["3", { dx: 1, dy: 1 }], ["2", { dx: 0, dy: 1 }], ["1", { dx: -1, dy: 1 }],
      ["4", { dx: -1, dy: 0 }], ["7", { dx: -1, dy: -1 }],
    ];
    for (const [digit, dir] of CASES)
      expect(angbandKeyDir({ code: digit.charCodeAt(0), mods: KC_MOD_KEYPAD })).toEqual(dir);
    expect(angbandKeyDir({ code: "6".charCodeAt(0), mods: KC_MOD_KEYPAD | KC_MOD_SHIFT })).toEqual(EAST);
  });
  it("answers null for non-keypad and non-direction keys", () => {
    expect(angbandKeyDir({ code: "8".charCodeAt(0), mods: 0 })).toBeNull();
    expect(angbandKeyDir({ code: "5".charCodeAt(0), mods: KC_MOD_KEYPAD })).toBeNull();
    expect(angbandKeyDir({ code: 27, mods: 0 })).toBeNull();
  });
});

describe("inferAngbandHit", () => {
  it("MON_HIT pulses the hero cell when the blow named the player", () => {
    expect(inferAngbandHit(MSG.MON_HIT, "The kobold hits you.", HERO, null, null)).toEqual(HERO);
    // show_damage on: the count rides after the target, not instead of it.
    expect(inferAngbandHit(MSG.MON_HIT, "The kobold hits you (4).", HERO, null, null)).toEqual(HERO);
  });
  it("MON_HIT on a monster-vs-monster blow pulses nothing (vect-hack-xqg)", () => {
    // mon-blows.c display_blow_message_vs_monster() emits the SAME msgt when a
    // monster hits another monster (cmd-cave.c monster_attack_monster, reached
    // through the command-monster mechanic). Only the {target} expansion tells
    // the two apart: "you" for the player, the monster's own name otherwise.
    for (const text of [
      "The kobold hits the orc.", "The kobold hits it.", "Something hits it.",
      "The young blue dragon hits the cave orc.",
    ]) expect(inferAngbandHit(MSG.MON_HIT, text, HERO, null, null)).toBeNull();
  });
  it("melee-only types pulse hero + last direction, never lastEffect", () => {
    for (const t of [MSG.HIT, MSG.HIT_HI_GREAT, MSG.HIT_HI_SUPERB]) {
      expect(inferAngbandHit(t, "You hit the kobold.", HERO, EAST, null)).toEqual({ x: 11, y: 5 });
      expect(inferAngbandHit(t, "You hit the kobold.", HERO, null, { x: 3, y: 9 })).toBeNull();
    }
  });
  it("ambiguous types prefer a fresh direction (melee), fall back to the effect cell (ranged)", () => {
    for (const t of [MSG.HIT_GOOD, MSG.HIT_GREAT, MSG.HIT_SUPERB, MSG.SHOOT_HIT]) {
      expect(inferAngbandHit(t, "It was a good hit!", HERO, EAST, { x: 3, y: 9 })).toEqual({ x: 11, y: 5 });
      expect(inferAngbandHit(t, "It was a good hit!", HERO, null, { x: 3, y: 9 })).toEqual({ x: 3, y: 9 });
      expect(inferAngbandHit(t, "It was a good hit!", HERO, null, null)).toBeNull();
    }
  });
  it("only MON_HIT reads the text; the aimed families stay typed", () => {
    // The typed-vs-text line the design drew is crossed for exactly one type,
    // because nothing typed distinguishes its two emitters. A melee crit whose
    // text never says "you" still pulses where the player aimed.
    expect(inferAngbandHit(MSG.HIT, "The kobold is destroyed.", HERO, EAST, null))
      .toEqual({ x: 11, y: 5 });
  });
  it("no pulse when the ingredient is missing or the type says otherwise", () => {
    expect(inferAngbandHit(MSG.MISS, "You miss the kobold.", HERO, EAST, null)).toBeNull();
    expect(inferAngbandHit(0, "Welcome to Angband.", HERO, EAST, null)).toBeNull();
    expect(inferAngbandHit(MSG.HIT, "You hit the kobold.", HERO, null, null)).toBeNull();
    expect(inferAngbandHit(MSG.HIT, "You hit the kobold.", null, EAST, null)).toBeNull();
    expect(inferAngbandHit(MSG.HIT_GOOD, "It was a good hit!", null, EAST, { x: 3, y: 9 })).toBeNull();
    expect(inferAngbandHit(MSG.MON_HIT, "The kobold hits you.", null, null, null)).toBeNull();
  });
});
