// Hit flash (spec 2026-08-06): a victim's letterform lerps toward the skin's
// red and pops brighter, on the same envelope physics as the effect glow
// (signal.ts) — an adapter over EnergyField, not new physics. Constants live
// here, not in the vendored token file (see the spec's constraints).
import { Color } from "three/webgpu";
import { CLR } from "../../backplane/colors";
import { clr } from "../palette";

/** Release of the hit envelope, seconds. Short: a flinch, not a glow. */
export const HIT_RELEASE_S = 0.3;

/** Extra letterform gain at full hit energy (multiplier is 1 + HIT_POP * e). */
export const HIT_POP = 0.6;

/** Per-channel lerp of `base` toward the skin's red by energy. New Color —
 *  the palette hands out shared instances (same contract as dwell's heat). */
export function flashRed(base: Color, energy: number): Color {
  const t = Math.min(Math.max(energy, 0), 1);
  const red = clr(CLR.RED);
  return new Color(
    base.r + (red.r - base.r) * t,
    base.g + (red.g - base.g) * t,
    base.b + (red.b - base.b) * t,
  );
}
