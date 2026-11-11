import { describe, expect, it } from "vitest";
import { drain, residual } from "../../src/render/effects/persistence";
import { TOKENS } from "../../src/render/palette";

const HL = TOKENS.glow.persistence_half_life_s;
const DRAIN = TOKENS.glow.persistence_drain_per_s;

/** One stamp's residue after `t` seconds at `fps`, stepped the way Trail does it:
 *  subtract the drain, scale by the residual, and clamp at the fresh draw's black. */
function residue(peak: number, t: number, fps: number, perS = DRAIN): number {
  const dt = 1 / fps;
  let x = peak;
  for (let s = 0; s < Math.round(t * fps); s++) x = Math.max(0, (x - drain(dt, perS)) * residual(dt, HL));
  return x;
}

describe("phosphor persistence", () => {
  it("halves once per half-life without the drain", () => {
    expect(residue(1, HL, 60, 0)).toBeCloseTo(0.5, 6);
  });

  it("without the drain, a full-scale stamp is still above zero after 3s", () => {
    expect(residue(1, 3, 60, 0)).toBeGreaterThan(0);
  });

  it("the drain takes a full-scale stamp to true black by 1.5s", () => {
    expect(residue(1, 1.5, 60)).toBe(0);
    expect(residue(1, 1.5, 10)).toBe(0);
  });

  it("the drain takes an overbright stamp to true black by 2.5s", () => {
    expect(residue(8, 2.5, 60)).toBe(0);
  });

  it("the drain barely touches the first half-life", () => {
    expect(residue(1, HL, 60)).toBeGreaterThan(0.47);
  });
});
