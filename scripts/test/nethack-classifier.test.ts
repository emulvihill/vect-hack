// The NetHack Classifier: the glyph-number/char/color classification that
// lived inside MapModel, now emitting Backplane Cells. Same glyph fixtures
// as the old dungeon-model.test.ts assertions — this suite pins that the
// split changed NO classification (backplane design: the one forbidden
// behavioral delta).
import { describe, expect, it } from "vitest";
import type { GlyphCell } from "../../src/modules/nethack/protocol";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";

// Stand-in for the GLYPH_*_OFF values libnhmain exports; only the ordering
// and the relative gaps matter to the classifier.
const GLYPH_CONSTANTS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};

const cell = (glyph: number, ch: string, color = 7, glyphflags = 0): GlyphCell =>
  ({ glyph, ch, color, glyphflags });

const TERRAIN = 610, OBJECT = 520, MONSTER = 12, PET = 101, ZAP = 710,
  EXPLODE = 810, WARNING = 905, STATUE = 915, UNEXPLORED = 1500;

function clf(): NetHackClassifier {
  const c = new NetHackClassifier();
  c.configure(GLYPH_CONSTANTS);
  return c;
}

describe("NetHackClassifier", () => {
  it("classifies by glyph range, not by character", () => {
    const c = clf();
    expect(c.classify(cell(TERRAIN, "-")).category).toBe("wall");
    expect(c.classify(cell(OBJECT, "-")).category).toBe("item");   // a wand also draws as '-'
    expect(c.classify(cell(MONSTER, "d")).category).toBe("being");
    expect(c.classify(cell(WARNING, "5")).category).toBe("being"); // warnings track monsters
    expect(c.classify(cell(STATUE, "o")).category).toBe("item");
    expect(c.classify(cell(305, "%")).category).toBe("item");      // corpse (body range)
    expect(c.classify(cell(400, "%")).category).toBe("item");      // body range, last glyph
    // [ridden, obj), which starts at GLYPH_RIDDEN_OFF: a steed being ridden
    // is still a monster, and reading one as an item would draw the thing
    // you are sitting on as loot.
    expect(c.classify(cell(401, "u")).category).toBe("being");     // ridden steed
    expect(c.classify(cell(ZAP, "|")).category).toBe("effect");
    expect(c.classify(cell(EXPLODE, "*")).category).toBe("effect");
    expect(c.classify(cell(UNEXPLORED, " ")).category).toBe("unseen");
  });

  it("flags the zap range as beam and leaves explosions unflagged", () => {
    const c = clf();
    expect(c.classify(cell(ZAP, "|")).beam).toBe(true);
    expect(c.classify(cell(EXPLODE, "*")).beam).toBeUndefined();
    expect(c.classify(cell(TERRAIN, ".")).beam).toBeUndefined();
  });

  it("splits terrain into Categories by tty char, exactly as terrainKind did", () => {
    const c = clf();
    const cat = (ch: string, color = 7) => c.classify(cell(TERRAIN, ch, color)).category;
    expect(cat("|")).toBe("wall");
    expect(cat("-")).toBe("wall");
    expect(cat("|", 3)).toBe("door-open");   // NetHack tints open doors brown
    expect(cat(".")).toBe("floor");
    expect(cat("#")).toBe("corridor");
    expect(cat("+")).toBe("door");
    expect(cat("<")).toBe("stairs");
    expect(cat(">")).toBe("stairs");
    expect(cat("}", 4)).toBe("water");       // CLR_BLUE
    expect(cat("}", 12)).toBe("water");      // CLR_BRIGHT_BLUE
    expect(cat("}", 1)).toBe("lava");        // CLR_RED
    expect(cat("}", 9)).toBe("lava");        // CLR_ORANGE
    expect(cat("^")).toBe("trap");
    expect(cat("\"", 7)).toBe("trap");       // web
    expect(cat("~", 5)).toBe("trap");        // vibrating square
    expect(cat("`", 7)).toBe("feature");     // engraving keeps its treatment
    expect(cat("_")).toBe("feature");        // altar
    // Dark stone: was category "terrain" + kind "none" (drawn as nothing);
    // now classified straight to "unseen" — the same nothing (plan
    // deviation #3).
    expect(cat(" ")).toBe("unseen");
  });

  it("hero/pet hints replace the MG flag words and the pet glyph range", () => {
    const c = clf();
    const h = c.classify(cell(MONSTER, "@", 15, MG.HERO));
    expect(h.category).toBe("being");
    expect(h.hero).toBe(true);
    expect(c.classify(cell(MONSTER, "d", 7, MG.PET)).pet).toBe(true);  // flagged pet
    expect(c.classify(cell(PET, "d")).pet).toBe(true);                 // pet glyph range
    expect(c.classify(cell(MONSTER, "d")).pet).toBeUndefined();
    expect(c.classify(cell(MONSTER, "d")).hero).toBeUndefined();
  });

  // The CellGrid takes ownership of what it is handed and keeps the displaced
  // Cell as the under-stash, so a reused scratch object would rewrite the
  // stash on the very next glyph (classifier.ts's classify doc comment).
  it("returns a fresh Cell every call, never a cached one", () => {
    const c = clf();
    const g = cell(MONSTER, "d");
    expect(c.classify(g)).not.toBe(c.classify(g));
  });

  it("carries ch and color through untouched", () => {
    const got = clf().classify(cell(MONSTER, "d", 3));
    expect(got.ch).toBe("d");
    expect(got.color).toBe(3);
  });

  it("maps everything to unseen before configure()", () => {
    const c = new NetHackClassifier();
    expect(c.classify(cell(TERRAIN, ".")).category).toBe("unseen");
  });

  it("exports NetHack's grid dimensions for the Module's views", () => {
    expect(NETHACK_COLS).toBe(80);
    expect(NETHACK_ROWS).toBe(21);
  });
});
