// The hit flash (spec 2026-08-06): a victim's letterform pulses red on the
// same envelope physics as the effect glow. Physics + color here; the
// per-Module inference is pinned by its own tests.
import { describe, expect, it } from "vitest";
import { Color } from "three/webgpu";
import { CLR } from "../../src/backplane/colors";
import { INK, clr } from "../../src/render/palette";
import { CellGrid, type Cell } from "../../src/backplane/cell";
import { MapFx, type EntityFx } from "../../src/render/effects/mapFx";
import { HIT_RELEASE_S, flashRed } from "../../src/render/effects/hitFx";
import { heat } from "../../src/render/effects/dwell";
import { buildEntities } from "../../src/render/EntityLayer";
import type { LineBatch } from "../../src/render/LineBatch";

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

describe("hit energy field", () => {
  it("fires to full and releases on the hit envelope", () => {
    const fx = new MapFx(80, 21);
    fx.hit(3, 4);
    expect(fx.hitAt(3, 4)).toBe(1);
    expect(fx.hitAt(4, 4)).toBe(0);
    fx.step(HIT_RELEASE_S);
    expect(fx.hitAt(3, 4)).toBeCloseTo(Math.exp(-1), 3);
  });

  it("clear() drops pending hits with the rest of the level", () => {
    const fx = new MapFx(80, 21);
    fx.hit(3, 4);
    fx.clear();
    expect(fx.hitAt(3, 4)).toBe(0);
  });
});

describe("flashRed", () => {
  it("lerps toward the skin's red slot by energy, new instance", () => {
    const base = new Color(0, 1, 0);
    const red = clr(CLR.RED);
    const half = flashRed(base, 0.5);
    expect(half).not.toBe(base);
    expect(half.r).toBeCloseTo(base.r + (red.r - base.r) * 0.5, 5);
    expect(half.g).toBeCloseTo(base.g + (red.g - base.g) * 0.5, 5);
    expect(flashRed(base, 0).getHex()).toBe(base.getHex());
  });
});

function stubFx(hit: number): EntityFx {
  return {
    seed: 0, lightAt: () => 1, energyAt: () => 0, hitAt: () => hit,
    residueAt: (): Cell | null => null, flares: () => [],
  };
}

function monsterGrid(): CellGrid {
  const map = new CellGrid(80, 21);
  map.set(10, 5, { category: "being", ch: "d", color: CLR.YELLOW });
  return map;
}

/** The hero, whose letterform takes its colour from INK.hero rather than from
 *  the cell — the one glyph whose flash lerps a shared palette instance. */
function heroGrid(): CellGrid {
  const map = new CellGrid(80, 21);
  map.set(10, 5, { category: "being", ch: "@", color: CLR.WHITE, hero: true });
  return map;
}

/** A blast, not a victim: cyan so any lerp toward red would show in every
 *  channel. No `beam` hint, so it stays a letterform rather than an arc. */
function effectGrid(): CellGrid {
  const map = new CellGrid(80, 21);
  map.set(10, 5, { category: "effect", ch: "*", color: CLR.CYAN });
  return map;
}

describe("EntityLayer hit pulse", () => {
  it("reddens and brightens a being by hit energy", () => {
    const calm: Seg[] = [], hit: Seg[] = [];
    buildEntities(monsterGrid(), recorder(calm), 0, 0, stubFx(0));
    buildEntities(monsterGrid(), recorder(hit), 0, 0, stubFx(1));
    const base = clr(CLR.YELLOW), red = clr(CLR.RED);
    expect(hit.length).toBe(calm.length);
    expect(calm[0]!.r).toBeCloseTo(base.r, 5);
    expect(hit[0]!.r).toBeCloseTo(red.r, 5);
    expect(hit[0]!.g).toBeCloseTo(red.g, 5);
    expect(hit[0]!.gain).toBeGreaterThan(calm[0]!.gain);
  });

  it("leaves a being untouched at zero hit energy", () => {
    const a: Seg[] = [], b: Seg[] = [];
    buildEntities(monsterGrid(), recorder(a), 0, 0, stubFx(0));
    buildEntities(monsterGrid(), recorder(b), 0, 0, undefined);
    expect(a[0]!.r).toBeCloseTo(b[0]!.r, 5);
    expect(a[0]!.gain).toBeCloseTo(b[0]!.gain, 5);
  });

  // The hero pulses too — a monster hitting you is the commonest flash there
  // is. Its colour is INK.hero, a shared palette instance, so the third build
  // is the real assertion: an in-place lerp would have stained it permanently.
  it("reddens and pops the hero without staining the shared INK.hero", () => {
    const calm: Seg[] = [], hit: Seg[] = [], after: Seg[] = [];
    const ink = INK.hero.clone(), red = clr(CLR.RED);
    buildEntities(heroGrid(), recorder(calm), 0, 0, stubFx(0));
    buildEntities(heroGrid(), recorder(hit), 0, 0, stubFx(1));
    expect(calm[0]!.r).toBeCloseTo(ink.r, 5);
    expect(calm[0]!.g).toBeCloseTo(ink.g, 5);
    expect(hit[0]!.r).toBeCloseTo(red.r, 5);
    expect(hit[0]!.g).toBeCloseTo(red.g, 5);
    expect(hit[0]!.b).toBeCloseTo(red.b, 5);
    expect(hit[0]!.gain).toBeGreaterThan(calm[0]!.gain);

    buildEntities(heroGrid(), recorder(after), 0, 0, stubFx(0));
    expect(after[0]!.r).toBeCloseTo(ink.r, 5);
    expect(after[0]!.g).toBeCloseTo(ink.g, 5);
    expect(after[0]!.b).toBeCloseTo(ink.b, 5);
  });

  // The global constraint, and the one a later simplification of the gate to
  // `fx ? fx.hitAt(x, y) : 0` would silently break: an effect glyph is the
  // blast itself, never its victim. It keeps dwell heat and nothing else.
  it("never reddens or pops an effect glyph", () => {
    const calm: Seg[] = [], hit: Seg[] = [];
    buildEntities(effectGrid(), recorder(calm), 0, 0, stubFx(0));
    buildEntities(effectGrid(), recorder(hit), 0, 0, stubFx(1));
    const base = heat(clr(CLR.CYAN), 0); // stubFx's energyAt is 0: the bare hue
    expect(hit.length).toBe(calm.length);
    for (const s of hit) {
      expect(s.r).toBeCloseTo(base.r, 5);
      expect(s.g).toBeCloseTo(base.g, 5);
      expect(s.b).toBeCloseTo(base.b, 5);
    }
    expect(hit[0]!.gain).toBeCloseTo(calm[0]!.gain, 5);
  });
});
