import { describe, expect, it } from "vitest";
import { BotBrain, isFrontier, k, lootHereMessage, nextStep, passable } from "../../src/modules/nethack/bot/policy";
import { BotModel } from "../../src/modules/nethack/bot/model";
import { CLR } from "../../src/backplane/colors";
import { cell, ready } from "./bot-fixtures";

/** Paint a small level from ASCII art; '@' places the hero on floor. */
function level(rows: string[], x0 = 2, y0 = 2): BotModel {
  const m = ready();
  rows.forEach((row, dy) => {
    [...row].forEach((ch, dx) => {
      if (ch === " ") return; // unexplored
      const x = x0 + dx, y = y0 + dy;
      if (ch === "@") {
        m.observe({ name: "print_glyph", win: 30, x, y, cell: cell(".") , bg: null });
        m.observe({ name: "print_glyph", win: 30, x, y, cell: cell("@", { glyph: 1, glyphflags: 0x1 }), bg: null });
      } else if (ch === "D") { // hostile monster on floor: 'd' jackal, glyph in monster range
        m.observe({ name: "print_glyph", win: 30, x, y, cell: cell("d", { glyph: 5 }), bg: null });
      } else if (ch === "E") { // floating eye: blue 'e'
        m.observe({ name: "print_glyph", win: 30, x, y, cell: cell("e", { glyph: 6, color: CLR.BLUE }), bg: null });
      } else {
        m.observe({ name: "print_glyph", win: 30, x, y, cell: cell(ch) , bg: null });
      }
    });
  });
  return m;
}

const statusHp = (m: BotModel, hp: number, hpmax: number) => {
  m.observe({ name: "status_update", fldidx: 18, text: String(hp), condbits: 0, chg: 0, percent: 0, color: 0 });
  m.observe({ name: "status_update", fldidx: 19, text: String(hpmax), condbits: 0, chg: 0, percent: 0, color: 0 });
};

describe("passable / frontier", () => {
  it("floors, corridors, doors, stairs pass; walls, water, lava, traps don't", () => {
    const m = level([".#+<>", "-|}^."]);
    expect(passable(m, 2, 2)).toBe(true);  // .
    expect(passable(m, 3, 2)).toBe(true);  // #
    expect(passable(m, 4, 2)).toBe(true);  // + closed door
    expect(passable(m, 5, 2)).toBe(true);  // <
    expect(passable(m, 6, 2)).toBe(true);  // >
    expect(passable(m, 2, 3)).toBe(false); // - wall
    expect(passable(m, 3, 3)).toBe(false); // | wall
    expect(passable(m, 4, 3)).toBe(false); // } water
    expect(passable(m, 5, 3)).toBe(false); // ^ trap
    expect(passable(m, 0, 0)).toBe(false); // unexplored
  });

  it("frontier = passable cell touching unexplored dark", () => {
    const m = level(["...", "..."]);
    expect(isFrontier(m, 2, 2)).toBe(true);   // edge of the painted area
    expect(isFrontier(m, 3, 2)).toBe(true);   // touches dark above
    const closed = level(["....."], 40, 10);  // isolated strip: all frontier
    expect(isFrontier(closed, 41, 10)).toBe(true);
  });
});

describe("nextStep", () => {
  it("routes around walls and reports the first step's direction", () => {
    // Hero at left, target right, wall between: must go around via the gap.
    const m = level([
      ".....",
      ".@|..",
      "..|..",
      ".....",
    ]);
    const step = nextStep(m, (x, y) => x === 6 && y === 3, new Set());
    expect(step).not.toBeNull();
    expect(["k", "u", "j", "b", "h"]).toContain(step!.dir); // not "l": wall
  });

  it("never routes diagonally through a doorway", () => {
    const m = level([
      ".+.",
      ".@.",
    ]);
    // Target is diagonal past the door; first step must be orthogonal (k onto
    // the door is disallowed too since door entry must be orthogonal - k IS
    // orthogonal; the forbidden move is a diagonal like u onto '+').
    const step = nextStep(m, (x, y) => x === 3 && y === 2, new Set());
    expect(step!.dir).toBe("k");
    expect(step!.door).toBe(true);
  });

  it("respects the blocked set", () => {
    const m = level(["@.."]);
    const key = (x: number, y: number) => y * 80 + x;
    const step = nextStep(m, (x, y) => x === 4 && y === 2, new Set([key(3, 2)]));
    expect(step).toBeNull(); // only route is blocked
  });
});

describe("BotBrain priorities", () => {
  it("prays in an emergency (low HP), at most once per cooldown", () => {
    const m = level(["@."]);
    statusHp(m, 2, 20);
    const brain = new BotBrain();
    const a = brain.decide(m);
    expect(a.intent).toBe("pray");
    expect(a.extCmd).toBe("pray");
    expect(a.keys).toEqual([k("#")]);
    const b = brain.decide(m);
    expect(b.intent).not.toBe("pray"); // cooldown
  });

  it("eats when Hungry", () => {
    const m = level(["@."]);
    statusHp(m, 20, 20);
    m.observe({ name: "status_update", fldidx: 17, text: "Hungry  ", condbits: 0, chg: 0, percent: 0, color: 0 });
    const a = new BotBrain().decide(m);
    expect(a.intent).toBe("eat");
    expect(a.keys).toEqual([k("e")]);
  });

  it("fights an adjacent hostile but not a floating eye", () => {
    const m = level(["@D"]);
    statusHp(m, 20, 20);
    const a = new BotBrain().decide(m);
    expect(a.intent).toBe("fight");
    expect(a.keys).toEqual([k("l")]);
    const eye = level(["@E."]);
    statusHp(eye, 20, 20);
    expect(new BotBrain().decide(eye).intent).not.toBe("fight");
  });

  it("loots when the engine announced an item underfoot", () => {
    const m = level(["@."]);
    statusHp(m, 20, 20);
    m.observe({ name: "putstr", win: 10, attr: 0, text: "You see here a long sword." });
    const a = new BotBrain().decide(m);
    expect(a.intent).toBe("loot");
    expect(a.keys).toEqual([k(",")]);
  });

  // Every phrasing look_here() can put in the message window (invent.c), and
  // the traditional-menu twin in pickup.c. Blind play and any pile_limit but
  // the default reach lines the first cut of this matcher walked straight past.
  it.each([
    "You see here a long sword.",
    "You see here 12 gold pieces.",
    "You feel here a long sword.", // blind: verb is "feel"
    "There is an object here.",
    "There is another object here.", // autopickup already took some
    "There are two objects here.",
    "There are a few objects here.",
    "There are several objects here.",
    "There are many objects here.",
    "There are several more objects here.",
  ])("loots on %j", (text) => {
    expect(lootHereMessage(text)).toBe(true);
    const m = level(["@."]);
    statusHp(m, 20, 20);
    m.observe({ name: "putstr", win: 10, attr: 0, text });
    expect(new BotBrain().decide(m).intent).toBe("loot");
  });

  // Terrain, traps and the empty tile share the announcement's shape. Picking
  // a fountain up is worse than walking past a sword.
  it.each([
    "There is a doorway here.",
    "There is a fountain here.",
    "There is a staircase down here.",
    "There is a broken door here.",
    "There is a set of iron bars here.",
    "There is an altar to Odin (lawful) here.",
    "There is a bear trap here.",
    "There is a poison gas cloud here.",
    "You see no objects here.",
    "You feel no objects here.",
  ])("does not loot on %j", (text) => {
    expect(lootHereMessage(text)).toBe(false);
    const m = level(["@."]);
    statusHp(m, 20, 20);
    m.observe({ name: "putstr", win: 10, attr: 0, text });
    expect(new BotBrain().decide(m).intent).not.toBe("loot");
  });

  it("explores toward the frontier, then descends on known stairs", () => {
    const m = level(["@..>"]);
    statusHp(m, 20, 20);
    const brain = new BotBrain();
    const a = brain.decide(m);
    expect(["explore", "descend"]).toContain(a.intent);
    expect(a.keys.length).toBe(1); // a single movement key
  });

  it("searches when there is nothing else", () => {
    // Sealed 1-cell room: no frontier (all neighbours are explored walls).
    const m = level([
      "---",
      "-@-",
      "---",
    ]);
    statusHp(m, 20, 20);
    const a = new BotBrain().decide(m);
    expect(a.intent).toBe("search");
    expect(a.keys).toEqual([k("s")]);
  });

  it("opens a closed door instead of walking into it", () => {
    const m = level(["@+."]);
    statusHp(m, 20, 20);
    const a = new BotBrain().decide(m);
    expect(a.intent).toBe("open");
    expect(a.keys).toEqual([k("o"), k("l")]);
  });

  it("kicks after a locked-door message", () => {
    const m = level(["@+."]);
    statusHp(m, 20, 20);
    const brain = new BotBrain();
    brain.decide(m); // tried to open
    m.observe({ name: "putstr", win: 10, attr: 0, text: "This door is locked." });
    const a = brain.decide(m);
    expect(a.intent).toBe("kick");
    expect(a.keys).toEqual([4, k("l")]); // Ctrl-D, direction
  });

  it("fights instead of eating when hungry and hostile is adjacent", () => {
    const m = level(["@D"]);
    statusHp(m, 20, 20);
    m.observe({ name: "status_update", fldidx: 17, text: "Hungry  ", condbits: 0, chg: 0, percent: 0, color: 0 });
    const a = new BotBrain().decide(m);
    expect(a.intent).toBe("fight"); // fight ranks higher than eat
    expect(a.keys).toEqual([k("l")]);
  });

  it("doors survive >3 stuck rounds; plain cells block after 3", () => {
    // Create a scenario where movement repeatedly fails
    const m = level(["@+D"]); // door in middle, monster beyond
    statusHp(m, 20, 20);
    const brain = new BotBrain();

    // Four decisions with the hero never moving. The door is the only way out
    // of the explored pocket, so while it is unblocked the intent stays on it.
    for (let i = 0; i < 4; i++) {
      const action = brain.decide(m);
      expect(action.intent).toMatch(/open|kick/);
      // No print_glyph for a new hero position: the stuck counter climbs.
    }

    // Three failures block a plain cell; a door gets ~12, so it survives this.
    // Blocking it would strand the hero and drop the intent to "search" —
    // which is exactly what the plain-cell half below asserts happens there.
    const afterStuck = brain.decide(m);
    expect(afterStuck.intent).toMatch(/open|kick/);

    // Now test a plain cell: create a boulder/obstacle scenario
    const m2 = level(["@."]);
    statusHp(m2, 20, 20);
    const brain2 = new BotBrain();

    // A boulder classifies as an item, so it stays passable and the ladder
    // keeps routing into it — which is the case the plain-cell counter exists
    // for. (2,2) is the hero and (3,2) the boulder, the only way out.
    m2.observe({ name: "print_glyph", win: 30, x: 2, y: 2, cell: cell("@", { glyph: 1, glyphflags: 0x1 }), bg: null });
    m2.observe({ name: "print_glyph", win: 30, x: 3, y: 2, cell: cell("*"), bg: null });

    // Same shape as the door: three decisions, the hero never moves.
    for (let i = 0; i < 3; i++) {
      expect(brain2.decide(m2).intent).toBe("explore");
    }

    // The third failure blocks (3,2). With the pocket's only route gone the
    // ladder falls all the way through to searching in place, rather than
    // ramming the boulder a fourth time.
    expect(brain2.decide(m2).intent).toBe("search");
  });

  it("targets the remembered stairs by position even when an item covers the tile", () => {
    // Fully sealed room (no frontier) so descend, not explore, is what fires.
    const m = level([
      "-----",
      "-@.>-",
      "-----",
    ]);
    statusHp(m, 20, 20);
    expect(m.stairsDown).toEqual({ x: 5, y: 3 });
    // An item lands on the stairs: the live glyph is no longer '>'.
    m.observe({ name: "print_glyph", win: 30, x: 5, y: 3, cell: cell("!", { glyph: 2400 }), bg: null });
    expect(m.map.at(5, 3).ch).toBe("!");
    const a = new BotBrain().decide(m);
    expect(a.intent).toBe("descend");
    expect(a.keys).toEqual([k("l")]);
  });

  it("rotates off a dead search spot toward the farthest reachable cell", () => {
    // Sealed corridor: no frontier, no stairs, but several cells to wander to.
    const m = level([
      "-------",
      "-@....-",
      "-------",
    ]);
    statusHp(m, 20, 20);
    const brain = new BotBrain();
    for (let i = 0; i < 10; i++) {
      const a = brain.decide(m);
      expect(a.intent).toBe("search");
    }
    const a = brain.decide(m);
    expect(a.intent).toBe("wander");
    expect(a.keys.length).toBeGreaterThan(0);
  });

  it("keeps searching in place when there is nowhere farther to wander", () => {
    // Fully sealed 1-cell room: farthestPassable has nothing to offer.
    const m = level([
      "---",
      "-@-",
      "---",
    ]);
    statusHp(m, 20, 20);
    const brain = new BotBrain();
    for (let i = 0; i < 14; i++) {
      const a = brain.decide(m);
      expect(a.intent).toBe("search");
    }
  });
});
