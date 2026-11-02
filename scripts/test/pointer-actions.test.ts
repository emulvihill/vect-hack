// Pointer-driven contextual actions (vect-hack-be3.3), driven off a synthetic
// map the same way dungeon-model.test.ts drives the builders — fast,
// deterministic, no engine needed for logic this pure.
import { describe, expect, it } from "vitest";
import { CellGrid } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import { CLR } from "../../src/backplane/colors";
import type { GlyphCell } from "../../src/modules/nethack/protocol";
import {
  ACTION_LABEL, applicableActions, primaryAction, targetAt, heroActions, itemHereMessage,
} from "../../src/modules/nethack/ui/pointerActions";
import { key } from "../../src/modules/nethack/ui/keys";

// Same stand-in offsets as dungeon-model.test.ts; only the ordering and gaps
// matter to the classifier.
const GLYPH_CONSTANTS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};

const cell = (glyph: number, ch: string, color = 7, glyphflags = 0): GlyphCell =>
  ({ glyph, ch, color, glyphflags });

const MONSTER = 12, TERRAIN = 610, OBJECT = 550;
const HERO_AT = { x: 10, y: 10 } as const;

const clf = new NetHackClassifier();
clf.configure(GLYPH_CONSTANTS);

const put = (m: CellGrid, x: number, y: number, g: GlyphCell) =>
  m.set(x, y, clf.classify(g));

/** Hero at (10,10); everything else is placed relative to that. */
function model(): CellGrid {
  const m = new CellGrid(NETHACK_COLS, NETHACK_ROWS);
  put(m, HERO_AT.x, HERO_AT.y, cell(MONSTER, "@", 15, MG.HERO));
  return m;
}

describe("targetAt", () => {
  it("is null before the hero's position is known", () => {
    const m = new CellGrid(NETHACK_COLS, NETHACK_ROWS);
    put(m, 11, 10, cell(MONSTER, "d"));
    expect(targetAt(m, 11, 10)).toBeNull();
  });

  it("is null for a cell nothing has ever been drawn into", () => {
    expect(targetAt(model(), 40, 15)).toBeNull();
  });

  it("names the direction from the hero, or null out of the eight neighbours", () => {
    const m = model();
    put(m, 11, 10, cell(MONSTER, "d")); // east
    put(m, 10, 9, cell(MONSTER, "f"));  // north
    put(m, 15, 15, cell(MONSTER, "d")); // far away
    expect(targetAt(m, 11, 10)!.dir).toBe(2); // DIRECTIONS[2] === "l", east
    expect(targetAt(m, 10, 9)!.dir).toBe(0);  // DIRECTIONS[0] === "k", north
    expect(targetAt(m, 15, 15)!.dir).toBeNull();
  });

  it("flags the hero's own cell", () => {
    const t = targetAt(model(), HERO_AT.x, HERO_AT.y)!;
    expect(t.isHero).toBe(true);
    expect(t.dir).toBeNull(); // dx=dy=0 isn't one of the eight neighbours either
  });
});

describe("primaryAction", () => {
  it("attacks an adjacent hostile monster and nothing else", () => {
    const m = model();
    put(m, 11, 10, cell(MONSTER, "d")); // east, hostile by default (see isHostile)
    expect(primaryAction(targetAt(m, 11, 10)!)).toBe("attack");
  });

  it("never treats a pet as an attack target", () => {
    const m = model();
    put(m, 10, 9, cell(MONSTER, "f", 7, MG.PET)); // north
    expect(primaryAction(targetAt(m, 10, 9)!)).toBeUndefined();
  });

  it("never treats the hero's own cell as an attack target", () => {
    expect(primaryAction(targetAt(model(), HERO_AT.x, HERO_AT.y)!)).toBeUndefined();
  });

  it("has no primary action for a target out of reach — no pathfinding", () => {
    const m = model();
    put(m, 15, 15, cell(MONSTER, "d"));
    expect(primaryAction(targetAt(m, 15, 15)!)).toBeUndefined();
  });

  // be3.3's design reserved this row explicitly: a closed door's one obvious
  // verb is "open it", and it is the second and last PRIMARY_TABLE entry.
  it("opens a closed door on a left click", () => {
    const m = model();
    put(m, 9, 10, cell(TERRAIN, "+")); // west
    expect(primaryAction(targetAt(m, 9, 10)!)).toBe("open");
  });

  it("has no primary action for a target with no single obvious verb (a wall)", () => {
    const m = model();
    put(m, 9, 10, cell(TERRAIN, "|")); // west
    expect(primaryAction(targetAt(m, 9, 10)!)).toBeUndefined();
  });
});

describe("applicableActions", () => {
  it("offers attack, chat and kick for a non-pet monster", () => {
    const m = model();
    put(m, 11, 10, cell(MONSTER, "d"));
    expect(applicableActions(targetAt(m, 11, 10)!)).toEqual(["attack", "chat", "kick"]);
  });

  it("drops attack for a pet, even though it's still a valid chat target", () => {
    const m = model();
    put(m, 10, 9, cell(MONSTER, "f", 7, MG.PET));
    expect(applicableActions(targetAt(m, 10, 9)!)).toEqual(["chat"]);
  });

  it("offers open, kick and apply for a closed door", () => {
    const m = model();
    put(m, 9, 10, cell(TERRAIN, "+"));
    expect(applicableActions(targetAt(m, 9, 10)!)).toEqual(["open", "kick", "apply"]);
  });

  it("offers nothing for the hero's own cell", () => {
    expect(applicableActions(targetAt(model(), HERO_AT.x, HERO_AT.y)!)).toEqual([]);
  });

  it("offers nothing out of the eight neighbours — no pathfinding", () => {
    const m = model();
    put(m, 15, 15, cell(MONSTER, "d"));
    expect(applicableActions(targetAt(m, 15, 15)!)).toEqual([]);
  });

  it("offers close, kick and apply for an open door", () => {
    const m = model();
    // Open doors reuse the wall symbols and are told apart by NetHack's
    // brown tint — the same rule the Classifier applies.
    put(m, 11, 10, cell(TERRAIN, "-", CLR.BROWN));
    expect(applicableActions(targetAt(m, 11, 10)!)).toEqual(["close", "kick", "apply"]);
  });

  it("offers search against a wall — the reason a player suspects a hidden door", () => {
    const m = model();
    put(m, 10, 9, cell(TERRAIN, "|"));
    expect(applicableActions(targetAt(m, 10, 9)!)).toEqual(["search"]);
  });

  it("offers untrap on a trap", () => {
    const m = model();
    put(m, 10, 11, cell(TERRAIN, "^"));
    expect(applicableActions(targetAt(m, 10, 11)!)).toEqual(["untrap"]);
  });

  it("offers a kick to an adjacent object or dungeon feature — boxes, sinks, thrones", () => {
    const m = model();
    put(m, 11, 11, cell(OBJECT, "("));     // a tool, e.g. a chest
    put(m, 9, 9, cell(TERRAIN, "{"));      // a fountain, Category "feature"
    expect(applicableActions(targetAt(m, 11, 11)!)).toEqual(["kick"]);
    expect(applicableActions(targetAt(m, 9, 9)!)).toEqual(["kick"]);
  });

  it("offers nothing on terrain a kick would only waste a turn on", () => {
    const m = model();
    put(m, 11, 9, cell(TERRAIN, "."));   // floor
    put(m, 9, 11, cell(TERRAIN, "#"));   // corridor
    put(m, 11, 10, cell(TERRAIN, ">"));  // stairs
    expect(applicableActions(targetAt(m, 11, 9)!)).toEqual([]);
    expect(applicableActions(targetAt(m, 9, 11)!)).toEqual([]);
    expect(applicableActions(targetAt(m, 11, 10)!)).toEqual([]);
  });

  it("never offers a pet a kick, only a chat", () => {
    const m = model();
    put(m, 10, 9, cell(MONSTER, "f", 7, MG.PET));
    expect(applicableActions(targetAt(m, 10, 9)!)).toEqual(["chat"]);
  });

  it("has a menu label for every action it can offer", () => {
    const m = model();
    put(m, 11, 10, cell(MONSTER, "d"));            // attack, chat, kick
    put(m, 9, 10, cell(TERRAIN, "+"));             // open, kick, apply
    put(m, 10, 9, cell(TERRAIN, "-", CLR.BROWN));  // close, kick, apply
    put(m, 10, 11, cell(TERRAIN, "|"));            // search
    put(m, 11, 11, cell(TERRAIN, "^"));            // untrap
    const offered = new Set([
      ...applicableActions(targetAt(m, 11, 10)!),
      ...applicableActions(targetAt(m, 9, 10)!),
      ...applicableActions(targetAt(m, 10, 9)!),
      ...applicableActions(targetAt(m, 10, 11)!),
      ...applicableActions(targetAt(m, 11, 11)!),
    ]);
    // Every MenuAction there is, so a new table row cannot ship unlabelled.
    expect(offered).toEqual(new Set(Object.keys(ACTION_LABEL)));
    for (const a of offered) expect(ACTION_LABEL[a]).toBeTruthy();
  });
});

describe("heroActions", () => {
  it("always offers Pick up and Look here, in that order", () => {
    expect(heroActions(null).map((r) => r.label)).toEqual(["Pick up", "Look here"]);
    expect(heroActions(null).map((r) => r.code)).toEqual([key(","), key(":")]);
  });

  it("adds only the matching stairs row for the stashed staircase", () => {
    const upstair = { category: "stairs", ch: "<", color: 7 } as const;
    const downstair = { category: "stairs", ch: ">", color: 7 } as const;
    expect(heroActions(upstair).map((r) => r.label))
      .toEqual(["Pick up", "Look here", "Go up stairs"]);
    expect(heroActions(downstair).map((r) => r.label))
      .toEqual(["Pick up", "Look here", "Go down stairs"]);
    expect(heroActions(upstair).at(-1)!.code).toBe(key("<"));
    expect(heroActions(downstair).at(-1)!.code).toBe(key(">"));
  });

  it("offers no stairs row on plain floor", () => {
    expect(heroActions({ category: "floor", ch: ".", color: 7 })).toHaveLength(2);
  });
});

describe("itemHereMessage", () => {
  it("matches the single-item and pile announcements", () => {
    expect(itemHereMessage("You see here a long sword.")).toBe(true);
    expect(itemHereMessage("There are several objects here.")).toBe(true);
    expect(itemHereMessage("There are many objects here.")).toBe(true);
  });

  it("ignores feature announcements and everything else", () => {
    expect(itemHereMessage("There is a staircase up here.")).toBe(false);
    expect(itemHereMessage("There is a doorway here.")).toBe(false);
    expect(itemHereMessage("You see a door in the distance.")).toBe(false);
    expect(itemHereMessage("")).toBe(false);
  });
});
