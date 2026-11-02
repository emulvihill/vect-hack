import { describe, expect, it } from "vitest";
import {
  inferMoriaHit,
  moriaKeyDir,
} from "../../src/modules/moria/hitInference";

describe("moriaKeyDir", () => {
  it("decodes original keypad directions in shared clockwise compass order", () => {
    expect(["8", "9", "6", "3", "2", "1", "4", "7"].map((key) =>
      moriaKeyDir(key.charCodeAt(0), "original"))).toEqual([
      { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
      { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 },
    ]);
    expect(moriaKeyDir("5".charCodeAt(0), "original")).toBeNull();
  });

  it("decodes roguelike walk and uppercase run directions but no unrelated key", () => {
    expect(moriaKeyDir("k".charCodeAt(0), "roguelike")).toEqual({ dx: 0, dy: -1 });
    expect(moriaKeyDir("L".charCodeAt(0), "roguelike")).toEqual({ dx: 1, dy: 0 });
    expect(moriaKeyDir(".".charCodeAt(0), "roguelike")).toBeNull();
    expect(moriaKeyDir("8".charCodeAt(0), "roguelike")).toBeNull();
    expect(moriaKeyDir("h".charCodeAt(0), "original")).toBeNull();
  });
});

describe("inferMoriaHit", () => {
  const hero = { x: 10, y: 5 };
  const east = { dx: 1, dy: 0 };

  it("places exact source melee hit text at the fresh adjacent direction", () => {
    expect(inferMoriaHit("You hit the novice rogue.", hero, east)).toEqual({ x: 11, y: 5 });
    expect(inferMoriaHit("You hit it.", hero, { dx: -1, dy: -1 })).toEqual({ x: 9, y: 4 });
  });

  it("places each exact source monster attack description on the hero", () => {
    const verbs = [
      "hits", "bites", "claws", "stings", "touches", "gazes at",
      "breathes on", "spits on", "crawls on", "crushes", "tramples", "drools on",
    ];
    for (const verb of verbs) {
      expect(inferMoriaHit(`The giant rat ${verb} you.`, hero, null)).toEqual(hero);
      expect(inferMoriaHit(`It ${verb} you.`, hero, null)).toEqual(hero);
    }
    expect(inferMoriaHit("You've been slimed!", hero, null)).toEqual(hero);
  });

  it("rejects stale or absent evidence, misses, projectiles, prompts, and scenery", () => {
    expect(inferMoriaHit("You hit the orc.", hero, null)).toBeNull();
    expect(inferMoriaHit("You hit the orc.", null, east)).toBeNull();
    expect(inferMoriaHit("You miss the orc.", hero, east)).toBeNull();
    expect(inferMoriaHit("An arrow hits you.", hero, east)).toBeNull();
    expect(inferMoriaHit("A small dart hits you!", hero, east)).toBeNull();
    expect(inferMoriaHit("You hit a teleport trap!", hero, east)).toBeNull();
    expect(inferMoriaHit("You bash it, but nothing interesting happens.", hero, east)).toBeNull();
    expect(inferMoriaHit("Which direction?", hero, east)).toBeNull();
    expect(inferMoriaHit("The giant rat misses you.", hero, east)).toBeNull();
    expect(inferMoriaHit("Something hits you.", hero, east)).toBeNull();
  });

  it("rejects merely similar or ambiguous text instead of guessing", () => {
    expect(inferMoriaHit("You hit.", hero, east)).toBeNull();
    expect(inferMoriaHit("You hit the door.", hero, east)).toEqual({ x: 11, y: 5 });
    expect(inferMoriaHit("The orc hits you!", hero, east)).toBeNull();
    expect(inferMoriaHit("The orc hits you. More text", hero, east)).toBeNull();
  });
});
