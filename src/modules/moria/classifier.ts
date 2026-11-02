import { TERRAIN_CATEGORIES, type Category, type Cell } from "../../backplane/cell";
import { CLR } from "../../backplane/colors";
import {
  GRID,
  GRID_STRIDE,
  KIND_NAMES,
  MORIA_MAX_COLS,
  MORIA_MAX_ROWS,
  TERRAIN,
  TOP,
} from "./mapRecords";

export const MORIA_COLS = MORIA_MAX_COLS;
export const MORIA_ROWS = MORIA_MAX_ROWS;

export interface ClassifiedMoriaCell {
  x: number;
  y: number;
  cell: Cell;
}

interface TerrainPresentation { category: Category; color: number }

const TERRAIN_PRESENTATION: Readonly<Record<number, TerrainPresentation>> = {
  [TERRAIN.UNSEEN]: { category: "unseen", color: CLR.GRAY },
  [TERRAIN.FLOOR]: { category: "floor", color: CLR.GRAY },
  [TERRAIN.CORRIDOR]: { category: "corridor", color: CLR.GRAY },
  [TERRAIN.WALL]: { category: "wall", color: CLR.CYAN },
  [TERRAIN.DOOR]: { category: "door", color: CLR.BROWN },
  [TERRAIN.DOOR_OPEN]: { category: "door-open", color: CLR.BROWN },
  [TERRAIN.STAIRS]: { category: "stairs", color: CLR.WHITE },
  [TERRAIN.TRAP]: { category: "trap", color: CLR.RED },
  [TERRAIN.FEATURE]: { category: "feature", color: CLR.MAGENTA },
};

export class MoriaClassifier {
  classify(records: Int32Array): ClassifiedMoriaCell[] {
    if (records.length % GRID_STRIDE !== 0) {
      throw new Error("invalid Moria grid record batch");
    }

    const result: ClassifiedMoriaCell[] = [];
    for (let offset = 0; offset < records.length; offset += GRID_STRIDE) {
      const x = records[offset + GRID.X]!;
      const y = records[offset + GRID.Y]!;
      if (x < 0 || x >= MORIA_COLS || y < 0 || y >= MORIA_ROWS) {
        throw new Error(`Moria coordinate (${x},${y}) is outside Moria grid bounds`);
      }

      const terrain = terrainCell(records, offset);
      const underlay = TERRAIN_CATEGORIES.has(terrain.category) ? { terrain } : {};
      const top = records[offset + GRID.TOP_CAT]!;
      let cell: Cell;
      if (top === TOP.HERO) {
        cell = {
          category: "being",
          ch: publicChar(records[offset + GRID.TOP_CHAR]!, "@"),
          color: CLR.WHITE,
          hero: true,
          ...underlay,
        };
      } else if (top === TOP.MONSTER) {
        cell = {
          category: "being",
          ch: publicChar(records[offset + GRID.TOP_CHAR]!, "?"),
          color: CLR.RED,
          ...underlay,
        };
      } else if (top === TOP.ITEM) {
        cell = {
          category: "item",
          ch: publicChar(records[offset + GRID.TOP_CHAR]!, "?"),
          color: CLR.YELLOW,
          ...underlay,
        };
      } else {
        cell = terrain;
      }

      result.push({ x, y, cell });
    }
    return result;
  }
}

function terrainCell(records: Int32Array, offset: number): Cell {
  const id = records[offset + GRID.TERRAIN_CAT]!;
  const presentation = TERRAIN_PRESENTATION[id];
  if (presentation === undefined || presentation.category === "unseen") {
    return { category: "unseen", ch: " ", color: CLR.GRAY };
  }
  const kindId = records[offset + GRID.TERRAIN_KIND]!;
  return {
    category: presentation.category,
    kind: KIND_NAMES[kindId] || undefined,
    ch: publicChar(records[offset + GRID.TERRAIN_CHAR]!, " "),
    color: presentation.color,
  };
}

function publicChar(codePoint: number, fallback: string): string {
  if (codePoint < 0 || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return fallback;
  return String.fromCodePoint(codePoint);
}
