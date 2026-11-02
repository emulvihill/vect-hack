// Vertex flares (vector-CRT model §3.3): which lit points get a spark
// burst, how wide it opens, and the hashed rays it throws. Selection is a budget
// problem — every lit vertex is a candidate and only the brightest handful can
// be drawn — and the burst itself is re-rolled on the arc seed, so sparks
// flicker in lockstep with the beams (§3.5).
import { TOKENS } from "../palette";
import { hash01 } from "./arc";

export interface FlareCandidate {
  x: number;
  y: number;
  energy: number;
  id: number;
}

/** One spark, relative to the flare it leaves. */
export interface SparkRay {
  /** Direction from the centre, radians. */
  angle: number;
  /** Reach, in flare radii. */
  length: number;
  intensity: number;
  /** Stroke width, px. */
  width: number;
}

/** Rays start this far off-centre (fraction of the radius) and point outward,
 *  leaving the core disc a pinpoint nucleus rather than a hub. */
export const RAY_START_FRAC = 0.15;

/** Radius at zero energy, as a fraction of the base; energy buys the rest. */
const RADIUS_FLOOR = 0.4;

/** Ray count: four at rest, up to eleven when hot. */
const RAYS_MIN = 4, RAYS_MAX = 11;
const RAYS_HASH = 5, RAYS_ENERGY = 3;

/** Short-biased reach (u², in radii), a floor under the dimmest ray, and a
 *  sub-pixel width spread so no two sparks stroke alike. */
const LEN_MIN = 0.5, LEN_SPREAD = 1.8;
const INTENSITY_MIN = 0.15;
const WIDTH_MIN = 0.8, WIDTH_SPREAD = 1;

/** Drop the sub-threshold candidates, brightest first, capped to the budget.
 *  Ties break on id so the same frame always picks the same flares. */
export function selectFlares(
  cands: readonly FlareCandidate[],
  budget = TOKENS.glow.flare_budget,
  minEnergy = TOKENS.glow.flare_min_energy,
): FlareCandidate[] {
  return cands
    .filter((c) => c.energy >= minEnergy)
    .sort((a, b) => b.energy - a.energy || a.id - b.id)
    .slice(0, budget);
}

/** Flare radius in px: analog scaling, never a binary on/off. */
export function flareRadius(energy: number, basePx: number): number {
  return basePx * (RADIUS_FLOOR + (1 - RADIUS_FLOOR) * clamp01(energy));
}

/** The burst thrown by flare `id` on shift `seed` — an irregular hashed spray,
 *  denser and brighter when hot, identical for the same three arguments. */
export function sparkRays(seed: number, id: number, energy: number): SparkRay[] {
  const e = clamp01(energy);
  const count = RAYS_MIN + hash01(seed, id, 0) * RAYS_HASH + e * RAYS_ENERGY;
  const n = Math.floor(Math.min(Math.max(count, RAYS_MIN), RAYS_MAX));

  const rays: SparkRay[] = [];
  for (let i = 0; i < n; i++) {
    // One hash stream per property, indexed past the count's stream 0.
    const reach = hash01(seed, id, i * 4 + 2);
    rays.push({
      angle: hash01(seed, id, i * 4 + 1) * Math.PI * 2,
      length: LEN_MIN + LEN_SPREAD * reach * reach,
      intensity: e * (INTENSITY_MIN + (1 - INTENSITY_MIN) * hash01(seed, id, i * 4 + 3)),
      width: WIDTH_MIN + WIDTH_SPREAD * hash01(seed, id, i * 4 + 4),
    });
  }
  return rays;
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}
