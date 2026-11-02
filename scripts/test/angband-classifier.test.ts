import { describe, expect, it } from "vitest";
import {
  ANGBAND_COLS,
  ANGBAND_ROWS,
  AngbandClassifier,
} from "../../src/modules/angband/classifier";
import type { Category, Cell } from "../../src/backplane/cell";
import { GRID, GRID_FLAG, GRID_STRIDE } from "../../src/modules/angband/mapRecords";
import type { AngbandEvent } from "../../src/modules/angband/protocol";

interface RecordFields {
  x?: number; y?: number; feature?: number; flags?: number; lighting?: number;
  topColor?: number; topRgb?: number; topChar?: number;
  terrainColor?: number; terrainRgb?: number; terrainChar?: number;
  trapColor?: number; trapRgb?: number; trapChar?: number; trapKind?: number;
}

function record(fields: RecordFields = {}): Int32Array {
  const words = new Int32Array(GRID_STRIDE);
  words[GRID.X] = fields.x ?? 4;
  words[GRID.Y] = fields.y ?? 7;
  words[GRID.FEATURE] = fields.feature ?? 1;
  words[GRID.FLAGS] = fields.flags ?? 0;
  words[GRID.LIGHTING] = fields.lighting ?? 2;
  words[GRID.TOP_COLOR] = fields.topColor ?? 12;
  words[GRID.TOP_RGB] = fields.topRgb ?? 0xa1b2c3;
  words[GRID.TOP_CHAR] = fields.topChar ?? "o".codePointAt(0)!;
  words[GRID.TERRAIN_COLOR] = fields.terrainColor ?? 6;
  words[GRID.TERRAIN_RGB] = fields.terrainRgb ?? 0x123456;
  words[GRID.TERRAIN_CHAR] = fields.terrainChar ?? ".".codePointAt(0)!;
  words[GRID.TRAP_COLOR] = fields.trapColor ?? 0;
  words[GRID.TRAP_RGB] = fields.trapRgb ?? 0;
  words[GRID.TRAP_CHAR] = fields.trapChar ?? 0;
  words[GRID.TRAP_KIND] = fields.trapKind ?? 0;
  return words;
}

function cell(fields: RecordFields = {}): Cell {
  return new AngbandClassifier().classify(record(fields))[0]!.cell;
}

describe("AngbandClassifier", () => {
  it("exports the maximum Angband dungeon dimensions", () => {
    expect(ANGBAND_COLS).toBe(198);
    expect(ANGBAND_ROWS).toBe(66);
  });

  it("maps every pinned terrain feature id by semantics", () => {
    const expected: Array<[number, Category, string | undefined]> = [
      [0, "unseen", undefined], [1, "floor", undefined],
      [2, "door", undefined], [3, "door-open", undefined],
      [4, "door-open", "broken"], [5, "stairs", "up"],
      [6, "stairs", "down"],
      ...Array.from({ length: 8 }, (_, i) => [7 + i, "feature", "store"] as [number, Category, string]),
      [15, "wall", undefined], [16, "feature", "rubble"],
      [17, "wall", "mineral-vein"], [18, "wall", "mineral-vein"],
      [19, "wall", "mineral-vein"], [20, "wall", "mineral-vein"],
      [21, "wall", undefined], [22, "wall", "permanent"],
      [23, "lava", undefined], [24, "feature", "rubble"],
    ];

    for (const [feature, category, kind] of expected) {
      expect(cell({ feature })).toEqual({
        category, kind, ch: ".", color: 6, rgb: 0x123456,
      });
    }
  });

  it("classifies unknown feature ids as unseen without guessing", () => {
    expect(cell({ feature: 25 }).category).toBe("unseen");
    expect(cell({ feature: -1 }).category).toBe("unseen");
  });

  it("uses a visible trap as the cell and carries its pinned short-name kind", () => {
    expect(cell({ trapChar: "^".codePointAt(0), trapColor: 3, trapRgb: 0xabcdef, trapKind: 39 }))
      .toEqual({ category: "trap", kind: "petrifying trap", ch: "^", color: 3, rgb: 0xabcdef });
    expect(cell({ trapChar: ";".codePointAt(0), trapKind: 1 }).kind).toBe("glyph of warding");
    expect(cell({ trapChar: "^".codePointAt(0), trapKind: 99 }).kind).toBe("trap-99");
  });

  it("does not infer a visible trap from trap kind alone", () => {
    expect(cell({ trapChar: 0, trapKind: 39 }).category).toBe("floor");
  });

  it("puts the visible trap beneath an occupant instead of the feature", () => {
    expect(cell({ flags: GRID_FLAG.MONSTER, topChar: "D".codePointAt(0), trapChar: "^".codePointAt(0), trapKind: 5 }))
      .toEqual({
        category: "being", ch: "D", color: 12, rgb: 0xa1b2c3,
        terrain: { category: "trap", kind: "trap door", ch: "^", color: 0, rgb: 0 },
      });
  });

  it("marks the player as the hero and gives player priority over every other flag", () => {
    const flags = GRID_FLAG.PLAYER | GRID_FLAG.MONSTER | GRID_FLAG.OBJECT;
    expect(cell({ flags, topChar: "@".codePointAt(0) })).toEqual({
      category: "being", ch: "@", color: 12, rgb: 0xa1b2c3, hero: true,
      terrain: { category: "floor", kind: undefined, ch: ".", color: 6, rgb: 0x123456 },
    });
  });

  it("gives a monster priority over an object", () => {
    expect(cell({ flags: GRID_FLAG.MONSTER | GRID_FLAG.PILE }).category).toBe("being");
  });

  it.each([
    ["pile", GRID_FLAG.PILE], ["object", GRID_FLAG.OBJECT],
    ["unseen object", GRID_FLAG.UNSEEN_OBJECT], ["unseen money", GRID_FLAG.UNSEEN_MONEY],
  ])("classifies the %s flag as an item", (_name, flag) => {
    expect(cell({ flags: flag })).toMatchObject({ category: "item" });
  });

  it("passes folded VGA colors and RGB values through without translation", () => {
    expect(cell({ flags: GRID_FLAG.OBJECT, topColor: 15, topRgb: 0xfedcba, terrainColor: 13, terrainRgb: 0x010203 }))
      .toMatchObject({ color: 15, rgb: 0xfedcba, terrain: { color: 13, rgb: 0x010203 } });
  });

  it("decodes code-point words, including astral characters", () => {
    expect(cell({ flags: GRID_FLAG.MONSTER, topChar: 0x1f409 }).ch).toBe("🐉");
  });

  it("returns fresh result, cell, and underlay objects on every call", () => {
    const classifier = new AngbandClassifier();
    const records = record({ flags: GRID_FLAG.OBJECT });
    const first = classifier.classify(records);
    const second = classifier.classify(records);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]!.cell).not.toBe(second[0]!.cell);
    expect(first[0]!.cell.terrain).not.toBe(second[0]!.cell.terrain);
    expect(first[0]).toMatchObject({ x: 4, y: 7 });
  });

  it("advances by one stride across distinct records", () => {
    const records = Int32Array.from([
      ...record({ x: 2, y: 3, feature: 2, terrainChar: "+".codePointAt(0) }),
      ...record({ x: 17, y: 19, flags: GRID_FLAG.MONSTER, topChar: "T".codePointAt(0) }),
    ]);

    expect(new AngbandClassifier().classify(records)).toEqual([
      {
        x: 2,
        y: 3,
        cell: { category: "door", kind: undefined, ch: "+", color: 6, rgb: 0x123456 },
      },
      {
        x: 17,
        y: 19,
        cell: {
          category: "being", ch: "T", color: 12, rgb: 0xa1b2c3,
          terrain: { category: "floor", kind: undefined, ch: ".", color: 6, rgb: 0x123456 },
        },
      },
    ]);
  });

  it("rejects a batch whose length is not a whole packed record", () => {
    expect(() => new AngbandClassifier().classify(new Int32Array(GRID_STRIDE - 1)))
      .toThrowError("invalid Angband grid record batch");
  });

});

/**
 * The worker protocol keeps the semantic events beside the tty ones — pinned
 * at COMPILE time, deliberately not by a vitest assertion. tsc is the only
 * gate that can fail here: a name added to the AngbandEvent union is a
 * missing key below, a name removed is an excess one, and each literal in
 * SEMANTIC_EVENTS must still satisfy its member's field shape.
 *
 * vect-hack-8r0: this used to be an it() whose expect compared the array's
 * own `name`s to the same literals two lines above — both sides the test's
 * own data, so no production change could ever fail it.
 */
const EVENT_KINDS: Record<AngbandEvent["name"], "tty" | "semantic"> = {
  text: "tty", wipe: "tty", curs: "tty", clear: "tty", flush: "tty",
  map: "semantic", level: "semantic", message: "semantic",
  overlay: "semantic", effect: "semantic",
};

const SEMANTIC_EVENTS: AngbandEvent[] = [
  { name: "map", records: record() },
  { name: "level", width: 80, height: 24 },
  { name: "message", text: "hello", messageType: 7 },
  { name: "overlay", active: true },
  { name: "effect", x: 1, y: 2, ch: "*", color: 4, rgb: 0xff0000, beam: false },
];

void EVENT_KINDS;
void SEMANTIC_EVENTS;
