import { describe, expect, it } from "vitest";
import type { Category, Cell } from "../../src/backplane/cell";
import {
  MORIA_COLS,
  MORIA_ROWS,
  MoriaClassifier,
} from "../../src/modules/moria/classifier";
import {
  GRID,
  GRID_STRIDE,
  KIND_NAMES,
  TERRAIN,
  TOP,
} from "../../src/modules/moria/mapRecords";

interface Fields {
  x?: number;
  y?: number;
  terrainCat?: number;
  terrainKind?: number;
  terrainChar?: number;
  topCat?: number;
  topChar?: number;
}

function record(fields: Fields = {}): Int32Array {
  const words = new Int32Array(GRID_STRIDE);
  words[GRID.X] = fields.x ?? 4;
  words[GRID.Y] = fields.y ?? 7;
  words[GRID.TERRAIN_CAT] = fields.terrainCat ?? TERRAIN.FLOOR;
  words[GRID.TERRAIN_KIND] = fields.terrainKind ?? 1;
  words[GRID.TERRAIN_CHAR] = fields.terrainChar ?? ".".codePointAt(0)!;
  words[GRID.TOP_CAT] = fields.topCat ?? TOP.NONE;
  words[GRID.TOP_CHAR] = fields.topChar ?? 0;
  return words;
}

function cell(fields: Fields = {}): Cell {
  return new MoriaClassifier().classify(record(fields))[0]!.cell;
}

describe("MoriaClassifier", () => {
  it("exports the pinned maximum Umoria dungeon dimensions", () => {
    expect(MORIA_COLS).toBe(198);
    expect(MORIA_ROWS).toBe(66);
  });

  it("maps every public terrain category to Backplane semantics and logical ANSI color", () => {
    const cases: Array<[number, Category, number, string]> = [
      [TERRAIN.UNSEEN, "unseen", 7, " "],
      [TERRAIN.FLOOR, "floor", 7, "."],
      [TERRAIN.CORRIDOR, "corridor", 7, "."],
      [TERRAIN.WALL, "wall", 6, "#"],
      [TERRAIN.DOOR, "door", 3, "+"],
      [TERRAIN.DOOR_OPEN, "door-open", 3, "'"],
      [TERRAIN.STAIRS, "stairs", 15, "<"],
      [TERRAIN.TRAP, "trap", 1, "^"],
      [TERRAIN.FEATURE, "feature", 5, ":"],
    ];

    for (const [terrainCat, category, color, ch] of cases) {
      expect(cell({ terrainCat, terrainChar: ch.codePointAt(0) })).toMatchObject({
        category, color, ch,
      });
    }
  });

  it("uses the append-only public kind table without inventing unknown identities", () => {
    for (let terrainKind = 0; terrainKind < KIND_NAMES.length; terrainKind++) {
      expect(cell({ terrainKind }).kind).toBe(KIND_NAMES[terrainKind] || undefined);
    }
    expect(cell({ terrainKind: KIND_NAMES.length + 20 }).kind).toBeUndefined();
    expect(cell({ terrainKind: -1 }).kind).toBeUndefined();
  });

  it("preserves known terrain beneath hero, monster, and item cells", () => {
    expect(cell({ topCat: TOP.HERO, topChar: 64 })).toEqual({
      category: "being", ch: "@", color: 15, hero: true,
      terrain: { category: "floor", kind: "floor", ch: ".", color: 7 },
    });
    expect(cell({ topCat: TOP.MONSTER, topChar: 111 })).toEqual({
      category: "being", ch: "o", color: 1,
      terrain: { category: "floor", kind: "floor", ch: ".", color: 7 },
    });
    expect(cell({ topCat: TOP.ITEM, topChar: 33 })).toEqual({
      category: "item", ch: "!", color: 11,
      terrain: { category: "floor", kind: "floor", ch: ".", color: 7 },
    });
  });

  it("does not fabricate an underlay for the blind or hallucinating hero", () => {
    expect(cell({ terrainCat: TERRAIN.UNSEEN, topCat: TOP.HERO, topChar: 64 }))
      .toEqual({ category: "being", ch: "@", color: 15, hero: true });
  });

  it("degrades unknown presentation categories without displaying their characters", () => {
    expect(cell({ terrainCat: 900, terrainChar: "S".codePointAt(0)!, topCat: 800, topChar: 77 }))
      .toEqual({ category: "unseen", ch: " ", color: 7 });
  });

  it("returns fresh cell and terrain objects for every packed record", () => {
    const records = Int32Array.from([
      ...record({ x: 2, y: 3, topCat: TOP.ITEM, topChar: 63 }),
      ...record({ x: 17, y: 19, terrainCat: TERRAIN.WALL, terrainKind: 3, terrainChar: 35 }),
    ]);
    const first = new MoriaClassifier().classify(records);
    const second = new MoriaClassifier().classify(records);
    expect(first).toEqual([
      {
        x: 2, y: 3,
        cell: {
          category: "item", ch: "?", color: 11,
          terrain: { category: "floor", kind: "floor", ch: ".", color: 7 },
        },
      },
      { x: 17, y: 19, cell: { category: "wall", kind: "wall", ch: "#", color: 6 } },
    ]);
    expect(first).not.toBe(second);
    expect(first[0]!.cell).not.toBe(second[0]!.cell);
    expect(first[0]!.cell.terrain).not.toBe(second[0]!.cell.terrain);
  });

  it("rejects malformed strides and coordinates before classification", () => {
    const classifier = new MoriaClassifier();
    expect(() => classifier.classify(new Int32Array(GRID_STRIDE - 1)))
      .toThrowError("invalid Moria grid record batch");
    expect(() => classifier.classify(record({ x: -1 }))).toThrowError("outside Moria grid bounds");
    expect(() => classifier.classify(record({ x: MORIA_COLS })))
      .toThrowError("outside Moria grid bounds");
    expect(() => classifier.classify(record({ y: MORIA_ROWS })))
      .toThrowError("outside Moria grid bounds");
  });
});
