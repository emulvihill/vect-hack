// The frozen scenes behind the offline previews: one representative level per
// Module, run through the real classifier, geometry builders and cameras, with
// every stroke recorded instead of drawn. scene-preview.test.ts asserts on
// them; scene-preview.ts rasterizes the same frames to images. Neither builds
// a scene of its own, so the picture is always of the thing the test checked.
//
// Two frames per Module: the orbital view the game opens on, and the
// first-person view F2 switches to, from the same frozen frame of the same
// level. NetHack's level is classified from glyphs; Angband, Larn and Moria use
// packed native-tap-shaped record batches.
import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { CLR } from "../../src/backplane/colors";
import { CellGrid, type Cell } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import {
  ANGBAND_COLS, ANGBAND_ROWS, AngbandClassifier,
} from "../../src/modules/angband/classifier";
import { GRID, GRID_FLAG, GRID_STRIDE } from "../../src/modules/angband/mapRecords";
import {
  LARN_COLS, LARN_ROWS, LarnClassifier,
} from "../../src/modules/larn/classifier";
import {
  GRID as LARN_GRID, GRID_STRIDE as LARN_GRID_STRIDE,
  TERRAIN as LARN_TERRAIN, TOP as LARN_TOP,
} from "../../src/modules/larn/mapRecords";
import {
  MORIA_COLS, MORIA_ROWS, MoriaClassifier,
} from "../../src/modules/moria/classifier";
import {
  GRID as MORIA_GRID, GRID_STRIDE as MORIA_GRID_STRIDE,
  TERRAIN as MORIA_TERRAIN, TOP as MORIA_TOP,
} from "../../src/modules/moria/mapRecords";
import { buildTerrain } from "../../src/render/TerrainBuilder";
import { buildEntities } from "../../src/render/EntityLayer";
import { MapFx } from "../../src/render/effects/mapFx";
import { FirstPersonCam } from "../../src/render/FirstPersonCam";
import { OrbitCam } from "../../src/render/OrbitCam";
import type { LineBatch } from "../../src/render/LineBatch";

export const WIDTH = 1280, HEIGHT = 720;
/** Frozen animation clock, so the image is byte-stable across runs. */
const TIME = 1.7;
/** Frozen frame step for the atmosphere pass, for the same reason. */
const DT = 1 / 60;
const AZIMUTH = 0.35;
/** First-person heading: due east, straight down the room at the far door. */
const FP_YAW = -Math.PI / 2;

export interface Seg { a: Vector3; b: Vector3; r: number; g: number; b2: number; gain: number }

export function recorder(out: Seg[]): LineBatch {
  return {
    begin() {},
    add(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
        c: { r: number; g: number; b: number }, gain = 1) {
      out.push({
        a: new Vector3(ax, ay, az), b: new Vector3(bx, by, bz),
        r: c.r * gain, g: c.g * gain, b2: c.b * gain, gain,
      });
    },
    commit() {},
  } as unknown as LineBatch;
}

/** Neither camera binds anything here; they just want an element to bind to. */
const STUB_DOM = {
  addEventListener() {}, removeEventListener() {},
} as unknown as HTMLElement;

/** World -> pixel for `camera`; z above 1 is behind the near plane. */
export function projector(camera: PerspectiveCamera) {
  const ndc = new Vector3();
  return (v: Vector3) => {
    ndc.copy(v).project(camera);
    return { x: (ndc.x * 0.5 + 0.5) * WIDTH, y: (1 - (ndc.y * 0.5 + 0.5)) * HEIGHT, z: ndc.z };
  };
}

function orbitAt(map: CellGrid): OrbitCam {
  const cam = new OrbitCam(STUB_DOM);
  if (process.env.PREVIEW_RADIUS) cam.radius = Number(process.env.PREVIEW_RADIUS);
  cam.azimuth = AZIMUTH;
  cam.follow(map.hero!.x, map.hero!.y);
  cam.snap();
  cam.resize(WIDTH, HEIGHT);
  cam.update(0);
  cam.camera.updateMatrixWorld(true);
  return cam;
}

function firstPersonAt(map: CellGrid): FirstPersonCam {
  const fp = new FirstPersonCam(STUB_DOM, { yaw: FP_YAW });
  fp.follow(map.hero!.x, map.hero!.y);
  fp.snap();
  fp.resize(WIDTH, HEIGHT);
  fp.update(0);
  fp.camera.updateMatrixWorld(true);
  return fp;
}

/** One frozen frame of a level: its terrain, the entities the orbital camera
 *  sees, and the entities from inside the hero's cell (hero hidden). */
export interface Scene {
  map: CellGrid;
  terrain: Seg[];
  orbit: OrbitCam;
  entities: Seg[];
  fp: FirstPersonCam;
  inside: Seg[];
}

/** Both cameras on `map`, and the entities each one sees. */
function framed(map: CellGrid) {
  const orbit = orbitAt(map);
  const entities: Seg[] = [];
  buildEntities(map, recorder(entities), TIME, orbit.azimuth);
  const fp = firstPersonAt(map);
  const inside: Seg[] = [];
  buildEntities(map, recorder(inside), TIME, (x, y) => fp.facingAt(x, y), undefined,
    { hideHero: true });
  return { orbit, entities, fp, inside };
}

// ---- NetHack ---------------------------------------------------------------

/** Synthetic GLYPH_*_OFF values: only the ordering matters to the classifier. */
const GLYPH_OFFSETS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};
const TERRAIN = 610, OBJECT = 520, MONSTER = 12, PET = 110, ZAP = 701, EXPLODE = 805;
const ORIGIN = { x: 6, y: 4 };

const LEVEL = [
  "  ----------           ",
  "  |........|           ",
  "  |..<.....+###########",
  "  |........|          #",
  "  |........|      ----+---",
  "  ----------      |......|",
  "                  |....>.|",
  "                  ----- --",
];

/** NetHack's scene. `entities` is the atmosphere pass; `plain` is the same
 *  frame without it, which the atmosphere's strokes must outnumber. */
export function nethackScene(): Scene & { plain: Seg[] } {
  const clf = new NetHackClassifier();
  clf.configure(GLYPH_OFFSETS);
  const map = new CellGrid(NETHACK_COLS, NETHACK_ROWS);
  const put = (x: number, y: number, glyph: number, ch: string, color: number, flags = 0) =>
    map.set(x, y, clf.classify({ glyph, ch, color, glyphflags: flags }));
  LEVEL.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === " ") return;
      put(ORIGIN.x + x, ORIGIN.y + y, TERRAIN, ch, ch === "+" ? CLR.BROWN : CLR.GRAY);
    }));
  put(12, 6, MONSTER, "@", CLR.WHITE, MG.HERO);
  put(12, 7, PET, "f", CLR.WHITE, MG.PET);
  put(14, 6, MONSTER, "d", CLR.YELLOW);
  put(13, 8, MONSTER, "k", CLR.GREEN);
  put(10, 7, OBJECT, ")", CLR.GRAY);
  put(12, 5, OBJECT, "%", CLR.BROWN);
  put(9, 8, OBJECT, "!", CLR.MAGENTA);
  // A sleeping-gas trap, a couple of tiles from the hero: the danger frame is
  // the thing this fixture exists to check.
  put(10, 6, TERRAIN, "^", CLR.BRIGHT_BLUE);
  // A wand's beam crossing the room, and the blast where it lands.
  put(13, 6, ZAP, "-", CLR.CYAN);
  put(15, 6, EXPLODE, "*", CLR.ORANGE);

  // Two frames of the atmosphere pass: the effects fire on the first observe,
  // then release by a frame each, so the image catches them mid-decay.
  const fx = new MapFx(NETHACK_COLS, NETHACK_ROWS);
  fx.observe(map);
  fx.step(DT);
  fx.step(DT);
  fx.reseed(TIME);

  // The level itself, which both cameras look at.
  const terrain: Seg[] = [];
  buildTerrain(map, recorder(terrain), (x, y) => fx.lightAt(x, y));

  const orbit = orbitAt(map);
  const plain: Seg[] = [], entities: Seg[] = [];
  buildEntities(map, recorder(plain), TIME, orbit.azimuth);
  buildEntities(map, recorder(entities), TIME, orbit.azimuth, fx,
    { highlight: { x: map.hero!.x + 1, y: map.hero!.y } });

  const fp = firstPersonAt(map);
  const inside: Seg[] = [];
  buildEntities(map, recorder(inside), TIME, (x, y) => fp.facingAt(x, y), fx,
    { hideHero: true });
  return { map, terrain, orbit, plain, entities, fp, inside };
}

// ---- Angband ---------------------------------------------------------------
// The same builders and cameras, fed by AngbandClassifier from a packed record
// batch shaped exactly like the native tap's. Its point beyond the picture: an
// occupied tile keeps its floor, because the classifier hands the terrain along
// underneath the monster/item/hero glyph (Cell.terrain).

/** Feature ids from the pinned 4.2.6 data, as main-wasm.c reports them. */
const AF = {
  FLOOR: 1, DOOR: 2, OPEN_DOOR: 3, UP: 5, DOWN: 6, STORE: 7,
  WALL: 15, RUBBLE: 16, LAVA: 23,
} as const;

const ANGBAND_LEVEL = [
  "#########################",
  "#.......#################",
  "#..<....+...............#",
  "#.......#...#########..:#",
  "#..!..o.#...#~~~~~~~#...#",
  "#...@...'...#~~~~~~~#..>#",
  "#.......#...#########...#",
  "#..^....#...............#",
  "#.......#######1#########",
  "#########################",
];
export const ANGBAND_ORIGIN = { x: 20, y: 14 };
/** Local cells the assertions name: the three occupied floors, and a plain
 *  floor with four open neighbours to compare their floor edges against. */
export const ANG_HERO = { x: 4, y: 5 }, ANG_MONSTER = { x: 6, y: 4 }, ANG_ITEM = { x: 3, y: 4 };
export const ANG_PLAIN_FLOOR = { x: 5, y: 3 };

/** Terrain (and trap/top) words for one fixture character. */
function angbandRecord(x: number, y: number, ch: string): Int32Array {
  const w = new Int32Array(GRID_STRIDE);
  w[GRID.X] = ANGBAND_ORIGIN.x + x;
  w[GRID.Y] = ANGBAND_ORIGIN.y + y;
  const terrain = (feature: number, tile: string, color: number) => {
    w[GRID.FEATURE] = feature;
    w[GRID.TERRAIN_CHAR] = tile.codePointAt(0)!;
    w[GRID.TERRAIN_COLOR] = color;
  };
  const top = (flags: number, glyph: string, color: number) => {
    w[GRID.FLAGS] = flags;
    w[GRID.TOP_CHAR] = glyph.codePointAt(0)!;
    w[GRID.TOP_COLOR] = color;
  };
  terrain(AF.FLOOR, ".", CLR.GRAY);
  switch (ch) {
    case ".": break;
    case "#": terrain(AF.WALL, "#", CLR.GRAY); break;
    case ":": terrain(AF.RUBBLE, ":", CLR.GRAY); break;
    case "+": terrain(AF.DOOR, "+", CLR.BROWN); break;
    case "'": terrain(AF.OPEN_DOOR, "'", CLR.BROWN); break;
    case "<": terrain(AF.UP, "<", CLR.WHITE); break;
    case ">": terrain(AF.DOWN, ">", CLR.WHITE); break;
    case "~": terrain(AF.LAVA, "#", CLR.RED); break;
    case "1": terrain(AF.STORE, "1", CLR.YELLOW); break;
    case "^":
      w[GRID.TRAP_CHAR] = "^".codePointAt(0)!;
      w[GRID.TRAP_COLOR] = CLR.ORANGE;
      w[GRID.TRAP_KIND] = 6; // pit
      break;
    case "!": top(GRID_FLAG.OBJECT, "!", CLR.MAGENTA); break;
    case "o": top(GRID_FLAG.MONSTER, "o", CLR.YELLOW); break;
    case "@": top(GRID_FLAG.PLAYER, "@", CLR.WHITE); break;
    default: throw new Error(`unmapped fixture char ${ch}`);
  }
  return w;
}

/** Angband's scene, with the classifier's own output for the underlay checks. */
export function angbandScene(): Scene & { classified: { x: number; y: number; cell: Cell }[] } {
  const clf = new AngbandClassifier();
  const batch: number[] = [];
  ANGBAND_LEVEL.forEach((row, y) =>
    [...row].forEach((ch, x) => batch.push(...angbandRecord(x, y, ch))));
  const classified = clf.classify(new Int32Array(batch));

  const map = new CellGrid(ANGBAND_COLS, ANGBAND_ROWS);
  for (const { x, y, cell } of classified) map.set(x, y, cell);
  const terrain: Seg[] = [];
  buildTerrain(map, recorder(terrain));
  return { map, terrain, classified, ...framed(map) };
}

// ---- Larn ------------------------------------------------------------------
// Larn's native tap is a small fixed 9-word record. This synthetic level is
// deliberately packed that way rather than assembled as Cells, so the preview
// catches a classifier/layout drift before a real engine frame reaches WebGL.
export const LARN_LEVEL = [
  "#############################",
  "#...........#...............#",
  "#..@....!..+#...._....^.....#",
  "#...........#....#..........#",
  "#####/#######....#...B......#",
  "#....<...........#..........#",
  "#.............$..#..........#",
  "#############################",
];
export const LARN_ORIGIN = { x: 18, y: 5 };

/** One source-shaped larn_map_info record. The symbols are only fixture
 * shorthand; every cell still reaches the renderer via LarnClassifier. */
function larnRecord(x: number, y: number, ch: string): Int32Array {
  const w = new Int32Array(LARN_GRID_STRIDE);
  w[LARN_GRID.X] = LARN_ORIGIN.x + x;
  w[LARN_GRID.Y] = LARN_ORIGIN.y + y;
  const terrain = (category: number, glyph: string, color: number, kind = 0) => {
    w[LARN_GRID.TERRAIN_CAT] = category;
    w[LARN_GRID.TERRAIN_CHAR] = glyph.codePointAt(0)!;
    w[LARN_GRID.TERRAIN_COLOR] = color;
    w[LARN_GRID.TERRAIN_KIND] = kind;
  };
  const top = (category: number, glyph: string, color: number) => {
    w[LARN_GRID.TOP_CAT] = category;
    w[LARN_GRID.TOP_CHAR] = glyph.codePointAt(0)!;
    w[LARN_GRID.TOP_COLOR] = color;
  };
  terrain(LARN_TERRAIN.FLOOR, ".", CLR.GRAY);
  switch (ch) {
    case ".": break;
    case "#": terrain(LARN_TERRAIN.WALL, "#", CLR.GRAY); break;
    case "+": terrain(LARN_TERRAIN.DOOR, "+", CLR.BROWN); break;
    case "/": terrain(LARN_TERRAIN.DOOR_OPEN, "/", CLR.BROWN); break;
    case "<": terrain(LARN_TERRAIN.STAIRS, "<", CLR.WHITE, 16); break;
    case "_": terrain(LARN_TERRAIN.FEATURE, "_", CLR.CYAN, 1); break;
    case "^": terrain(LARN_TERRAIN.TRAP, "^", CLR.ORANGE, 19); break;
    case "@": top(LARN_TOP.HERO, "@", CLR.WHITE); break;
    case "B": top(LARN_TOP.MONSTER, "B", CLR.RED); break;
    case "!": top(LARN_TOP.ITEM, "!", CLR.MAGENTA); break;
    case "$": top(LARN_TOP.ITEM, "$", CLR.YELLOW); break;
    default: throw new Error(`unmapped Larn fixture char ${ch}`);
  }
  return w;
}

export function larnScene(): Scene {
  const clf = new LarnClassifier();
  const batch: number[] = [];
  LARN_LEVEL.forEach((row, y) =>
    [...row].forEach((ch, x) => batch.push(...larnRecord(x, y, ch))));
  const map = new CellGrid(LARN_COLS, LARN_ROWS);
  for (const { x, y, cell } of clf.classify(new Int32Array(batch))) map.set(x, y, cell);
  const terrain: Seg[] = [];
  buildTerrain(map, recorder(terrain));
  return { map, terrain, ...framed(map) };
}

// ---- Moria -----------------------------------------------------------------
// Every cell enters through Moria's seven-word sanitized public ABI. Symbols
// are fixture shorthand only; raw Umoria fval/tval/creature IDs are absent by
// construction, just as they are in the production semantic callback.
export const MORIA_LEVEL = [
  "#############################",
  "#...........#...............#",
  "#..@....!..+#....%....^.....#",
  "#...........#....#..........#",
  "#####'#######....#...o......#",
  "#....<...........#..........#",
  "#.,.........>.:..#...1......#",
  "#...........?....&..........#",
  "#############################",
];
export const MORIA_ORIGIN = { x: 40, y: 20 };
export const MORIA_HERO = { x: 3, y: 2 };
export const MORIA_ITEM = { x: 8, y: 2 };
export const MORIA_MONSTER = { x: 21, y: 4 };
export const MORIA_CONTROL_FLOOR = { x: 5, y: 3 };

function moriaRecord(x: number, y: number, ch: string): Int32Array {
  const words = new Int32Array(MORIA_GRID_STRIDE);
  words[MORIA_GRID.X] = MORIA_ORIGIN.x + x;
  words[MORIA_GRID.Y] = MORIA_ORIGIN.y + y;
  const terrain = (category: number, kind: number, glyph: string) => {
    words[MORIA_GRID.TERRAIN_CAT] = category;
    words[MORIA_GRID.TERRAIN_KIND] = kind;
    words[MORIA_GRID.TERRAIN_CHAR] = glyph.codePointAt(0)!;
  };
  const top = (category: number, glyph: string) => {
    words[MORIA_GRID.TOP_CAT] = category;
    words[MORIA_GRID.TOP_CHAR] = glyph.codePointAt(0)!;
  };

  terrain(MORIA_TERRAIN.FLOOR, 1, ".");
  switch (ch) {
    case ".": break;
    case ",": terrain(MORIA_TERRAIN.CORRIDOR, 2, "."); break;
    case "#": terrain(MORIA_TERRAIN.WALL, 3, "#"); break;
    case "%": terrain(MORIA_TERRAIN.WALL, 4, "%"); break;
    case "&": terrain(MORIA_TERRAIN.WALL, 5, "%"); break;
    case ":": terrain(MORIA_TERRAIN.FEATURE, 6, ":"); break;
    case "'": terrain(MORIA_TERRAIN.DOOR_OPEN, 7, "'"); break;
    case "+": terrain(MORIA_TERRAIN.DOOR, 8, "+"); break;
    case "<": terrain(MORIA_TERRAIN.STAIRS, 9, "<"); break;
    case ">": terrain(MORIA_TERRAIN.STAIRS, 10, ">"); break;
    case "^": terrain(MORIA_TERRAIN.TRAP, 11, "^"); break;
    case "1": terrain(MORIA_TERRAIN.FEATURE, 12, "1"); break;
    case "?": terrain(MORIA_TERRAIN.UNSEEN, 0, " "); break;
    case "@": top(MORIA_TOP.HERO, "@"); break;
    case "o": top(MORIA_TOP.MONSTER, "o"); break;
    case "!": top(MORIA_TOP.ITEM, "!"); break;
    default: throw new Error(`unmapped Moria fixture char ${ch}`);
  }
  return words;
}

/** Moria's scene, with the classifier's own output for the underlay checks. */
export function moriaScene(): Scene & { classified: { x: number; y: number; cell: Cell }[] } {
  const batch: number[] = [];
  MORIA_LEVEL.forEach((row, y) =>
    [...row].forEach((ch, x) => batch.push(...moriaRecord(x, y, ch))));
  const classified = new MoriaClassifier().classify(Int32Array.from(batch));
  const map = new CellGrid(MORIA_COLS, MORIA_ROWS);
  for (const { x, y, cell } of classified) map.set(x, y, cell);
  const terrain: Seg[] = [];
  buildTerrain(map, recorder(terrain));
  return { map, terrain, classified, ...framed(map) };
}
