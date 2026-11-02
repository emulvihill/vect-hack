// Hero light radius — a vect-hack quantity, not one from the vector-CRT model: the vector
// look has no light sources, so this stands in for NetHack's lit radius and
// tells near geometry from remembered. This module is its single source.

export const LIGHT = {
  /** Cells around the hero that burn at full brightness. */
  fullRadius: 2.5,
  /** Past this a cell is only remembered, never lit. */
  dimRadius: 11,
  /** Floor gain — remembered geometry still has to read on a black stage. */
  floor: 0.3,
} as const;

/** Brightness at distance `d`: full inside fullRadius, smoothly down to the
 *  floor at dimRadius, and never below it. */
export function lightGain(d: number): number {
  const t = clamp01((d - LIGHT.fullRadius) / (LIGHT.dimRadius - LIGHT.fullRadius));
  const eased = t * t * (3 - 2 * t); // smoothstep: no ring edge where it lands
  return 1 + (LIGHT.floor - 1) * eased;
}

/** Brightness at (x, y) with the hero at (hx, hy). Euclidean: the falloff is a
 *  glow around the hero, not the diamond NetHack's movement rules make. */
export function heroLightGain(hx: number, hy: number, x: number, y: number): number {
  return lightGain(Math.hypot(x - hx, y - hy));
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}
