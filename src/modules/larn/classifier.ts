// Thin classifier: a packed Int32 record batch -> Backplane Cells.
//
// Larn's native tap (larn_map_info, Task 4) has already resolved visibility
// (fog/blind/hidden-trap/see-invisible) and source-true chars (read from
// objnamelist/monstnamelist in C) before writing a record. This layer applies
// NO visibility logic and holds NO char/monster tables — it only translates
// the rendered record into a Cell. Read `src/modules/angband/classifier.ts`
// for the structural shape; Larn's is the thin version of it.
import type { Category, Cell } from "../../backplane/cell.ts";
import { GRID, GRID_STRIDE, KIND_NAMES, TOP } from "./mapRecords.ts";

export const LARN_COLS = 67;
export const LARN_ROWS = 17;

export interface ClassifiedLarnCell {
  x: number;
  y: number;
  cell: Cell;
}

/** TERRAIN_CAT word -> Category. Index order matches `TERRAIN` in mapRecords. */
const TERRAIN_CATS: Category[] = [
  "unseen",
  "floor",
  "wall",
  "door",
  "door-open",
  "stairs",
  "feature",
  "trap",
];

export class LarnClassifier {
  classify(records: Int32Array): ClassifiedLarnCell[] {
    if (records.length % GRID_STRIDE !== 0) {
      throw new Error("invalid Larn grid record batch");
    }

    const result: ClassifiedLarnCell[] = [];
    for (let offset = 0; offset < records.length; offset += GRID_STRIDE) {
      const x = records[offset + GRID.X]!;
      const y = records[offset + GRID.Y]!;
      const terrain: Cell = {
        category: fromTable(TERRAIN_CATS, records[offset + GRID.TERRAIN_CAT]!, "terrain category", x, y),
        ch: String.fromCodePoint(records[offset + GRID.TERRAIN_CHAR]!),
        color: records[offset + GRID.TERRAIN_COLOR]!,
        kind: fromTable(KIND_NAMES, records[offset + GRID.TERRAIN_KIND]!, "terrain kind", x, y) || undefined,
      };

      const top = records[offset + GRID.TOP_CAT]!;
      let cell: Cell;
      if (top === TOP.HERO) {
        cell = { category: "being", ch: "@", color: 15, hero: true, terrain };
      } else if (top === TOP.MONSTER) {
        cell = {
          category: "being",
          ch: String.fromCodePoint(records[offset + GRID.TOP_CHAR]!),
          color: records[offset + GRID.TOP_COLOR]!,
          terrain,
        };
      } else if (top === TOP.ITEM) {
        cell = {
          category: "item",
          ch: String.fromCodePoint(records[offset + GRID.TOP_CHAR]!),
          color: records[offset + GRID.TOP_COLOR]!,
          terrain,
        };
      } else if (top === TOP.NONE) {
        cell = terrain;
      } else {
        throw new Error(`unknown Larn occupant category ${top} in the map record at (${x},${y})`);
      }

      result.push({ x, y, cell });
    }
    return result;
  }
}

/** Read one native word back through the fixed table that wrote it. Every one
 *  of these words comes from a switch over a closed set in the C tap
 *  (terrain_identity and the KIND_* mirrors, src/modules/larn/native/main-wasm.c),
 *  so a value the table does not cover is shim or decoder drift, never data:
 *  the tolerant "unseen"/undefined this replaces would keep drawing a silently
 *  wrong map. Failing closed here surfaces instead as a player-facing notice
 *  naming the record — a map event owes the engine no reply, so the Backplane's
 *  dispatch guard reports it and play continues (src/backplane/session.ts). */
function fromTable<T>(table: readonly T[], word: number, what: string, x: number, y: number): T {
  const value = table[word];
  if (value === undefined) {
    throw new Error(`unknown Larn ${what} ${word} in the map record at (${x},${y})`);
  }
  return value;
}
