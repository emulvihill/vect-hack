// What the offline scene previews show, pinned: each Module's frozen level
// (scene-fixtures.ts) through the real classifier, geometry builders and
// cameras. The images themselves are written by scene-preview.ts under
// `npm run preview`; nothing here touches the disk.
import { expect, it } from "vitest";
import { Vector3 } from "three/webgpu";
import { CellGrid } from "../../src/backplane/cell";
import { ANGBAND_COLS, ANGBAND_ROWS } from "../../src/modules/angband/classifier";
import { MORIA_COLS, MORIA_ROWS } from "../../src/modules/moria/classifier";
import { buildTerrain } from "../../src/render/TerrainBuilder";
import {
  ANG_HERO, ANG_ITEM, ANG_MONSTER, ANG_PLAIN_FLOOR, ANGBAND_ORIGIN, HEIGHT,
  LARN_LEVEL, LARN_ORIGIN, MORIA_CONTROL_FLOOR, MORIA_HERO, MORIA_ITEM, MORIA_LEVEL,
  MORIA_MONSTER, MORIA_ORIGIN, WIDTH, angbandScene, larnScene, moriaScene, nethackScene,
  projector, recorder, type Seg,
} from "./scene-fixtures";

/** The four y=0 corner-to-corner edges bounding cell (x, y), however they were
 *  emitted — by the cell itself, or by a neighbour that shares the edge. */
function tileEdges(segments: readonly Seg[], x: number, y: number): Seg[] {
  const corner = (p: Vector3) =>
    p.y === 0 && Math.abs(Math.abs(p.x - x) - 0.5) < 1e-6
    && Math.abs(Math.abs(p.z - y) - 0.5) < 1e-6;
  return segments.filter((s) => corner(s.a) && corner(s.b));
}

it("renders a representative level", () => {
  const { map, terrain, orbit, plain, entities: lit, fp, inside } = nethackScene();
  const segments: Seg[] = [...terrain, ...lit];

  const project = projector(orbit.camera);
  // The follow camera must put the hero's cell at the centre of the frame.
  const heroPixel = project(new Vector3(map.hero!.x, 0, map.hero!.y));
  expect(heroPixel.x).toBeCloseTo(WIDTH / 2, 0);
  expect(heroPixel.y).toBeCloseTo(HEIGHT / 2, 0);
  expect(segments.length).toBeGreaterThan(0);
  // The atmosphere pass adds strokes the plain pass never draws: the beam's
  // arc runs and the spark bursts off the two lit cells.
  expect(lit.length).toBeGreaterThan(plain.length);

  // ---- and the same frame from inside it (F2) -------------------------------
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
});

it("renders an Angband level through its classifier", () => {
  const { map, terrain, classified, entities } = angbandScene();
  expect(map.hero).toEqual({
    x: ANGBAND_ORIGIN.x + ANG_HERO.x, y: ANGBAND_ORIGIN.y + ANG_HERO.y,
  });

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

  expect(entities.length).toBeGreaterThan(0);
});

it("renders a Larn level through its native-shaped classifier batch", () => {
  const width = LARN_LEVEL[0]!.length;
  expect(LARN_LEVEL.every((row) => row.length === width)).toBe(true);
  const { map, terrain, entities, inside } = larnScene();

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
  expect(terrain.length).toBeGreaterThan(0);
  expect(entities.length).toBeGreaterThan(0);
  expect(inside.length).toBeGreaterThan(0);
});

it("renders a sanitized Moria level through its native-shaped classifier batch", () => {
  const width = MORIA_LEVEL[0]!.length;
  expect(MORIA_LEVEL.every((row) => row.length === width)).toBe(true);
  const { map, terrain, classified, entities, inside } = moriaScene();
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

  expect(terrain.length).toBeGreaterThan(0);
  expect(entities.length).toBeGreaterThan(0);
  expect(inside.length).toBeGreaterThan(0);
});
