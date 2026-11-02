// Entity hit-testing (vect-hack-hqo): a click aimed at a glyph the player can
// see must pick that glyph's cell, not the floor cell the ray happens to land
// on behind it. Pure-math checks against the cell grid's occupancy — the
// scene's line meshes are never raycast, so these run without a GPU.
import { describe, expect, it } from "vitest";
import { Ray, Vector3 } from "three/webgpu";
import { CellGrid } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import { pickEntityCell } from "../../src/render/pick";
import type { GlyphCell } from "../../src/modules/nethack/protocol";

const GLYPH_CONSTANTS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};
const TERRAIN = 610, OBJECT = 520, MONSTER = 12, ZAP = 710;

const cell = (glyph: number, ch: string, color = 7, glyphflags = 0): GlyphCell =>
  ({ glyph, ch, color, glyphflags });

const clf = new NetHackClassifier();
clf.configure(GLYPH_CONSTANTS);

const put = (m: CellGrid, x: number, y: number, g: GlyphCell) =>
  m.set(x, y, clf.classify(g));

function model(): CellGrid {
  return new CellGrid(NETHACK_COLS, NETHACK_ROWS);
}

/** A ray from `from` aimed through `at`, the way a camera ray leaves the eye. */
const ray = (from: [number, number, number], at: [number, number, number]) =>
  new Ray(
    new Vector3(...from),
    new Vector3(...at).sub(new Vector3(...from)).normalize(),
  );

describe("pickEntityCell", () => {
  it("picks the glyph's cell for an oblique ray through the letterform, not the floor cell behind it", () => {
    const m = model();
    put(m, 10, 5, cell(MONSTER, "o"));
    // From a 3/4 camera position, through the letter's upper half at world
    // (10, 0.9, 5). This ray reaches y=0 around z≈2.4 — three cells behind
    // the monster, which is exactly the bug being pinned.
    const hit = pickEntityCell(ray([10, 3, 11], [10, 0.9, 5]), m);
    expect(hit).toEqual({ x: 10, y: 5 });
  });

  it("returns null when the ray crosses no occupied cell, leaving the floor plane to decide", () => {
    const m = model();
    put(m, 10, 5, cell(MONSTER, "o"));
    expect(pickEntityCell(ray([30, 3, 11], [30, 0.9, 5]), m)).toBeNull();
  });

  it("prefers the nearer of two glyphs on the same line of sight", () => {
    const m = model();
    put(m, 10, 5, cell(MONSTER, "o"));
    put(m, 10, 8, cell(MONSTER, "d"));
    const hit = pickEntityCell(ray([10, 0.5, 12], [10, 0.5, 0]), m);
    expect(hit).toEqual({ x: 10, y: 8 });
  });

  it("gives an object its shorter volume: a ray over its head misses, one through it hits", () => {
    const m = model();
    put(m, 10, 5, cell(OBJECT, "("));
    // Objects top out around y≈0.86 where monsters reach ≈1.11: level flight
    // at y=1.0 sails over the object...
    expect(pickEntityCell(ray([10, 1.0, 12], [10, 1.0, 0]), m)).toBeNull();
    // ...but through the middle of the letter it connects.
    expect(pickEntityCell(ray([10, 0.5, 12], [10, 0.5, 0]), m)).toEqual({ x: 10, y: 5 });
  });

  it("never volumes terrain or transient effects, which would eat clicks on the floor behind them", () => {
    const m = model();
    put(m, 10, 5, cell(TERRAIN, "."));
    put(m, 10, 6, cell(ZAP, "|"));
    expect(pickEntityCell(ray([10, 0.5, 12], [10, 0.5, 0]), m)).toBeNull();
  });

  it("skips the hero's own volume when asked, as first person must — the camera stands inside it", () => {
    const m = model();
    put(m, 10, 5, cell(MONSTER, "@", 15, MG.HERO));
    put(m, 10, 3, cell(MONSTER, "o"));
    // The eye inside the hero's cell: distance-0 self-hits would win every click.
    const eye: [number, number, number] = [10, 0.6, 5];
    expect(pickEntityCell(ray(eye, [10, 0.6, 0]), m, { skipHero: true }))
      .toEqual({ x: 10, y: 3 });
    // The orbital camera keeps the hero clickable (chat with an adjacent pet
    // via the hero is nonsense, but targetAt's isHero rows are its business).
    expect(pickEntityCell(ray([10, 3, 11], [10, 0.9, 5]), m)).toEqual({ x: 10, y: 5 });
  });
});
