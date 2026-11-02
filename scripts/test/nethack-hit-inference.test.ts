// NetHack hit inference (spec 2026-08-06): the shim carries only message
// text, so this is the documented limited-abilities Module — regexes for the
// two unambiguous shapes (you-hit-melee, monster-hits-you), null for
// everything else. Pure; no engine.
import { describe, expect, it } from "vitest";
import { inferNethackHit, nethackKeyDir } from "../../src/modules/nethack/hitInference";

const HERO = { x: 10, y: 5 };
const EAST = { dx: 1, dy: 0 };

describe("nethackKeyDir", () => {
  it("decodes hjklyubn, y-down, in lower, upper (run) and ctrl (rush) forms", () => {
    const CASES: Array<[string, { dx: number; dy: number }]> = [
      ["k", { dx: 0, dy: -1 }], ["u", { dx: 1, dy: -1 }], ["l", { dx: 1, dy: 0 }],
      ["n", { dx: 1, dy: 1 }], ["j", { dx: 0, dy: 1 }], ["b", { dx: -1, dy: 1 }],
      ["h", { dx: -1, dy: 0 }], ["y", { dx: -1, dy: -1 }],
    ];
    for (const [letter, dir] of CASES)
      expect(nethackKeyDir(letter.charCodeAt(0))).toEqual(dir);
    expect(nethackKeyDir("H".charCodeAt(0))).toEqual({ dx: -1, dy: 0 });
    expect(nethackKeyDir(0x0a)).toEqual({ dx: 0, dy: 1 }); // ctrl-J
  });
  it("answers null for everything else", () => {
    expect(nethackKeyDir("s".charCodeAt(0))).toBeNull();
    expect(nethackKeyDir(27)).toBeNull();
    expect(nethackKeyDir(0x04)).toBeNull(); // ctrl-D is kick, not a direction
  });
});

describe("inferNethackHit", () => {
  it("you-hit melee pulses hero + last direction", () => {
    expect(inferNethackHit("You hit the newt!", HERO, EAST)).toEqual({ x: 11, y: 5 });
    expect(inferNethackHit("You smite the watchman!", HERO, EAST)).toEqual({ x: 11, y: 5 });
    expect(inferNethackHit("You bite the jackal.", HERO, EAST)).toEqual({ x: 11, y: 5 });
  });
  it("monster-hits-you pulses the hero cell", () => {
    expect(inferNethackHit("The newt bites!", HERO, EAST)).toEqual(HERO);
    expect(inferNethackHit("The gnome lord hits!", HERO, EAST)).toEqual(HERO);
    expect(inferNethackHit("The bee stings you.", HERO, EAST)).toEqual(HERO);
  });
  it("no pulse for misses, pets, objects, or missing ingredients", () => {
    expect(inferNethackHit("You miss the newt.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("The newt just misses!", HERO, EAST)).toBeNull();
    expect(inferNethackHit("The little dog bites the newt.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You kick the door.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You kick a rock.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You kick the pony.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You hit the rock with all your might.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You hit the door frame!", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You hit your head on the ceiling.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You hit your foot with your bullwhip.", HERO, EAST)).toBeNull();
    expect(inferNethackHit("You hit the newt!", HERO, null)).toBeNull();
    expect(inferNethackHit("You hit the newt!", null, EAST)).toBeNull();
    expect(inferNethackHit("Welcome to NetHack!", HERO, EAST)).toBeNull();
  });
});
