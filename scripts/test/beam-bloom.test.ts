// beamLayers() is a direct adapter of the vector-CRT model §3.2. Pin it so a
// tweak to the local renderer can't quietly drift away from it.
import { describe, expect, it } from "vitest";
import { beamLayers, ghostSplit } from "../../src/render/LineBatch";
import { TOKENS } from "../../src/render/palette";

describe("beam bloom layers", () => {
  it("runs widest/dimmest halo first, thinnest/brightest core last", () => {
    const layers = beamLayers(TOKENS.glow.beam_layers);
    expect(layers).toHaveLength(TOKENS.glow.beam_layers);
    expect(layers[0]).toEqual({ widthMul: 4, alpha: 0.1 });
    expect(layers.at(-1)).toEqual({ widthMul: 1, alpha: 1 });
  });

  it("eases alpha by t^2 and width linearly", () => {
    const [halo, mid, core] = beamLayers(3);
    expect(mid!.widthMul).toBeCloseTo(2.5);           // halfway from 4 to 1
    expect(mid!.alpha).toBeCloseTo(0.1 + 0.9 * 0.25); // t^2 at t = 0.5
    expect(halo!.widthMul).toBeGreaterThan(core!.widthMul);
  });

  it("collapses to a single core stroke when bloom is off", () => {
    expect(beamLayers(1)).toEqual([{ widthMul: 1, alpha: 1 }]);
  });
});

describe("ghost split", () => {
  it("main and ghost alphas sum back to the layer's alpha, per layer", () => {
    const layers = beamLayers(3);
    const { main, ghost } = ghostSplit(layers, 0.35);
    layers.forEach((l, i) => {
      expect(main[i]! + ghost[i]!).toBeCloseTo(l.alpha);
      expect(ghost[i]!).toBeCloseTo(l.alpha * 0.35);
    });
  });
  it("keeps the halo/core ramp shape in both passes", () => {
    const { main, ghost } = ghostSplit(beamLayers(3), 0.5);
    expect(main[0]!).toBeLessThan(main[2]!);
    expect(ghost[0]!).toBeLessThan(ghost[2]!);
  });
});
