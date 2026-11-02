// The atmosphere pass wired into the renderer (vect-hack-ojo stage 2): the map
// adapter that turns glyph changes into energy, and the geometry the builders
// emit once one is handed to them. The physics themselves are pinned by
// atmosphere.test.ts; this file pins only the wiring.
import { describe, expect, it } from "vitest";
import { CLR } from "../../src/backplane/colors";
import { INK, TOKENS, clr } from "../../src/render/palette";
import { CellGrid, type Cell } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS as COLNO, NETHACK_ROWS as ROWNO, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import { MapFx, type EntityFx } from "../../src/render/effects/mapFx";
import { LIGHT, heroLightGain } from "../../src/render/effects/lighting";
import { segmentCount } from "../../src/render/effects/arc";
import { RAY_START_FRAC, flareRadius, sparkRays } from "../../src/render/effects/flare";
import { CELL_PX, ZAP_HEIGHT, buildEntities } from "../../src/render/EntityLayer";
import { buildTerrain } from "../../src/render/TerrainBuilder";
import type { LineBatch } from "../../src/render/LineBatch";

/** Synthetic GLYPH_*_OFF values: only the ordering matters to the classifier. */
const GLYPH_OFFSETS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};
const TERRAIN = 610, MONSTER = 12, ZAP = 701, EXPLODE = 805;

interface Seg {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  r: number; g: number; b: number; gain: number;
}

/** A LineBatch stand-in that keeps every segment the builders emit. */
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

const clf = new NetHackClassifier();
clf.configure(GLYPH_OFFSETS);

function blank(): CellGrid {
  return new CellGrid(COLNO, ROWNO);
}

const put = (map: CellGrid, x: number, y: number, glyph: number, ch: string,
             color: number, flags = 0) =>
  map.set(x, y, clf.classify({ glyph, ch, color, glyphflags: flags }));

/** Segments that belong to the cell at (x, y); nothing else reaches this far. */
const atCell = (segs: readonly Seg[], x: number, y: number) =>
  segs.filter((s) => Math.abs(s.ax - x) < 0.8 && Math.abs(s.az - y) < 0.8);

function stubFx(over: Partial<EntityFx> = {}): EntityFx {
  return {
    seed: 3, lightAt: () => 1, energyAt: () => 0, hitAt: () => 0,
    residueAt: (): Cell | null => null, flares: () => [], ...over,
  };
}

// The beam hint itself is the Classifier's, and nethack-classifier.test.ts
// pins it there ("flags the zap range as beam and leaves explosions
// unflagged"); what belongs here is only what the fx pass does with it.

describe("map adapter (MapFx)", () => {
  it("fires a full envelope when an effect appears and releases it in seconds", () => {
    const map = blank();
    const fx = new MapFx(COLNO, ROWNO);
    fx.observe(map);
    expect(fx.energyAt(20, 10)).toBe(0);

    put(map, 20, 10, EXPLODE, "/", CLR.RED);
    fx.observe(map);
    expect(fx.energyAt(20, 10)).toBe(1);

    fx.step(TOKENS.glow.energy_release_s);
    expect(fx.energyAt(20, 10)).toBeCloseTo(Math.exp(-1), 5);
  });

  it("re-fires only when the effect's character changes, not every frame", () => {
    const map = blank();
    const fx = new MapFx(COLNO, ROWNO);
    put(map, 20, 10, ZAP, "-", CLR.YELLOW);
    fx.observe(map);
    fx.step(0.4);
    const decayed = fx.energyAt(20, 10);
    expect(decayed).toBeLessThan(1);

    fx.observe(map); // same glyph still there
    expect(fx.energyAt(20, 10)).toBeCloseTo(decayed, 6);

    put(map, 20, 10, ZAP, "|", CLR.YELLOW);
    fx.observe(map);
    expect(fx.energyAt(20, 10)).toBe(1);
  });

  it("releases a cell the engine took back instead of holding it lit", () => {
    const map = blank();
    const fx = new MapFx(COLNO, ROWNO);
    put(map, 20, 10, EXPLODE, "/", CLR.RED);
    fx.observe(map);
    put(map, 20, 10, TERRAIN, ".", CLR.GRAY);
    fx.observe(map);
    expect(fx.energyAt(20, 10)).toBe(1); // still fading, not re-fired
    for (let i = 0; i < 40; i++) fx.step(0.5);
    expect(fx.energyAt(20, 10)).toBe(0);

    fx.observe(map);
    expect(fx.energyAt(20, 10)).toBe(0); // a floor never re-lights
  });

  it("keys the light on the hero, and lights everything before there is one", () => {
    const map = blank();
    const fx = new MapFx(COLNO, ROWNO);
    fx.observe(map);
    expect(fx.lightAt(40, 3)).toBe(1);

    put(map, 10, 10, MONSTER, "@", CLR.WHITE, MG.HERO);
    fx.observe(map);
    expect(fx.lightAt(10, 10)).toBe(1);
    expect(fx.lightAt(11, 10)).toBe(1); // inside the full radius
    expect(fx.lightAt(60, 10)).toBeCloseTo(LIGHT.floor, 5);
    expect(fx.lightAt(17, 10)).toBeCloseTo(heroLightGain(10, 10, 17, 10), 6);
  });

  it("offers lit cells as flare candidates until they fall under the threshold", () => {
    const map = blank();
    const fx = new MapFx(COLNO, ROWNO);
    put(map, 20, 10, ZAP, "-", CLR.YELLOW);
    fx.observe(map);
    expect(fx.flares()).toEqual([{ x: 20, y: 10, energy: 1, id: 10 * COLNO + 20 }]);

    // Release past flare_min_energy; the candidate has to drop out.
    while (fx.energyAt(20, 10) >= TOKENS.glow.flare_min_energy) fx.step(0.1);
    expect(fx.energyAt(20, 10)).toBeGreaterThan(0);
    expect(fx.flares()).toEqual([]);
  });

  it("advances the arc shift clock and drops everything on a new level", () => {
    const map = blank();
    const fx = new MapFx(COLNO, ROWNO);
    put(map, 20, 10, ZAP, "-", CLR.YELLOW);
    fx.observe(map);
    fx.reseed(TOKENS.arc.shift_period_s * 4);
    expect(fx.seed).toBe(4);

    fx.clear();
    expect(fx.energyAt(20, 10)).toBe(0);
    expect(fx.flares()).toEqual([]);
    expect(fx.lightAt(60, 10)).toBe(1);
  });
});

describe("entity light (EntityLayer)", () => {
  const lit = (fx?: EntityFx) => {
    const map = blank();
    put(map, 5, 5, MONSTER, "@", CLR.WHITE, MG.HERO);
    put(map, 30, 5, MONSTER, "d", CLR.YELLOW);
    const segs: Seg[] = [];
    buildEntities(map, recorder(segs), 1.7, 0.35, fx);
    return { hero: atCell(segs, 5, 5), far: atCell(segs, 30, 5) };
  };

  it("burns everything at full gain without an fx", () => {
    const { far } = lit();
    expect(far.length).toBeGreaterThan(0);
    expect(Math.max(...far.map((s) => s.gain))).toBeCloseTo(1, 6);
  });

  it("dims a distant monster by the hero light and leaves the hero alone", () => {
    const light = heroLightGain(5, 5, 30, 5);
    expect(light).toBeCloseTo(LIGHT.floor, 5);
    const { hero, far } = lit(stubFx({ lightAt: (x, y) => heroLightGain(5, 5, x, y) }));
    expect(Math.max(...far.map((s) => s.gain))).toBeCloseTo(light, 6);
    expect(Math.max(...hero.map((s) => s.gain))).toBeCloseTo(1, 6);
  });
});

describe("dwell heat (EntityLayer)", () => {
  it("rides an effect glyph to white at full energy, and not without an fx", () => {
    const map = blank();
    put(map, 30, 5, EXPLODE, "/", CLR.RED);
    const segs: Seg[] = [];
    buildEntities(map, recorder(segs), 1.7, 0.35, stubFx({ energyAt: () => 1 }));
    const hot = atCell(segs, 30, 5);
    expect(hot.length).toBeGreaterThan(0);
    for (const s of hot) {
      expect(s.r).toBeCloseTo(1, 6);
      expect(s.g).toBeCloseTo(1, 6);
      expect(s.b).toBeCloseTo(1, 6);
    }

    const cold: Seg[] = [];
    buildEntities(map, recorder(cold), 1.7, 0.35);
    expect(Math.min(...atCell(cold, 30, 5).map((s) => s.g))).toBeLessThan(0.5);
  });
});

describe("zap beams (EntityLayer)", () => {
  const beam = (ch: string, energy = 1) => {
    const map = blank();
    put(map, 30, 5, ZAP, ch, CLR.YELLOW);
    const segs: Seg[] = [];
    buildEntities(map, recorder(segs), 1.7, 0.35,
      stubFx({ seed: 9, energyAt: () => energy }));
    return segs;
  };

  it("replaces the letterform with an arc-jittered polyline across the cell", () => {
    const segs = beam("-");
    const id = 5 * COLNO + 30;
    expect(segs).toHaveLength(segmentCount(CELL_PX, 9, id));
    for (const s of segs) {
      expect(s.ay).toBe(ZAP_HEIGHT);
      expect(s.by).toBe(ZAP_HEIGHT);
    }
    // One connected polyline, pinned to the cell borders it spans.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.ax).toBeCloseTo(segs[i - 1]!.bx, 9);
      expect(segs[i]!.az).toBeCloseTo(segs[i - 1]!.bz, 9);
    }
    expect(segs[0]!.ax).toBeCloseTo(29.5, 9);
    expect(segs[0]!.az).toBeCloseTo(5, 9);
    expect(segs.at(-1)!.bx).toBeCloseTo(30.5, 9);
    expect(segs.at(-1)!.bz).toBeCloseTo(5, 9);
    // ...and bent off it in between.
    expect(segs.some((s) => Math.abs(s.bz - 5) > 1e-6)).toBe(true);
  });

  it("spans the vertical and both diagonals, jittering across the beam", () => {
    const vertical = beam("|");
    expect(vertical[0]!.az).toBeCloseTo(4.5, 9);
    expect(vertical.at(-1)!.bz).toBeCloseTo(5.5, 9);
    expect(vertical.some((s) => Math.abs(s.bx - 30) > 1e-6)).toBe(true);

    const back = beam("\\");
    expect(back[0]!.ax).toBeCloseTo(29.5, 9);
    expect(back[0]!.az).toBeCloseTo(4.5, 9);
    expect(back.at(-1)!.bx).toBeCloseTo(30.5, 9);
    expect(back.at(-1)!.bz).toBeCloseTo(5.5, 9);

    const fwd = beam("/");
    expect(fwd[0]!.az).toBeCloseTo(5.5, 9);
    expect(fwd.at(-1)!.bz).toBeCloseTo(4.5, 9);
  });

  it("draws a white carrier with streaks in the zap's own colour", () => {
    const isWhite = (s: Seg) => s.r === 1 && s.g === 1 && s.b === 1;
    const segs = beam("-");
    const white = segs.filter(isWhite);
    const streak = segs.filter((s) => !isWhite(s));
    expect(white.length).toBeGreaterThan(0);
    expect(streak.length).toBeGreaterThan(0);
    const yellow = clr(CLR.YELLOW);
    for (const s of streak) expect([s.r, s.g, s.b]).toEqual([yellow.r, yellow.g, yellow.b]);

    // Brightness breathes with energy: 0.55 + 0.45 * energy (vector-CRT model §3.5).
    expect(Math.max(...white.map((s) => s.gain))).toBeCloseTo(0.85, 6);
    expect(Math.max(...streak.map((s) => s.gain))).toBeCloseTo(1, 6);
    expect(Math.max(...beam("-", 0).filter(isWhite).map((s) => s.gain)))
      .toBeCloseTo(0.85 * 0.55, 6);
  });

  it("leaves non-beam characters in the zap range as letterforms", () => {
    const map = blank();
    put(map, 30, 5, ZAP, "*", CLR.YELLOW);
    const segs: Seg[] = [];
    buildEntities(map, recorder(segs), 1.7, 0.35, stubFx({ energyAt: () => 1 }));
    expect(segs.some((s) => s.ay !== ZAP_HEIGHT)).toBe(true);
  });
});

describe("spark flares (EntityLayer)", () => {
  it("throws the selected candidate's hashed rays outward from its cell", () => {
    const map = blank();
    const segs: Seg[] = [];
    const cand = { x: 30, y: 5, energy: 1, id: 5 * COLNO + 30 };
    buildEntities(map, recorder(segs), 1.7, 0.35, stubFx({ seed: 9, flares: () => [cand] }));

    const rays = sparkRays(9, cand.id, 1);
    expect(rays.length).toBeGreaterThanOrEqual(4);
    expect(segs).toHaveLength(rays.length);

    const r = flareRadius(1, 0.45);
    for (const s of segs) {
      expect(s.ay).toBe(ZAP_HEIGHT);
      expect(Math.hypot(s.ax - 30, s.az - 5)).toBeCloseTo(RAY_START_FRAC * r, 6);
      expect(Math.hypot(s.bx - 30, s.bz - 5)).toBeGreaterThan(RAY_START_FRAC * r);
      expect(s.r).toBe(1); // white
    }
    expect(segs.map((s) => s.gain)).toEqual(rays.map((ray) => ray.intensity));
  });
});

describe("terrain light (TerrainBuilder)", () => {
  const LEVEL = [
    "-------",
    "|.....|",
    "|.}...|",
    "|.....|",
    "-------",
  ];

  const build = (lightAt?: (x: number, y: number) => number) => {
    const map = blank();
    LEVEL.forEach((row, y) =>
      [...row].forEach((ch, x) =>
        put(map, 10 + x, 5 + y, TERRAIN, ch, ch === "}" ? CLR.RED : CLR.GRAY)));
    const segs: Seg[] = [];
    buildTerrain(map, recorder(segs), lightAt);
    return segs;
  };

  it("dims every cell by the light but never the self-luminous lava", () => {
    const plain = build();
    const dim = build(() => 0.5);
    expect(dim).toHaveLength(plain.length);

    let dimmed = 0, lava = 0;
    for (let i = 0; i < plain.length; i++) {
      const a = plain[i]!, b = dim[i]!;
      expect(b.ax).toBe(a.ax);
      if (a.r === INK.lava.r && a.g === INK.lava.g && a.b === INK.lava.b) {
        expect(b.gain).toBeCloseTo(a.gain, 9); // lava burns at its own gain
        lava++;
      } else if (b.gain < a.gain) {
        expect(b.gain).toBeCloseTo(a.gain * 0.5, 9);
        dimmed++;
      }
    }
    expect(lava).toBeGreaterThan(0);
    expect(dimmed).toBeGreaterThan(0);
  });
});
