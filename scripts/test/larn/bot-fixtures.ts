// Shared fixtures for the Larn bot test files: one map batch, in the shape the
// map tap sends it, painted from a description of the room. NOT a .test.ts
// file itself, so vitest does not collect it.
import type { LarnEvent } from "../../../src/modules/larn/protocol";
import { GRID, GRID_STRIDE, KIND_NAMES, TERRAIN, TOP } from "../../../src/modules/larn/mapRecords";
import { LARN_COLS, LARN_ROWS } from "../../../src/modules/larn/classifier";

export type Paint = {
  hero: [number, number];
  monsters?: [number, number][];
  /** The glyph and color every painted monster carries; Larn's B by default. */
  monster?: { ch: string; color: number };
  /** Monsters with a glyph and colour each, for the cases that need two
   *  different beings adjacent at once. */
  beings?: [number, number, string, number][];
  /** Wall everything the hero and the monsters are not standing on: the
   *  cornered case, where declining a fight leaves nowhere to step. */
  pocket?: boolean;
  /** Extra cells a pocket keeps as floor, so a sealed region can be bigger
   *  than one cell. */
  floor?: [number, number][];
  unseenFrom?: number;
  /** Down stairs, each with the glyph Larn draws it as — the only thing that
   *  tells the volcanic shaft "V" from an ordinary staircase. */
  down?: [number, number, string][];
  items?: [number, number, string][];
  /** Doors, each closed unless its third field says open. Larn draws a closed
   *  door "D" and an open one "O" (data.c objnamelist, header.h 19/20). */
  doors?: [number, number, boolean?][];
  trap?: [number, number];
};

/** The entry of `cells` standing on (x, y), if any. */
function at<T extends readonly [number, number, ...unknown[]]>(
  cells: readonly T[] | undefined, x: number, y: number,
): T | undefined {
  return (cells ?? []).find(([cx, cy]) => cx === x && cy === y);
}

/** A full 67x17 batch: a bordered floor room, everything seen unless
 *  unseenFrom is set, with what `p` names painted in. */
export function mapRecords(p: Paint): Int32Array {
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let y = 0; y < LARN_ROWS; y++) for (let x = 0; x < LARN_COLS; x++) {
    r[i + GRID.X] = x; r[i + GRID.Y] = y;
    const occupied = (x === p.hero[0] && y === p.hero[1])
      || [p.monsters, p.beings, p.floor, p.down, p.doors]
        .some((cells) => at<readonly [number, number, ...unknown[]]>(cells, x, y))
      || (p.trap ? p.trap[0] === x && p.trap[1] === y : false);
    const edge = p.pocket ? !occupied
      : x === 0 || y === 0 || x === LARN_COLS - 1 || y === LARN_ROWS - 1;
    const unseen = p.unseenFrom !== undefined && x >= p.unseenFrom;
    r[i + GRID.TERRAIN_CAT] = unseen ? TERRAIN.UNSEEN : edge ? TERRAIN.WALL : TERRAIN.FLOOR;
    r[i + GRID.TERRAIN_CHAR] = (unseen ? " " : edge ? "#" : ".").charCodeAt(0);
    r[i + GRID.TERRAIN_COLOR] = 7;
    const down = at(p.down, x, y);
    if (down) {
      r[i + GRID.TERRAIN_CAT] = TERRAIN.STAIRS; r[i + GRID.TERRAIN_KIND] = KIND_NAMES.indexOf("down");
      r[i + GRID.TERRAIN_CHAR] = down[2].charCodeAt(0);
    }
    const door = at(p.doors, x, y);
    if (door) {
      r[i + GRID.TERRAIN_CAT] = door[2] ? TERRAIN.DOOR_OPEN : TERRAIN.DOOR;
      r[i + GRID.TERRAIN_CHAR] = (door[2] ? "O" : "D").charCodeAt(0);
    }
    if (p.trap && x === p.trap[0] && y === p.trap[1]) {
      r[i + GRID.TERRAIN_CAT] = TERRAIN.TRAP; r[i + GRID.TERRAIN_KIND] = KIND_NAMES.indexOf("trap");
    }
    if (x === p.hero[0] && y === p.hero[1]) r[i + GRID.TOP_CAT] = TOP.HERO;
    if (at(p.monsters, x, y)) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER;
      r[i + GRID.TOP_CHAR] = (p.monster?.ch ?? "B").charCodeAt(0);
      r[i + GRID.TOP_COLOR] = p.monster?.color ?? 2;
    }
    const being = at(p.beings, x, y);
    if (being) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER;
      r[i + GRID.TOP_CHAR] = being[2].charCodeAt(0);
      r[i + GRID.TOP_COLOR] = being[3];
    }
    const item = at(p.items, x, y);
    if (item) {
      r[i + GRID.TOP_CAT] = TOP.ITEM; r[i + GRID.TOP_CHAR] = item[2].charCodeAt(0); r[i + GRID.TOP_COLOR] = 7;
    }
    i += GRID_STRIDE;
  }
  return r;
}

/** Hand `m` the batch `p` describes, as the map tap would. */
export function paint(m: { observe(ev: LarnEvent): void }, p: Paint): void {
  m.observe({ name: "map", records: mapRecords(p) });
}
