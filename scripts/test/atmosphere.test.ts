// The atmosphere pass's pure physics, pinned to the vector-CRT model's numbers so the
// renderer wiring can't drift from them (vect-hack-ojo).
import { describe, expect, it } from "vitest";
import { Color } from "three/webgpu";
import { TOKENS } from "../../src/render/palette";
import { EnergyField } from "../../src/render/effects/signal";
import { heat } from "../../src/render/effects/dwell";
import { selectFlares, flareRadius, sparkRays } from "../../src/render/effects/flare";
import { hash01, arcSeed, segmentCount, arcOffsets, arcRuns } from "../../src/render/effects/arc";
import { fadeAlpha, residual } from "../../src/render/effects/persistence";
import { lightGain, LIGHT } from "../../src/render/effects/lighting";

describe("energy envelope (model §2)", () => {
  it("attacks instantly to the clamped amplitude", () => {
    const f = new EnergyField();
    f.fire(7, 1.6);
    expect(f.at(7)).toBe(1);
    f.fire(8, 0.4);
    expect(f.at(8)).toBe(0.4);
  });

  it("releases exponentially in seconds, frame-rate independent", () => {
    const a = new EnergyField();
    const b = new EnergyField();
    a.fire(1, 1);
    b.fire(1, 1);
    a.step(0.5, 0.8);
    for (let i = 0; i < 50; i++) b.step(0.01, 0.8);
    expect(a.at(1)).toBeCloseTo(Math.exp(-0.5 / 0.8), 5);
    expect(b.at(1)).toBeCloseTo(a.at(1), 5);
  });

  it("defaults release to the token file's energy_release_s", () => {
    const f = new EnergyField();
    f.fire(1, 1);
    f.step(1);
    expect(f.at(1)).toBeCloseTo(Math.exp(-1 / TOKENS.glow.energy_release_s), 5);
  });

  it("drops fully-released ids instead of iterating them forever", () => {
    const f = new EnergyField();
    f.fire(1, 1);
    for (let i = 0; i < 60; i++) f.step(1);
    expect([...f.entries()]).toHaveLength(0);
    expect(f.at(1)).toBe(0);
  });
});

describe("dwell heat (model §3.1)", () => {
  it("lerps base toward white by energy, per channel", () => {
    const base = new Color(0.2, 0.4, 1.0);
    const half = heat(base, 0.5);
    expect(half.r).toBeCloseTo(0.6);
    expect(half.g).toBeCloseTo(0.7);
    expect(half.b).toBeCloseTo(1.0);
    expect(heat(base, 0).getHex()).toBe(base.getHex());
    expect(heat(base, 1).getHex()).toBe(0xffffff);
  });

  it("clamps energy and never mutates the shared base colour", () => {
    const base = new Color(0.2, 0.4, 1.0);
    expect(heat(base, 9).getHex()).toBe(0xffffff);
    expect(base.r).toBeCloseTo(0.2);
  });
});

describe("vertex flares (model §3.3)", () => {
  const c = (id: number, energy: number) => ({ x: id, y: 0, energy, id });

  it("drops sub-threshold candidates, sorts brightest first, caps to budget", () => {
    const picked = selectFlares([c(3, 0.5), c(1, 0.9), c(2, 0.05), c(4, 0.7)], 2, 0.15);
    expect(picked.map((p) => p.id)).toEqual([1, 4]);
  });

  it("breaks energy ties by id ascending, deterministically", () => {
    const picked = selectFlares([c(5, 0.5), c(2, 0.5), c(9, 0.5)], 3, 0.15);
    expect(picked.map((p) => p.id)).toEqual([2, 5, 9]);
  });

  it("defaults budget and threshold to the token file", () => {
    const many = Array.from({ length: 60 }, (_, i) => c(i, 1));
    expect(selectFlares(many)).toHaveLength(TOKENS.glow.flare_budget);
    expect(selectFlares([c(1, TOKENS.glow.flare_min_energy - 0.01)])).toHaveLength(0);
  });

  it("scales radius as base * (0.4 + 0.6 * energy)", () => {
    expect(flareRadius(0, 10)).toBeCloseTo(4);
    expect(flareRadius(1, 10)).toBeCloseTo(10);
    expect(flareRadius(2, 10)).toBeCloseTo(10); // clamped
  });

  it("re-rolls 4-11 deterministic rays, denser when hot", () => {
    const cold = sparkRays(12, 3, 0);
    const same = sparkRays(12, 3, 0);
    expect(cold).toEqual(same);
    expect(cold.length).toBeGreaterThanOrEqual(4);
    for (let seed = 0; seed < 20; seed++) {
      const rays = sparkRays(seed, 1, 1);
      expect(rays.length).toBeGreaterThanOrEqual(4);
      expect(rays.length).toBeLessThanOrEqual(11);
      for (const r of rays) {
        expect(r.length).toBeGreaterThanOrEqual(0.5);
        expect(r.length).toBeLessThanOrEqual(2.3);
        expect(r.intensity).toBeGreaterThan(0);
        expect(r.intensity).toBeLessThanOrEqual(1);
      }
    }
    expect(sparkRays(12, 3, 0)).not.toEqual(sparkRays(13, 3, 0)); // re-rolled by seed
  });
});

describe("arc jitter (model §3.5)", () => {
  it("hashes deterministically into [0, 1)", () => {
    for (let i = 0; i < 100; i++) {
      const v = hash01(i * 7, i * 13, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(hash01(i * 7, i * 13, i)).toBe(v);
    }
    expect(hash01(1, 2, 3)).not.toBe(hash01(2, 2, 3));
    expect(hash01(1, 2, 3)).not.toBe(hash01(1, 3, 3));
    expect(hash01(1, 2, 3)).not.toBe(hash01(1, 2, 4));
  });

  it("quantizes the shift clock to whole periods", () => {
    const p = TOKENS.arc.shift_period_s;
    expect(arcSeed(0)).toBe(0);
    expect(arcSeed(p * 3.7)).toBe(3);
    expect(arcSeed(p * 3.7)).toBe(arcSeed(p * 3.2)); // frozen between quanta
  });

  it("breathes segment count with the seed around len/seg_len", () => {
    const len = TOKENS.arc.seg_len_px * 4;
    for (let seed = 0; seed < 10; seed++) {
      const n = segmentCount(len, seed, 5);
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(4 + Math.round(TOKENS.arc.seg_var * 4));
      expect(Number.isInteger(n)).toBe(true);
    }
    expect(segmentCount(1, 0, 0)).toBe(1); // never below one segment
  });

  it("pins endpoints and bounds interior displacement by amp", () => {
    const offs = arcOffsets(5, 42, 7, 3);
    expect(offs).toHaveLength(6);
    expect(offs[0]).toBe(0);
    expect(offs[5]).toBe(0);
    let moved = false;
    for (let i = 1; i < 5; i++) {
      expect(Math.abs(offs[i]!)).toBeLessThanOrEqual(3);
      if (offs[i] !== 0) moved = true;
    }
    expect(moved).toBe(true);
    expect(arcOffsets(5, 42, 7, 3)).toEqual(offs);        // frozen per seed
    expect(arcOffsets(5, 43, 7, 3)).not.toEqual(offs);    // re-rolled per seed
  });

  it("merges consecutive same-tint segments into runs covering the beam", () => {
    for (let seed = 0; seed < 10; seed++) {
      const runs = arcRuns(8, seed, 3);
      expect(runs[0]!.from).toBe(0);
      expect(runs.at(-1)!.to).toBe(8);
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i]!.from).toBe(runs[i - 1]!.to);       // contiguous
        expect(runs[i]!.streak).not.toBe(runs[i - 1]!.streak); // merged
      }
    }
    expect(arcRuns(8, 5, 3, 0).every((r) => !r.streak)).toBe(true);
    expect(arcRuns(8, 5, 3, 1).every((r) => r.streak)).toBe(true);
  });
});

describe("phosphor persistence (model §3.4)", () => {
  it("halves the residual every half-life at any frame rate", () => {
    const hl = TOKENS.glow.persistence_half_life_s;
    expect(1 - fadeAlpha(hl, hl)).toBeCloseTo(0.5, 6);
    // residual after 1s of 60fps fades == residual after 1s of 30fps fades
    const at = (dt: number) => (1 - fadeAlpha(dt, hl)) ** (1 / dt);
    expect(at(1 / 60)).toBeCloseTo(at(1 / 30), 5);
  });

  it("fades nothing over zero time and everything over many half-lives", () => {
    expect(fadeAlpha(0, 0.3)).toBe(0);
    expect(fadeAlpha(30, 0.3)).toBeCloseTo(1, 6);
  });

  it("carries the surviving fraction as the complement of the fade", () => {
    const hl = TOKENS.glow.persistence_half_life_s;
    expect(residual(hl, hl)).toBeCloseTo(0.5, 12);
    expect(residual(hl * 2, hl)).toBeCloseTo(0.25, 12);
    expect(residual(0, hl)).toBe(1);
    for (const dt of [0, 1 / 240, 1 / 60, 1 / 30, 0.1, 2]) {
      expect(residual(dt, hl)).toBeCloseTo(1 - fadeAlpha(dt, hl), 12);
    }
  });
});

describe("hero light radius (vect-hack adapter)", () => {
  it("burns full inside the full radius and floors far away, monotonically", () => {
    expect(lightGain(0)).toBe(1);
    expect(lightGain(LIGHT.fullRadius)).toBe(1);
    expect(lightGain(LIGHT.dimRadius)).toBeCloseTo(LIGHT.floor, 5);
    expect(lightGain(1000)).toBeCloseTo(LIGHT.floor, 5);
    let prev = 1;
    for (let d = 0; d < 20; d += 0.25) {
      const g = lightGain(d);
      expect(g).toBeLessThanOrEqual(prev + 1e-9);
      expect(g).toBeGreaterThanOrEqual(LIGHT.floor - 1e-9);
      prev = g;
    }
  });
});
