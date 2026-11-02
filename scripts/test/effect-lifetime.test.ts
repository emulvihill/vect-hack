// Effect lifetime (vect-hack-auo). An effect Cell is the one Cell no record in
// the stream retracts: what clears it is the engine repainting that grid. Today
// it is visible only because Angband paces its own animation with
// Term_xtra(TERM_XTRA_DELAY, delay_factor) and our Cells live across the delay —
// a player who sets delay_factor to 0 from the options menu delivers the set and
// the repaint in one batch, and MapFx.observe(), which samples the grid once per
// frame, never sees a Cell that did not survive a frame.
//
// So the persistence is driven by the effect EVENT, not by a grid-level TTL:
// the Module's view signals `effectFired(x, y, cell)` and MapFx keeps that Cell
// drawable for a fixed wall-clock envelope. The grid stays engine truth, and
// Cell.terrain — already carried — is what shows through once the envelope
// closes.
import { describe, expect, it } from "vitest";
import { CLR } from "../../src/backplane/colors";
import { CellGrid, type Cell } from "../../src/backplane/cell";
import { clr } from "../../src/render/palette";
import { heat } from "../../src/render/effects/dwell";
import { EFFECT_LIFETIME_S, MapFx } from "../../src/render/effects/mapFx";
import { ZAP_HEIGHT, buildEntities } from "../../src/render/EntityLayer";
import type { LineBatch } from "../../src/render/LineBatch";

const COLS = 20, ROWS = 10;

interface Seg {
  ax: number; ay: number; az: number; bx: number; by: number; bz: number;
  r: number; g: number; b: number; gain: number;
}

/** A LineBatch stand-in that keeps every segment the builder emits. */
function recorder(out: Seg[]): LineBatch {
  return {
    begin() { out.length = 0; },
    add(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
        c: { r: number; g: number; b: number }, gain = 1) {
      out.push({ ax, ay, az, bx, by, bz, r: c.r, g: c.g, b: c.b, gain });
    },
    commit() {},
  } as unknown as LineBatch;
}

const atCell = (segs: readonly Seg[], x: number, y: number) =>
  segs.filter((s) => Math.abs(s.ax - x) < 0.8 && Math.abs(s.az - y) < 0.8);

const FLOOR: Cell = { category: "floor", ch: ".", color: CLR.GRAY };
const blast = (ch = "*", color = CLR.RED): Cell =>
  ({ category: "effect", ch, color, terrain: FLOOR });

/** Steps the envelope past its close in frame-sized slices, the way the
 *  renderer does — a single giant dt would not prove it decays. */
function run(fx: MapFx, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) fx.step(dt);
}

describe("MapFx effect residue", () => {
  it("keeps a fired effect drawable though the grid never held it", () => {
    const map = new CellGrid(COLS, ROWS);
    map.set(4, 3, FLOOR);
    const fx = new MapFx(COLS, ROWS);

    expect(fx.residueAt(4, 3)).toBeNull();
    fx.effect(4, 3, blast());
    // The whole point: the grid is sampled every frame and has no effect on it,
    // and that sampling must not retract what the event asserted.
    fx.observe(map);
    expect(fx.residueAt(4, 3)?.ch).toBe("*");
    // The same event also lights the glow envelope, so the residue is drawn hot
    // rather than as a bare hue.
    expect(fx.energyAt(4, 3)).toBe(1);
  });

  it("closes the envelope on wall-clock seconds", () => {
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, blast());
    run(fx, EFFECT_LIFETIME_S * 0.5);
    expect(fx.residueAt(4, 3)).not.toBeNull();
    run(fx, EFFECT_LIFETIME_S * 0.6);
    expect(fx.residueAt(4, 3)).toBeNull();
  });

  it("a second effect on the cell replaces it and restarts the envelope", () => {
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, blast("*"));
    run(fx, EFFECT_LIFETIME_S * 0.9);
    fx.effect(4, 3, blast("|"));
    run(fx, EFFECT_LIFETIME_S * 0.5);
    expect(fx.residueAt(4, 3)?.ch).toBe("|");
  });

  it("a new level drops it with the rest of the field", () => {
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, blast());
    fx.clear();
    expect(fx.residueAt(4, 3)).toBeNull();
  });

  it("does not fire the glow envelope twice when the grid shows the same Cell", () => {
    const map = new CellGrid(COLS, ROWS);
    const cell = blast();
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, cell);
    map.set(4, 3, cell);
    run(fx, 0.2);
    const decayed = fx.energyAt(4, 3);
    expect(decayed).toBeLessThan(1);
    fx.observe(map);
    expect(fx.energyAt(4, 3)).toBeCloseTo(decayed, 6);
  });
});

describe("EntityLayer draws the residue", () => {
  it("draws a blast the engine already erased, and reports it drawn", () => {
    const map = new CellGrid(COLS, ROWS);
    map.set(4, 3, FLOOR);                       // the engine's repaint, already in
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, blast("*", CLR.RED));
    fx.observe(map);

    const segs: Seg[] = [];
    const drawn = buildEntities(map, recorder(segs), 0, 0, fx);
    const mine = atCell(segs, 4, 3);
    expect(drawn).toBe(1);
    expect(mine.length).toBeGreaterThan(0);
    // Drawn as an effect: heated toward white by its own energy, which a floor
    // Cell could never produce.
    const want = heat(clr(CLR.RED), 1);
    expect(mine[0]!.r).toBeCloseTo(want.r, 5);
    expect(mine[0]!.g).toBeCloseTo(want.g, 5);
    expect(mine[0]!.b).toBeCloseTo(want.b, 5);
  });

  it("stops drawing once the envelope closes, leaving the terrain", () => {
    const map = new CellGrid(COLS, ROWS);
    map.set(4, 3, FLOOR);
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, blast());
    run(fx, EFFECT_LIFETIME_S * 1.2);
    fx.observe(map);

    const segs: Seg[] = [];
    const drawn = buildEntities(map, recorder(segs), 0, 0, fx);
    expect(drawn).toBe(0);
    // The glyph is gone. Its spark burst is not, and must not be: the flare
    // rides the glow envelope (0.8s release), which is older physics than this
    // and outlives the letterform at any delay_factor. Sparks lie flat at
    // ZAP_HEIGHT; an EFFECT letterform stands 0.92 cells tall from HOVER, so
    // nothing above that plane is a spark.
    const tall = atCell(segs, 4, 3).filter((s) => Math.max(s.ay, s.by) > ZAP_HEIGHT);
    expect(tall).toEqual([]);
  });

  it("never draws twice while the grid still holds the effect", () => {
    const map = new CellGrid(COLS, ROWS);
    const cell = blast();
    map.set(4, 3, cell);
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, cell);
    fx.observe(map);

    const segs: Seg[] = [];
    expect(buildEntities(map, recorder(segs), 0, 0, fx)).toBe(1);
  });

  it("yields to whatever the engine is showing there now", () => {
    // The residue fills the hole the erase left; it never covers a being the
    // engine is currently drawing, which would hide the blast's own target.
    const map = new CellGrid(COLS, ROWS);
    map.set(4, 3, { category: "being", ch: "k", color: CLR.GREEN, terrain: FLOOR });
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, blast());
    fx.observe(map);

    const segs: Seg[] = [];
    expect(buildEntities(map, recorder(segs), 0, 0, fx)).toBe(0);
    expect(atCell(segs, 4, 3).length).toBeGreaterThan(0);   // the kobold, once
  });

  it("draws a residual beam as a beam, not a letterform", () => {
    const map = new CellGrid(COLS, ROWS);
    map.set(4, 3, FLOOR);
    const fx = new MapFx(COLS, ROWS);
    fx.effect(4, 3, { category: "effect", ch: "-", color: CLR.CYAN, beam: true, terrain: FLOOR });
    fx.observe(map);

    const segs: Seg[] = [];
    expect(buildEntities(map, recorder(segs), 0, 0, fx)).toBe(1);
    // A beam runs border to border so consecutive zap cells join; a letterform
    // in EntityLayer's EFFECT style is 0.92 cells tall and never reaches 4.5.
    expect(Math.max(...atCell(segs, 4, 3).map((s) => s.bx))).toBeGreaterThan(4.45);
  });
});
