import type { Category, Cell } from "../../backplane/cell";
import { GRID, GRID_FLAG, GRID_STRIDE } from "./mapRecords";

export const ANGBAND_COLS = 198;
export const ANGBAND_ROWS = 66;

export interface ClassifiedAngbandCell {
  x: number;
  y: number;
  cell: Cell;
}

const ITEM_FLAGS = GRID_FLAG.PILE | GRID_FLAG.OBJECT
  | GRID_FLAG.UNSEEN_OBJECT | GRID_FLAG.UNSEEN_MONEY;

/** trap.txt order from the pinned Angband 4.2.6 data. */
const TRAP_KINDS = [
  "no trap",
  "glyph of warding",
  "decoy",
  "door lock",
  "web",
  "trap door",
  "pit",
  "spiked pit",
  "poison pit",
  "rune of summon foe",
  "rune of summoning",
  "rune of necromancy",
  "rune of dragonsong",
  "hellhole",
  "teleport rune",
  "fire trap",
  "acid trap",
  "slow dart",
  "strength loss dart",
  "dexterity loss dart",
  "constitution loss dart",
  "blinding gas trap",
  "confusion gas trap",
  "poison gas trap",
  "sleep gas trap",
  "aggravation trap",
  "siren",
  "mine trap",
  "blast trap",
  "mind blasting trap",
  "brain smashing trap",
  "rock fall trap",
  "earthquake trap",
  "block fall trap",
  "area blast trap",
  "blinding flash trap",
  "blinding trap",
  "mana drain trap",
  "knife trap",
  "petrifying trap",
] as const;

export class AngbandClassifier {
  classify(records: Int32Array): ClassifiedAngbandCell[] {
    if (records.length % GRID_STRIDE !== 0) {
      throw new Error("invalid Angband grid record batch");
    }

    const result: ClassifiedAngbandCell[] = [];
    for (let offset = 0; offset < records.length; offset += GRID_STRIDE) {
      const flags = records[offset + GRID.FLAGS]!;
      const feature = terrainCell(records, offset);
      const trap = records[offset + GRID.TRAP_CHAR] !== 0
        ? trapCell(records, offset)
        : null;
      const terrain = trap ?? feature;
      let cell = terrain;

      if ((flags & ITEM_FLAGS) !== 0) cell = topCell("item", records, offset, terrain);
      if ((flags & GRID_FLAG.MONSTER) !== 0) cell = topCell("being", records, offset, terrain);
      if ((flags & GRID_FLAG.PLAYER) !== 0) {
        cell = { ...topCell("being", records, offset, terrain), hero: true };
      }

      result.push({
        x: records[offset + GRID.X]!,
        y: records[offset + GRID.Y]!,
        cell,
      });
    }
    return result;
  }
}

function terrainCell(records: Int32Array, offset: number): Cell {
  const [category, kind] = featureIdentity(records[offset + GRID.FEATURE]!);
  return {
    category,
    kind,
    ch: String.fromCodePoint(records[offset + GRID.TERRAIN_CHAR]!),
    color: records[offset + GRID.TERRAIN_COLOR]!,
    rgb: records[offset + GRID.TERRAIN_RGB]!,
  };
}

function trapCell(records: Int32Array, offset: number): Cell {
  const id = records[offset + GRID.TRAP_KIND]!;
  return {
    category: "trap",
    kind: TRAP_KINDS[id] ?? `trap-${id}`,
    ch: String.fromCodePoint(records[offset + GRID.TRAP_CHAR]!),
    color: records[offset + GRID.TRAP_COLOR]!,
    rgb: records[offset + GRID.TRAP_RGB]!,
  };
}

function topCell(category: "being" | "item", records: Int32Array, offset: number, terrain: Cell): Cell {
  return {
    category,
    ch: String.fromCodePoint(records[offset + GRID.TOP_CHAR]!),
    color: records[offset + GRID.TOP_COLOR]!,
    rgb: records[offset + GRID.TOP_RGB]!,
    terrain,
  };
}

function featureIdentity(feature: number): [Category, string | undefined] {
  switch (feature) {
    case 0: return ["unseen", undefined];
    case 1: return ["floor", undefined];
    case 2: return ["door", undefined];
    case 3: return ["door-open", undefined];
    case 4: return ["door-open", "broken"];
    case 5: return ["stairs", "up"];
    case 6: return ["stairs", "down"];
    case 7: case 8: case 9: case 10: case 11: case 12: case 13: case 14:
      return ["feature", "store"];
    case 15: return ["wall", undefined];
    case 16: case 24: return ["feature", "rubble"];
    case 17: case 18: case 19: case 20: return ["wall", "mineral-vein"];
    case 21: return ["wall", undefined];
    case 22: return ["wall", "permanent"];
    case 23: return ["lava", undefined];
    default: return ["unseen", undefined];
  }
}
