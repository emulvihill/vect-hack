// Static level geometry: walls as glowing wireframe ridges, floors as a faint
// grid with bright region outlines, and a hand-built form for each terrain
// feature that deserves one. Rebuilt only when the map's terrain changes.
import { Color, Matrix4, Vector3 } from "three/webgpu";
import { INK, clr } from "./palette";
import { emitLetter } from "./letterform";
import type { LineBatch } from "./LineBatch";
import { TERRAIN_CATEGORIES, isOpen, terrainOf, type Category, type Cell, type CellGrid } from "../backplane/cell";
import { activeSkin } from "../skins";

/** Height of a wall, in cells. Everything vertical is derived from it. */
export const WALL_HEIGHT = 1.1;

/** Relative brightness of terrain lines, so the tiers stay in one place. */
export const GAIN_DEFAULTS = {
  wallBase: 0.8,
  floorInterior: 0.3,
  floorBorder: 1,
  doorSill: 0.6,
  doorRail: 0.7,
  openDoorJamb: 0.8,
  water: 0.9,
  lava: 1.35,
  feature: 0.85,
  /** As hot a read as lava: this is the other thing on a level that kills you. */
  trap: 1.35,
} as const;
const GAIN: Record<keyof typeof GAIN_DEFAULTS, number> =
  { ...GAIN_DEFAULTS, ...activeSkin().gains };

/** Half-widths and lifts, in cells. */
const DOOR_HALF_WIDTH = 0.42;
const DOOR_HEIGHT = WALL_HEIGHT * 0.9;
const DOOR_RAIL_FRACTION = 0.55;
const OPEN_DOOR_HALF_WIDTH = 0.45;
const OPEN_DOOR_HEIGHT = WALL_HEIGHT * 0.7;
/** Nested squares of the stair well, outermost first. */
const STAIR_RADII = [0.44, 0.3, 0.16];
const STAIR_RISE = 0.1;
const WATER_ROWS = 3;
const WATER_ROW_SPACING = 0.3;
const WATER_BASE_HEIGHT = 0.04;
const WATER_CREST = 0.06;
/** Lava's crests run taller than water's, so shape reads it even without colour. */
const LAVA_CREST_SCALE = 2.2;
const FEATURE_LIFT = 0.03;
const FEATURE_SCALE = new Vector3(0.75, 0.75, 0.75);
/** Half-width of the trap danger frame: inset from the tile edge like the
 *  stair well, so it reads as its own square rather than retracing the
 *  floor's own grid lines. */
const TRAP_HALF_WIDTH = 0.4;
/** Rounding used to fuse coincident edges; 1/100 cell is far below a stroke. */
const EDGE_QUANTUM = 100;

/** The four horizontal neighbours, as [dx, dy]. */
const SIDES: readonly [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

const scratch = new Matrix4();

/** Receives the wall fill quads (the depth mask); see src/render/WallFill.ts.
 *  Corners are given in order around the quad (fan-triangulated 0-1-2, 0-2-3). */
export interface FillSink {
  begin(): void;
  quad(
    x1: number, y1: number, z1: number, x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number, x4: number, y4: number, z4: number,
  ): void;
  commit(): void;
}

/**
 * Cell (gx, gy) occupies the unit square centred on world (gx, 0, gy).
 *
 * @param lightAt hero light at a cell; omitted, the level is drawn fully lit.
 * @param fills receives the wall depth-mask quads; omitted, none are emitted.
 */
export function buildTerrain(
  map: CellGrid, batch: LineBatch, lightAt?: (x: number, y: number) => number,
  fills?: FillSink,
): void {
  batch.begin();
  fills?.begin();
  const drawn = new Set<string>();
  /** Light of the cell currently emitting. An edge two cells share is emitted
   *  by whichever comes first in the walk and lit by that one; they are
   *  neighbours, so the two answers differ by less than a cell of falloff. */
  let light = 1;

  const line = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    color: Color, gain = 1,
  ) => {
    const key = edgeKey(ax, ay, az, bx, by, bz);
    if (drawn.has(key)) return;
    drawn.add(key);
    batch.add(ax, ay, az, bx, by, bz, color, gain * light);
  };

  const kind = (x: number, y: number): Category => {
    return terrainOf(map.at(x, y)) ?? "unseen";
  };

  const terrainCell = (cell: Cell): Cell =>
    TERRAIN_CATEGORIES.has(cell.category) ? cell : cell.terrain!;

  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      const k = kind(x, y);
      if (k === "unseen") continue;
      // Lava lights itself and must never dim into something water-coloured.
      light = k === "lava" ? 1 : lightAt?.(x, y) ?? 1;
      if (k === "wall") {
        emitWall(x, y, kind, line, fills);
        continue;
      }
      emitFloor(x, y, k, kind, line);
      const cell = terrainCell(map.at(x, y));
      switch (k) {
        case "stairs": emitStairs(x, y, cell.ch === ">", line); break;
        case "door": emitDoor(x, y, kind, line); break;
        case "door-open": emitOpenDoor(x, y, kind, line); break;
        case "water": emitWater(x, y, line, false); break;
        case "lava": emitWater(x, y, line, true); break;
        case "feature": emitFeature(batch, x, y, cell.ch, clr(cell.color), light); break;
        case "trap": {
          // The danger frame self-lights like lava — but only the frame: the
          // glyph keeps the cell's light, and the floor was drawn above, so a
          // trapped tile never reads as the one lit floor on a dark level.
          // Which traps exist here is the engine's call, not this layer's: an
          // undiscovered trap is never sent as a glyph, so this reveals nothing.
          const cellLight = light;
          light = 1; // reset at the top of the next cell's iteration
          emitTrap(batch, x, y, cell.ch, clr(cell.color), cellLight, line);
          break;
        }
      }
    }
  }
  batch.commit();
  fills?.commit();
}

type Emit = (
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  color: Color, gain?: number,
) => void;
type KindAt = (x: number, y: number) => Category;

/**
 * A wall cell contributes only its exposed faces: the top and bottom rails of
 * every side that faces open space, plus corner posts where the run ends. Edge
 * dedup then fuses neighbouring cells into continuous rails.
 */
function emitWall(x: number, y: number, kind: KindAt, line: Emit, fills?: FillSink): void {
  const H = WALL_HEIGHT;
  for (const [dx, dy] of SIDES) {
    if (kind(x + dx, y + dy) === "wall") continue;
    // The face lies half a cell toward (dx, dy); it runs along the other axis.
    const alongX = dx === 0;
    const ax = alongX ? x - 0.5 : x + dx * 0.5;
    const az = alongX ? y + dy * 0.5 : y - 0.5;
    const bx = alongX ? x + 0.5 : ax;
    const bz = alongX ? az : y + 0.5;
    line(ax, H, az, bx, H, bz, INK.wallTop);
    line(ax, 0, az, bx, 0, bz, INK.wall, GAIN.wallBase);
    // Posts only where the wall run ends, so long walls stay clean panels.
    const step: [number, number] = alongX ? [-1, 0] : [0, -1];
    if (kind(x + step[0], y + step[1]) !== "wall") line(ax, 0, az, ax, H, az, INK.wall);
    if (kind(x - step[0], y - step[1]) !== "wall") line(bx, 0, bz, bx, H, bz, INK.wall);
    fills?.quad(ax, 0, az, bx, 0, bz, bx, H, bz, ax, H, az);
  }
  fills?.quad(x - 0.5, H, y - 0.5, x + 0.5, H, y - 0.5, x + 0.5, H, y + 0.5, x - 0.5, H, y + 0.5);
}

/** Floor tiles: outline edges bright where the region ends, faint inside. */
function emitFloor(x: number, y: number, k: Category, kind: KindAt, line: Emit): void {
  const color = k === "corridor" ? INK.corridor : INK.floor;
  for (const [dx, dy] of SIDES) {
    const border = !isOpen(kind(x + dx, y + dy));
    const alongX = dx === 0;
    const ax = alongX ? x - 0.5 : x + dx * 0.5;
    const az = alongX ? y + dy * 0.5 : y - 0.5;
    const bx = alongX ? x + 0.5 : ax;
    const bz = alongX ? az : y + 0.5;
    line(ax, 0, az, bx, 0, bz, color, border ? GAIN.floorBorder : GAIN.floorInterior);
  }
}

/** Three concentric squares stepping down (>) or up (<). */
function emitStairs(x: number, y: number, down: boolean, line: Emit): void {
  for (let i = 0; i < STAIR_RADII.length; i++) {
    const r = STAIR_RADII[i]!;
    const h = (down ? -1 : 1) * STAIR_RISE * (i + 1);
    line(x - r, h, y - r, x + r, h, y - r, INK.stairs);
    line(x + r, h, y - r, x + r, h, y + r, INK.stairs);
    line(x + r, h, y + r, x - r, h, y + r, INK.stairs);
    line(x - r, h, y + r, x - r, h, y - r, INK.stairs);
  }
}

/** A closed door fills the gap: a panel spanning the wall it sits in. */
function emitDoor(x: number, y: number, kind: KindAt, line: Emit): void {
  const alongX = kind(x - 1, y) === "wall" || kind(x + 1, y) === "wall";
  const H = DOOR_HEIGHT;
  const r = DOOR_HALF_WIDTH;
  const ax = alongX ? x - r : x;
  const az = alongX ? y : y - r;
  const bx = alongX ? x + r : x;
  const bz = alongX ? y : y + r;
  line(ax, 0, az, ax, H, az, INK.door);
  line(bx, 0, bz, bx, H, bz, INK.door);
  line(ax, H, az, bx, H, bz, INK.door);
  line(ax, 0, az, bx, 0, bz, INK.door, GAIN.doorSill);
  const mid = H * DOOR_RAIL_FRACTION;
  line(ax, mid, az, bx, mid, bz, INK.door, GAIN.doorRail);
}

/** An open door: the panel swung aside, drawn as a jamb pair only. */
function emitOpenDoor(x: number, y: number, kind: KindAt, line: Emit): void {
  const alongX = kind(x - 1, y) === "wall" || kind(x + 1, y) === "wall";
  const H = OPEN_DOOR_HEIGHT;
  const r = OPEN_DOOR_HALF_WIDTH;
  const ax = alongX ? x - r : x;
  const az = alongX ? y : y - r;
  const bx = alongX ? x + r : x;
  const bz = alongX ? y : y + r;
  line(ax, 0, az, ax, H, az, INK.door, GAIN.openDoorJamb);
  line(bx, 0, bz, bx, H, bz, INK.door, GAIN.openDoorJamb);
}

/**
 * Pools and lava, as rows of waves. Lava is not a recolour and must never read
 * as one: it burns hotter, and its crests are taller and steeper so the two are
 * still distinguishable edge-on or to a colour-blind player.
 */
function emitWater(x: number, y: number, line: Emit, lava: boolean): void {
  const ink = lava ? INK.lava : INK.water;
  const gain = lava ? GAIN.lava : GAIN.water;
  const crestHeight = WATER_CREST * (lava ? LAVA_CREST_SCALE : 1);
  for (let i = 0; i < WATER_ROWS; i++) {
    const z = y + (i - (WATER_ROWS - 1) / 2) * WATER_ROW_SPACING;
    const h = WATER_BASE_HEIGHT + (i % 2) * crestHeight / 2;
    const crest = h + crestHeight;
    line(x - 0.45, h, z, x - 0.15, crest, z, ink, gain);
    line(x - 0.15, crest, z, x + 0.15, h, z, ink, gain);
    line(x + 0.15, h, z, x + 0.45, crest, z, ink, gain);
  }
}

/** Fountains, altars, thrones, trees...: the tty symbol laid flat on the floor.
 *  Emitted straight to the batch, so it takes the cell's light by hand. */
function emitFeature(
  batch: LineBatch, x: number, y: number, ch: string, color: Color, light: number,
): void {
  scratch.makeRotationX(-Math.PI / 2).scale(FEATURE_SCALE).setPosition(x, FEATURE_LIFT, y);
  emitLetter(batch, ch, color, GAIN.feature * light, scratch);
}

/**
 * Traps and the cmap dangers that share their treatment (the web, the
 * vibrating square): the flat glyph still lands, same as any other feature,
 * but a lethal tile also gets a danger-red square framing it, so it never
 * again has to be told apart from a floor engraving on sight.
 *
 * `light` dims only the glyph; the frame rides the caller's `line` emitter,
 * which the caller sets to full brightness first (vect-hack-03t).
 */
function emitTrap(
  batch: LineBatch, x: number, y: number, ch: string, color: Color, light: number, line: Emit,
): void {
  emitFeature(batch, x, y, ch, color, light);
  const r = TRAP_HALF_WIDTH;
  line(x - r, FEATURE_LIFT, y - r, x + r, FEATURE_LIFT, y - r, INK.trap, GAIN.trap);
  line(x + r, FEATURE_LIFT, y - r, x + r, FEATURE_LIFT, y + r, INK.trap, GAIN.trap);
  line(x + r, FEATURE_LIFT, y + r, x - r, FEATURE_LIFT, y + r, INK.trap, GAIN.trap);
  line(x - r, FEATURE_LIFT, y + r, x - r, FEATURE_LIFT, y - r, INK.trap, GAIN.trap);
}

function edgeKey(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): string {
  const q = (v: number) => Math.round(v * EDGE_QUANTUM);
  const a = `${q(ax)},${q(ay)},${q(az)}`;
  const b = `${q(bx)},${q(by)},${q(bz)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
