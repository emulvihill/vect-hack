// Level-geometry construction, driven by a synthetic map instead of the engine
// so the checks stay fast and deterministic. The glyph-classification pins
// moved out with the Backplane extraction: the classification itself lives in
// nethack-classifier.test.ts, the grid mechanics in backplane-cell.test.ts.
import { describe, expect, it } from "vitest";
import type { Color } from "three/webgpu";
import { CellGrid } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import { buildTerrain } from "../../src/render/TerrainBuilder";
import { buildEntities } from "../../src/render/EntityLayer";
import { INK } from "../../src/render/palette";
import type { LineBatch } from "../../src/render/LineBatch";
import type { GlyphCell } from "../../src/modules/nethack/protocol";

// Stand-in for the GLYPH_*_OFF values libnhmain exports; only the ordering and
// the relative gaps matter to the classifier.
const GLYPH_CONSTANTS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};

const cell = (glyph: number, ch: string, color = 7, glyphflags = 0): GlyphCell =>
  ({ glyph, ch, color, glyphflags });

const TERRAIN = 610, OBJECT = 520, MONSTER = 12, ZAP = 710, UNEXPLORED = 1500;

const clf = new NetHackClassifier();
clf.configure(GLYPH_CONSTANTS);

/** The engine's own pipeline in one call: glyph -> Classifier -> grid. */
const put = (m: CellGrid, x: number, y: number, g: GlyphCell) =>
  m.set(x, y, clf.classify(g));

function model(): CellGrid {
  return new CellGrid(NETHACK_COLS, NETHACK_ROWS);
}

/** A 5x3 room outline with a floor interior, at map origin (10, 5). */
function room(m: CellGrid): void {
  const rows = ["-----", "|...|", "-----"];
  rows.forEach((row, dy) =>
    [...row].forEach((ch, dx) =>
      put(m, 10 + dx, 5 + dy, cell(TERRAIN, ch))));
}

type Point = readonly [number, number, number];
interface Segment { key: string; a: Point; b: Point; color: string; gain: number }

function recordingBatch(): { batch: LineBatch; segments: Segment[] } {
  const segments: Segment[] = [];
  const batch = {
    begin() { segments.length = 0; },
    add(
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      color: Color, gain = 1,
    ) {
      segments.push({
        key: [ax, ay, az, bx, by, bz].map((v) => v.toFixed(3)).join(),
        a: [ax, ay, az], b: [bx, by, bz], color: color.getHexString(), gain,
      });
    },
    commit() {},
  } as unknown as LineBatch;
  return { batch, segments };
}

describe("buildTerrain", () => {
  it("draws lava differently from water, not just in another colour", () => {
    const pool = (color: number) => {
      const m = model();
      put(m, 1, 1, cell(TERRAIN, "}", color));
      const { batch, segments } = recordingBatch();
      buildTerrain(m, batch);
      return segments.map((s) => s.key);
    };
    const water = pool(4), lava = pool(1);
    expect(water.length).toBe(lava.length);
    // Colour alone would leave the geometry identical; the crests must differ so
    // lava still reads as lava edge-on or to a colour-blind player.
    expect(lava).not.toEqual(water);
  });

  it("emits geometry for a room and never draws an edge twice", () => {
    const m = model();
    room(m);
    const { batch, segments } = recordingBatch();
    buildTerrain(m, batch);
    expect(segments.length).toBeGreaterThan(0);
    expect(new Set(segments.map((s) => s.key)).size).toBe(segments.length);
  });

  it("emits nothing for an unexplored level", () => {
    const { batch, segments } = recordingBatch();
    buildTerrain(model(), batch);
    expect(segments).toHaveLength(0);
  });

  it("frames a trap in the danger ink with a closed square, on top of its flat glyph", () => {
    const m = model();
    put(m, 4, 4, cell(TERRAIN, "^"));
    const { batch, segments } = recordingBatch();
    buildTerrain(m, batch);
    const frame = segments.filter((s) => s.color === INK.trap.getHexString());
    expect(frame).toHaveLength(4);
    // A closed loop: exactly four distinct corners, each shared by two sides.
    const points = frame.flatMap((s) => [s.a, s.b]);
    expect(new Set(points.map((p) => p.join())).size).toBe(4);
    for (const [px, py, pz] of points) {
      expect(px).toBeGreaterThan(3.5); expect(px).toBeLessThan(4.5);
      expect(pz).toBeGreaterThan(3.5); expect(pz).toBeLessThan(4.5);
      expect(py).toBeGreaterThan(0); // lifted clear of the floor grid
    }
  });

  // --- vect-hack-03t: darkness must not dim a lethal marker. Only the frame
  // is exempt — visibility is the engine's call, not this layer's: an
  // undiscovered trap is never sent as a glyph at all, so nothing here can
  // reveal one.
  it("self-lights the trap's danger frame in darkness, while the glyph and floor still dim", () => {
    const build = (lightAt?: (x: number, y: number) => number) => {
      const m = model();
      room(m);
      put(m, 12, 6, cell(TERRAIN, "^"));
      const { batch, segments } = recordingBatch();
      buildTerrain(m, batch, lightAt);
      return segments;
    };
    const lit = build();
    const dark = build(() => 0.2);
    const frame = (segs: typeof lit) => segs.filter((s) => s.color === INK.trap.getHexString());
    const rest = (segs: typeof lit) => segs.filter((s) => s.color !== INK.trap.getHexString());

    expect(frame(dark)).toHaveLength(4);
    expect(frame(dark).map((s) => s.gain)).toEqual(frame(lit).map((s) => s.gain));
    // The exemption is the frame's alone: the trap glyph, the floor under it
    // and the room around it all dim, or the trapped tile would read as the
    // one lit floor on a dark level.
    rest(dark).forEach((s, i) => expect(s.gain).toBeCloseTo(rest(lit)[i]!.gain * 0.2));
  });

  it("does not frame a plain feature the way it frames a trap", () => {
    const m = model();
    put(m, 4, 4, cell(TERRAIN, "_")); // an altar: a feature, not a danger
    const { batch, segments } = recordingBatch();
    buildTerrain(m, batch);
    expect(segments.filter((s) => s.color === INK.trap.getHexString())).toHaveLength(0);
  });
});

describe("buildEntities", () => {
  /** Segments drawn for a hero at (20,8) with the cursor wherever given. */
  const withCursor = (cursor: { x: number; y: number } | null) => {
    const m = model();
    put(m, 20, 8, cell(MONSTER, "@", 15, MG.HERO));
    m.cursor = cursor;
    const { batch, segments } = recordingBatch();
    buildEntities(m, batch, 0, 0);
    return segments.length;
  };

  it("draws the getpos reticle once the cursor leaves the hero", () => {
    const parked = withCursor({ x: 20, y: 8 });
    // Parked on the hero the reticle is suppressed — the hero ring already
    // marks that cell, so drawing it there would be permanent clutter.
    expect(withCursor(null)).toBe(parked);
    expect(withCursor({ x: 14, y: 8 })).toBeGreaterThan(parked);
  });

  it("draws letterforms only for beings, items and effects — never terrain or unseen", () => {
    const m = model();
    put(m, 1, 1, cell(TERRAIN, "-"));      // wall
    put(m, 2, 1, cell(TERRAIN, "."));      // floor
    put(m, 3, 1, cell(UNEXPLORED, " "));   // unseen
    const { batch, segments } = recordingBatch();
    buildEntities(m, batch, 0, 0);
    expect(segments).toHaveLength(0);      // nothing but terrain: no letterforms
    // One drawn category at a time: a single check after adding all three
    // would pass on the being alone and say nothing about the other two.
    put(m, 4, 1, cell(MONSTER, "d"));
    buildEntities(m, batch, 0, 0);
    const being = segments.length;
    expect(being).toBeGreaterThan(0);
    put(m, 5, 1, cell(OBJECT, "("));
    buildEntities(m, batch, 0, 0);
    const item = segments.length;
    expect(item).toBeGreaterThan(being);
    // A zap with no fx handed in: EntityLayer's beam path needs the energy
    // field, so an effect falls through to its letterform here.
    put(m, 6, 1, cell(ZAP, "|"));
    buildEntities(m, batch, 0, 0);
    expect(segments.length).toBeGreaterThan(item);
  });
});
