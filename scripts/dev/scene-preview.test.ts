// Offline scene preview: runs the real geometry builders and the real camera
// through a software rasterizer and writes a PPM. It is the only way to see
// what the renderer produces without a GPU, so renderer changes can be checked
// from a terminal. Colour and stroke width are approximate — the beam-bloom
// stack and additive compositing only exist on the GPU.
//
// Two images per Module: the orbital view the game opens on, and the
// first-person view F2 switches to, from the same frozen frame of the same
// level. NetHack's level is classified from glyphs; Angband and Larn use
// packed native-tap-shaped record batches. The NetHack/Angband PPMs are
// converted to PNGs by `npm run preview`; Larn and Moria keep their PPMs and
// directly write their PNG pairs too.
//
//   npm run preview            # writes NetHack/Angband PPM+PNG pairs; Larn PPM+direct PNG pairs
//   PREVIEW_RADIUS=7 npm run preview
import { expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname } from "node:path";
import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { CLR } from "../../src/backplane/colors";
import { CellGrid } from "../../src/backplane/cell";
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

const OUT = process.env.PREVIEW_OUT ?? ".preview/nethack-scene.ppm";
const OUT_FP = process.env.PREVIEW_FP_OUT ?? ".preview/nethack-scene-fp.ppm";
const OUT_ANGBAND = process.env.PREVIEW_ANGBAND_OUT ?? ".preview/angband-scene.ppm";
const OUT_ANGBAND_FP =
  process.env.PREVIEW_ANGBAND_FP_OUT ?? ".preview/angband-scene-fp.ppm";
const OUT_LARN = process.env.PREVIEW_LARN_OUT ?? ".preview/larn-scene.ppm";
const OUT_LARN_FP = process.env.PREVIEW_LARN_FP_OUT ?? ".preview/larn-scene-fp.ppm";
const OUT_LARN_PNG = process.env.PREVIEW_LARN_PNG_OUT ?? ".preview/larn-scene.png";
const OUT_LARN_FP_PNG =
  process.env.PREVIEW_LARN_FP_PNG_OUT ?? ".preview/larn-scene-fp.png";
const OUT_MORIA = process.env.PREVIEW_MORIA_OUT ?? ".preview/moria-scene.ppm";
const OUT_MORIA_FP = process.env.PREVIEW_MORIA_FP_OUT ?? ".preview/moria-scene-fp.ppm";
const OUT_MORIA_PNG = process.env.PREVIEW_MORIA_PNG_OUT ?? ".preview/moria-scene.png";
const OUT_MORIA_FP_PNG =
  process.env.PREVIEW_MORIA_FP_PNG_OUT ?? ".preview/moria-scene-fp.png";
const WIDTH = 1280, HEIGHT = 720;
/** Frozen animation clock, so the image is byte-stable across runs. */
const TIME = 1.7;
/** Frozen frame step for the atmosphere pass, for the same reason. */
const DT = 1 / 60;
const AZIMUTH = 0.35;
/** First-person heading: due east, straight down the room at the far door. */
const FP_YAW = -Math.PI / 2;
const BRIGHTNESS = 190; // maps a 0..1 colour channel to 0..255

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

interface Seg { a: Vector3; b: Vector3; r: number; g: number; b2: number; gain: number }

function recorder(out: Seg[]): LineBatch {
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
function projector(camera: PerspectiveCamera) {
  const ndc = new Vector3();
  return (v: Vector3) => {
    ndc.copy(v).project(camera);
    return { x: (ndc.x * 0.5 + 0.5) * WIDTH, y: (1 - (ndc.y * 0.5 + 0.5)) * HEIGHT, z: ndc.z };
  };
}

/** Draw every segment additively, one pixel wide with a half-bright smear
 *  down and right for a hint of the GPU's bloom, and write the PPM. */
function rasterize(segments: readonly Seg[], camera: PerspectiveCamera, out: string): void {
  const project = projector(camera);
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3, 0);
  const plot = (x: number, y: number, r: number, g: number, b: number) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const o = (y * WIDTH + x) * 3;
    pixels[o] = Math.min(255, pixels[o]! + r);
    pixels[o + 1] = Math.min(255, pixels[o + 1]! + g);
    pixels[o + 2] = Math.min(255, pixels[o + 2]! + b);
  };
  for (const s of segments) {
    const A = project(s.a), B = project(s.b);
    if (A.z > 1 || B.z > 1) continue; // behind the near plane
    const r = Math.min(255, s.r * BRIGHTNESS);
    const g = Math.min(255, s.g * BRIGHTNESS);
    const b = Math.min(255, s.b2 * BRIGHTNESS);
    const steps = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.y - A.y)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t;
      plot(x, y, r, g, b);
      plot(x + 1, y, r / 2, g / 2, b / 2);
      plot(x, y + 1, r / 2, g / 2, b / 2);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`), pixels]));
}

/** `npm run preview` converts the existing PPMs after Vitest returns. Larn's
 * pair is born in this test, so encode it here too while preserving that
 * software-rasterizer source image beside the PNG. This stays in-process:
 * Vitest's worker sandbox cannot spawn ImageMagick. */
function png(ppm: string, out: string): void {
  const p6 = readFileSync(ppm);
  const header = Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`);
  const rgb = p6.subarray(header.length);
  const scanlines = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
  for (let y = 0; y < HEIGHT; y++) {
    const dst = y * (1 + WIDTH * 4);
    const src = y * WIDTH * 3;
    for (let x = 0; x < WIDTH; x++) {
      const i = src + x * 3, o = dst + 1 + x * 4;
      scanlines[o] = rgb[i]!;
      scanlines[o + 1] = rgb[i + 1]!;
      scanlines[o + 2] = rgb[i + 2]!;
      scanlines[o + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // RGBA8
  ihdr[9] = 6;
  writeFileSync(out, Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

it("renders a representative level", () => {
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
  const segments: Seg[] = [...terrain];

  const cam = new OrbitCam(STUB_DOM);
  if (process.env.PREVIEW_RADIUS) cam.radius = Number(process.env.PREVIEW_RADIUS);
  cam.azimuth = AZIMUTH;
  cam.follow(map.hero!.x, map.hero!.y);
  cam.snap();
  cam.resize(WIDTH, HEIGHT);
  cam.update(0);
  cam.camera.updateMatrixWorld(true);
  const plain: Seg[] = [], lit: Seg[] = [];
  buildEntities(map, recorder(plain), TIME, cam.azimuth);
  buildEntities(map, recorder(lit), TIME, cam.azimuth, fx, { highlight: { x: map.hero!.x + 1, y: map.hero!.y } });
  segments.push(...lit);

  const project = projector(cam.camera);
  // The follow camera must put the hero's cell at the centre of the frame.
  const heroPixel = project(new Vector3(map.hero!.x, 0, map.hero!.y));
  expect(heroPixel.x).toBeCloseTo(WIDTH / 2, 0);
  expect(heroPixel.y).toBeCloseTo(HEIGHT / 2, 0);
  expect(segments.length).toBeGreaterThan(0);
  // The atmosphere pass adds strokes the plain pass never draws: the beam's
  // arc runs and the spark bursts off the two lit cells.
  expect(lit.length).toBeGreaterThan(plain.length);

  rasterize(segments, cam.camera, OUT);

  // ---- and the same frame from inside it (F2) -------------------------------
  const fp = new FirstPersonCam(STUB_DOM, { yaw: FP_YAW });
  fp.follow(map.hero!.x, map.hero!.y);
  fp.snap();
  fp.resize(WIDTH, HEIGHT);
  fp.update(0);
  fp.camera.updateMatrixWorld(true);
  const inside: Seg[] = [];
  buildEntities(map, recorder(inside), TIME, (x, y) => fp.facingAt(x, y), fx,
    { hideHero: true });

  // The camera is standing in the hero's cell, so nothing may be drawn there —
  // neither the letterform nor its floor ring.
  const atEye = inside.filter((s) =>
    Math.abs(s.a.x - map.hero!.x) < 0.45 && Math.abs(s.a.z - map.hero!.y) < 0.45);
  expect(atEye).toEqual([]);
  // Every other glyph is still there, and each turned its own way to face the
  // eye rather than sharing one bearing.
  const yaws = new Set([[10, 7], [14, 6], [13, 8]].map(([x, y]) => fp.facingAt(x!, y!)));
  expect(yaws.size).toBe(3);
  expect(inside.length).toBeGreaterThan(0);

  rasterize([...terrain, ...inside], fp.camera, OUT_FP);
});

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
const ANGBAND_ORIGIN = { x: 20, y: 14 };
/** Local cells the assertions name: the three occupied floors, and a plain
 *  floor with four open neighbours to compare their floor edges against. */
const ANG_HERO = { x: 4, y: 5 }, ANG_MONSTER = { x: 6, y: 4 }, ANG_ITEM = { x: 3, y: 4 };
const ANG_PLAIN_FLOOR = { x: 5, y: 3 };

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

/** The four y=0 corner-to-corner edges bounding cell (x, y), however they were
 *  emitted — by the cell itself, or by a neighbour that shares the edge. */
function tileEdges(segments: readonly Seg[], x: number, y: number): Seg[] {
  const corner = (p: Vector3) =>
    p.y === 0 && Math.abs(Math.abs(p.x - x) - 0.5) < 1e-6
    && Math.abs(Math.abs(p.z - y) - 0.5) < 1e-6;
  return segments.filter((s) => corner(s.a) && corner(s.b));
}

it("renders an Angband level through its classifier", () => {
  const clf = new AngbandClassifier();
  const batch: number[] = [];
  ANGBAND_LEVEL.forEach((row, y) =>
    [...row].forEach((ch, x) => batch.push(...angbandRecord(x, y, ch))));
  const classified = clf.classify(new Int32Array(batch));

  const map = new CellGrid(ANGBAND_COLS, ANGBAND_ROWS);
  for (const { x, y, cell } of classified) map.set(x, y, cell);
  expect(map.hero).toEqual({
    x: ANGBAND_ORIGIN.x + ANG_HERO.x, y: ANGBAND_ORIGIN.y + ANG_HERO.y,
  });

  const terrain: Seg[] = [];
  buildTerrain(map, recorder(terrain));
  const world = (c: { x: number; y: number }) =>
    ({ x: ANGBAND_ORIGIN.x + c.x, y: ANGBAND_ORIGIN.y + c.y });

  // A plain floor with four open neighbours: the faint interior edges every
  // occupied floor below must match.
  const control = tileEdges(terrain, world(ANG_PLAIN_FLOOR).x, world(ANG_PLAIN_FLOOR).y);
  expect(control).toHaveLength(4);
  const interior = Math.max(...control.map((s) => s.gain));

  for (const local of [ANG_HERO, ANG_MONSTER, ANG_ITEM]) {
    const { x, y } = world(local);
    const edges = tileEdges(terrain, x, y);
    expect(edges).toHaveLength(4);
    // Under the glyph is floor, drawn as floor: not missing, and not the
    // brighter border a hole in the terrain would put around it.
    expect(Math.max(...edges.map((s) => s.gain))).toBeCloseTo(interior, 6);
  }

  // Drop the underlay the classifier supplied and the same three tiles become
  // holes: their neighbours outline them as the edge of the region.
  const holed = new CellGrid(ANGBAND_COLS, ANGBAND_ROWS);
  for (const { x, y, cell } of classified) {
    const { terrain: _under, ...top } = cell;
    holed.set(x, y, top);
  }
  const holedSegments: Seg[] = [];
  buildTerrain(holed, recorder(holedSegments));
  for (const local of [ANG_HERO, ANG_MONSTER, ANG_ITEM]) {
    const { x, y } = world(local);
    expect(Math.max(...tileEdges(holedSegments, x, y).map((s) => s.gain)))
      .toBeGreaterThan(interior);
  }

  const cam = new OrbitCam(STUB_DOM);
  if (process.env.PREVIEW_RADIUS) cam.radius = Number(process.env.PREVIEW_RADIUS);
  cam.azimuth = AZIMUTH;
  cam.follow(map.hero!.x, map.hero!.y);
  cam.snap();
  cam.resize(WIDTH, HEIGHT);
  cam.update(0);
  cam.camera.updateMatrixWorld(true);
  const entities: Seg[] = [];
  buildEntities(map, recorder(entities), TIME, cam.azimuth);
  expect(entities.length).toBeGreaterThan(0);
  rasterize([...terrain, ...entities], cam.camera, OUT_ANGBAND);

  const fp = new FirstPersonCam(STUB_DOM, { yaw: FP_YAW });
  fp.follow(map.hero!.x, map.hero!.y);
  fp.snap();
  fp.resize(WIDTH, HEIGHT);
  fp.update(0);
  fp.camera.updateMatrixWorld(true);
  const inside: Seg[] = [];
  buildEntities(map, recorder(inside), TIME, (x, y) => fp.facingAt(x, y), undefined,
    { hideHero: true });
  rasterize([...terrain, ...inside], fp.camera, OUT_ANGBAND_FP);
});

// ---- Larn ------------------------------------------------------------------
// Larn's native tap is a small fixed 9-word record. This synthetic level is
// deliberately packed that way rather than assembled as Cells, so the preview
// catches a classifier/layout drift before a real engine frame reaches WebGL.
const LARN_LEVEL = [
  "#############################",
  "#...........#...............#",
  "#..@....!..+#...._....^.....#",
  "#...........#....#..........#",
  "#####/#######....#...B......#",
  "#....<...........#..........#",
  "#.............$..#..........#",
  "#############################",
];
const LARN_ORIGIN = { x: 18, y: 5 };

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

it("renders a Larn level through its native-shaped classifier batch", () => {
  const clf = new LarnClassifier();
  const batch: number[] = [];
  const width = LARN_LEVEL[0]!.length;
  expect(LARN_LEVEL.every((row) => row.length === width)).toBe(true);
  LARN_LEVEL.forEach((row, y) =>
    [...row].forEach((ch, x) => batch.push(...larnRecord(x, y, ch))));
  const map = new CellGrid(LARN_COLS, LARN_ROWS);
  for (const { x, y, cell } of clf.classify(new Int32Array(batch))) map.set(x, y, cell);

  expect(map.hero).toEqual({ x: LARN_ORIGIN.x + 3, y: LARN_ORIGIN.y + 2 });
  expect(map.at(LARN_ORIGIN.x, LARN_ORIGIN.y).category).toBe("wall");
  expect(map.at(LARN_ORIGIN.x + LARN_LEVEL[4]!.indexOf("/"), LARN_ORIGIN.y + 4).category)
    .toBe("door-open");
  expect(map.at(LARN_ORIGIN.x + LARN_LEVEL[2]!.indexOf("_"), LARN_ORIGIN.y + 2).category)
    .toBe("feature");
  expect(map.at(LARN_ORIGIN.x + LARN_LEVEL[2]!.indexOf("^"), LARN_ORIGIN.y + 2).category)
    .toBe("trap");
  expect(map.at(LARN_ORIGIN.x + LARN_LEVEL[4]!.indexOf("B"), LARN_ORIGIN.y + 4).category)
    .toBe("being");
  expect(map.at(LARN_ORIGIN.x + LARN_LEVEL[2]!.indexOf("!"), LARN_ORIGIN.y + 2).category)
    .toBe("item");
  const terrain: Seg[] = [];
  buildTerrain(map, recorder(terrain));
  const cam = new OrbitCam(STUB_DOM);
  if (process.env.PREVIEW_RADIUS) cam.radius = Number(process.env.PREVIEW_RADIUS);
  cam.azimuth = AZIMUTH;
  cam.follow(map.hero!.x, map.hero!.y);
  cam.snap();
  cam.resize(WIDTH, HEIGHT);
  cam.update(0);
  cam.camera.updateMatrixWorld(true);
  const entities: Seg[] = [];
  buildEntities(map, recorder(entities), TIME, cam.azimuth);
  expect(terrain.length).toBeGreaterThan(0);
  expect(entities.length).toBeGreaterThan(0);
  rasterize([...terrain, ...entities], cam.camera, OUT_LARN);
  png(OUT_LARN, OUT_LARN_PNG);

  const fp = new FirstPersonCam(STUB_DOM, { yaw: FP_YAW });
  fp.follow(map.hero!.x, map.hero!.y);
  fp.snap();
  fp.resize(WIDTH, HEIGHT);
  fp.update(0);
  fp.camera.updateMatrixWorld(true);
  const inside: Seg[] = [];
  buildEntities(map, recorder(inside), TIME, (x, y) => fp.facingAt(x, y), undefined,
    { hideHero: true });
  expect(inside.length).toBeGreaterThan(0);
  rasterize([...terrain, ...inside], fp.camera, OUT_LARN_FP);
  png(OUT_LARN_FP, OUT_LARN_FP_PNG);
});

// ---- Moria -----------------------------------------------------------------
// Every cell enters through Moria's seven-word sanitized public ABI. Symbols
// are fixture shorthand only; raw Umoria fval/tval/creature IDs are absent by
// construction, just as they are in the production semantic callback.
const MORIA_LEVEL = [
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
const MORIA_ORIGIN = { x: 40, y: 20 };
const MORIA_HERO = { x: 3, y: 2 };
const MORIA_ITEM = { x: 8, y: 2 };
const MORIA_MONSTER = { x: 21, y: 4 };
const MORIA_CONTROL_FLOOR = { x: 5, y: 3 };

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

it("renders a sanitized Moria level through its native-shaped classifier batch", () => {
  const width = MORIA_LEVEL[0]!.length;
  expect(MORIA_LEVEL.every((row) => row.length === width)).toBe(true);
  const batch: number[] = [];
  MORIA_LEVEL.forEach((row, y) =>
    [...row].forEach((ch, x) => batch.push(...moriaRecord(x, y, ch))));

  const classified = new MoriaClassifier().classify(Int32Array.from(batch));
  const map = new CellGrid(MORIA_COLS, MORIA_ROWS);
  for (const { x, y, cell } of classified) map.set(x, y, cell);
  const world = (cell: { x: number; y: number }) => ({
    x: MORIA_ORIGIN.x + cell.x,
    y: MORIA_ORIGIN.y + cell.y,
  });

  expect(map.hero).toEqual(world(MORIA_HERO));
  expect(map.at(MORIA_ORIGIN.x + 2, MORIA_ORIGIN.y + 6).category).toBe("corridor");
  expect(map.at(MORIA_ORIGIN.x + 5, MORIA_ORIGIN.y + 4).category).toBe("door-open");
  expect(map.at(MORIA_ORIGIN.x + 11, MORIA_ORIGIN.y + 2).category).toBe("door");
  expect(map.at(MORIA_ORIGIN.x + 17, MORIA_ORIGIN.y + 2).kind).toBe("magma-seam");
  expect(map.at(MORIA_ORIGIN.x + 17, MORIA_ORIGIN.y + 7).kind).toBe("quartz-seam");
  expect(map.at(MORIA_ORIGIN.x + 14, MORIA_ORIGIN.y + 6).kind).toBe("rubble");
  expect(map.at(MORIA_ORIGIN.x + 21, MORIA_ORIGIN.y + 6).kind).toBe("store");
  expect(map.at(MORIA_ORIGIN.x + 12, MORIA_ORIGIN.y + 7).category).toBe("unseen");
  expect(map.at(world(MORIA_MONSTER).x, world(MORIA_MONSTER).y)).toMatchObject({
    category: "being", terrain: { category: "floor" },
  });
  expect(map.at(world(MORIA_ITEM).x, world(MORIA_ITEM).y)).toMatchObject({
    category: "item", terrain: { category: "floor" },
  });

  const terrain: Seg[] = [];
  buildTerrain(map, recorder(terrain));
  const control = tileEdges(
    terrain, world(MORIA_CONTROL_FLOOR).x, world(MORIA_CONTROL_FLOOR).y,
  );
  expect(control).toHaveLength(4);
  const interior = Math.max(...control.map((segment) => segment.gain));
  for (const occupied of [MORIA_HERO, MORIA_MONSTER, MORIA_ITEM]) {
    const { x, y } = world(occupied);
    const edges = tileEdges(terrain, x, y);
    expect(edges).toHaveLength(4);
    expect(Math.max(...edges.map((segment) => segment.gain))).toBeCloseTo(interior, 6);
  }

  const holed = new CellGrid(MORIA_COLS, MORIA_ROWS);
  for (const { x, y, cell } of classified) {
    const { terrain: _underlay, ...withoutUnderlay } = cell;
    holed.set(x, y, withoutUnderlay);
  }
  const holedTerrain: Seg[] = [];
  buildTerrain(holed, recorder(holedTerrain));
  for (const occupied of [MORIA_HERO, MORIA_MONSTER, MORIA_ITEM]) {
    const { x, y } = world(occupied);
    expect(Math.max(...tileEdges(holedTerrain, x, y).map((segment) => segment.gain)))
      .toBeGreaterThan(interior);
  }

  const orbit = new OrbitCam(STUB_DOM);
  if (process.env.PREVIEW_RADIUS) orbit.radius = Number(process.env.PREVIEW_RADIUS);
  orbit.azimuth = AZIMUTH;
  orbit.follow(map.hero!.x, map.hero!.y);
  orbit.snap();
  orbit.resize(WIDTH, HEIGHT);
  orbit.update(0);
  orbit.camera.updateMatrixWorld(true);
  const entities: Seg[] = [];
  buildEntities(map, recorder(entities), TIME, orbit.azimuth);
  expect(terrain.length).toBeGreaterThan(0);
  expect(entities.length).toBeGreaterThan(0);
  rasterize([...terrain, ...entities], orbit.camera, OUT_MORIA);
  png(OUT_MORIA, OUT_MORIA_PNG);

  const fp = new FirstPersonCam(STUB_DOM, { yaw: FP_YAW });
  fp.follow(map.hero!.x, map.hero!.y);
  fp.snap();
  fp.resize(WIDTH, HEIGHT);
  fp.update(0);
  fp.camera.updateMatrixWorld(true);
  const inside: Seg[] = [];
  buildEntities(map, recorder(inside), TIME, (x, y) => fp.facingAt(x, y), undefined,
    { hideHero: true });
  expect(inside.length).toBeGreaterThan(0);
  rasterize([...terrain, ...inside], fp.camera, OUT_MORIA_FP);
  png(OUT_MORIA_FP, OUT_MORIA_FP_PNG);
});
