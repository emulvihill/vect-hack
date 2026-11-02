import { describe, expect, it } from "vitest";
import {
  LARN_COLS,
  LARN_ROWS,
  LarnClassifier,
} from "../../src/modules/larn/classifier";
import type { Cell } from "../../src/backplane/cell";
import {
  GRID,
  GRID_STRIDE,
  KIND_NAMES,
  TERRAIN,
  TOP,
} from "../../src/modules/larn/mapRecords";

/** Build one GRID_STRIDE-word record with the brief's field order. */
function rec(
  x: number,
  y: number,
  tcat: number,
  tchar: number,
  tcolor: number,
  tkind: number,
  opcat: number,
  opchar: number,
  opcolor: number,
): Int32Array {
  const words = new Int32Array(GRID_STRIDE);
  words[GRID.X] = x;
  words[GRID.Y] = y;
  words[GRID.TERRAIN_CAT] = tcat;
  words[GRID.TERRAIN_CHAR] = tchar;
  words[GRID.TERRAIN_COLOR] = tcolor;
  words[GRID.TERRAIN_KIND] = tkind;
  words[GRID.TOP_CAT] = opcat;
  words[GRID.TOP_CHAR] = opchar;
  words[GRID.TOP_COLOR] = opcolor;
  return words;
}

function one(rec: Int32Array): Cell {
  return new LarnClassifier().classify(rec)[0]!.cell;
}

describe("LarnClassifier", () => {
  it("exports the Larn dungeon dimensions", () => {
    expect(LARN_COLS).toBe(67);
    expect(LARN_ROWS).toBe(17);
    expect(new LarnClassifier()).toBeInstanceOf(LarnClassifier);
  });

  it("classifies an unseen terrain cell with no occupant", () => {
    const cell = one(
      rec(3, 4, TERRAIN.UNSEEN, " ".codePointAt(0)!, 7, 0, TOP.NONE, 0, 0),
    );
    expect(cell.category).toBe("unseen");
    expect(cell.ch).toBe(" ");
    expect(cell.color).toBe(7);
    expect(cell.kind).toBeUndefined();
    expect(cell.terrain).toBeUndefined();
    expect(cell.hero).toBeUndefined();
  });

  it("classifies a wall with no occupant", () => {
    const cell = one(
      rec(1, 2, TERRAIN.WALL, "#".codePointAt(0)!, 7, 0, TOP.NONE, 0, 0),
    );
    expect(cell.category).toBe("wall");
    expect(cell.ch).toBe("#");
    expect(cell.terrain).toBeUndefined();
  });

  it("classifies a hero on a floor", () => {
    const cell = one(
      rec(5, 6, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, TOP.HERO, "@".codePointAt(0)!, 15),
    );
    expect(cell.category).toBe("being");
    expect(cell.ch).toBe("@");
    expect(cell.color).toBe(15);
    expect(cell.hero).toBe(true);
    expect(cell.terrain).toBeDefined();
    expect(cell.terrain!.category).toBe("floor");
    expect(cell.terrain!.ch).toBe(".");
  });

  it("preserves wall terrain under a hero occupant", () => {
    const cell = one(
      rec(0, 0, TERRAIN.WALL, "#".codePointAt(0)!, 7, 0, TOP.HERO, "@".codePointAt(0)!, 15),
    );
    expect(cell.category).toBe("being");
    expect(cell.ch).toBe("@");
    expect(cell.hero).toBe(true);
    expect(cell.terrain).toBeDefined();
    expect(cell.terrain!.category).toBe("wall");
  });

  it("classifies a monster on a floor", () => {
    const cell = one(
      rec(2, 3, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, TOP.MONSTER, "B".codePointAt(0)!, 12),
    );
    expect(cell.category).toBe("being");
    expect(cell.ch).toBe("B");
    expect(cell.color).toBe(12);
    expect(cell.hero).toBeUndefined();
    expect(cell.terrain).toBeDefined();
    expect(cell.terrain!.category).toBe("floor");
  });

  it("classifies an item on a floor", () => {
    const cell = one(
      rec(8, 9, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, TOP.ITEM, "$".codePointAt(0)!, 14),
    );
    expect(cell.category).toBe("item");
    expect(cell.ch).toBe("$");
    expect(cell.color).toBe(14);
    expect(cell.terrain).toBeDefined();
    expect(cell.terrain!.category).toBe("floor");
  });

  it("maps a feature terrain kind via KIND_NAMES", () => {
    const idx = 1; // altar
    const cell = one(
      rec(4, 5, TERRAIN.FEATURE, "_".codePointAt(0)!, 7, idx, TOP.NONE, 0, 0),
    );
    expect(cell.category).toBe("feature");
    expect(cell.kind).toBe(KIND_NAMES[idx]);
    expect(cell.kind).toBe("altar");
  });

  it("leaves kind undefined for the none slot", () => {
    const cell = one(
      rec(4, 5, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, TOP.NONE, 0, 0),
    );
    expect(cell.kind).toBeUndefined();
  });

  // Fail closed: every one of these words is written from a closed switch in
  // the C tap, so an uncovered value is drift. Naming it (and the record) in
  // the notice is the whole point — a silent "unseen" would draw a wrong map.
  it("rejects an unknown terrain category, naming the value and the record", () => {
    const bad = rec(3, 4, 8, ".".codePointAt(0)!, 7, 0, TOP.NONE, 0, 0);
    expect(() => new LarnClassifier().classify(bad)).toThrowError(
      "unknown Larn terrain category 8 in the map record at (3,4)",
    );
  });

  it("rejects an unknown terrain kind, naming the value and the record", () => {
    const bad = rec(5, 6, TERRAIN.FEATURE, "_".codePointAt(0)!, 7, KIND_NAMES.length,
      TOP.NONE, 0, 0);
    expect(() => new LarnClassifier().classify(bad)).toThrowError(
      `unknown Larn terrain kind ${KIND_NAMES.length} in the map record at (5,6)`,
    );
  });

  it("rejects an unknown occupant category, naming the value and the record", () => {
    const bad = rec(7, 8, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, 4, "?".codePointAt(0)!, 7);
    expect(() => new LarnClassifier().classify(bad)).toThrowError(
      "unknown Larn occupant category 4 in the map record at (7,8)",
    );
  });

  it("rejects a non-whole-stride batch", () => {
    const bad = new Int32Array(GRID_STRIDE + 1);
    expect(() => new LarnClassifier().classify(bad)).toThrowError(
      "invalid Larn grid record batch",
    );
  });

  it("returns fresh cell objects per classify call (no aliasing)", () => {
    const r = rec(0, 0, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, TOP.HERO, "@".codePointAt(0)!, 15);
    const a = new LarnClassifier().classify(r);
    const b = new LarnClassifier().classify(r);
    expect(a[0]!.cell).not.toBe(b[0]!.cell);
    expect(a[0]!.cell.terrain).not.toBe(b[0]!.cell.terrain);
  });

  it("classifies every record in a multi-record batch", () => {
    const batch = new Int32Array(GRID_STRIDE * 3);
    batch.set(rec(0, 0, TERRAIN.WALL, "#".codePointAt(0)!, 7, 0, TOP.NONE, 0, 0), 0);
    batch.set(rec(1, 0, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, TOP.HERO, "@".codePointAt(0)!, 15), GRID_STRIDE);
    batch.set(rec(2, 0, TERRAIN.FLOOR, ".".codePointAt(0)!, 7, 0, TOP.ITEM, "$".codePointAt(0)!, 14), GRID_STRIDE * 2);
    const out = new LarnClassifier().classify(batch);
    expect(out).toHaveLength(3);
    expect(out[0]!.x).toBe(0);
    expect(out[0]!.cell.category).toBe("wall");
    expect(out[1]!.x).toBe(1);
    expect(out[1]!.cell.category).toBe("being");
    expect(out[2]!.x).toBe(2);
    expect(out[2]!.cell.category).toBe("item");
  });
});