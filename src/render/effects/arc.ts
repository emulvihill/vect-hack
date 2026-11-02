// Arc — electric beam jitter (vector-CRT model §3.5): the hash every
// atmosphere effect re-rolls on, the wall-clock quantum that freezes a pattern
// between re-rolls, and the subdivision, displacement and tint runs one beam is
// drawn from. Stateless by construction — a beam's shape is a pure function of
// its seed, so a frozen figure costs nothing to remember and a variable frame
// rate can't smear it.
import { TOKENS } from "../palette";

/** splitmix32's increment and finalizing multipliers. */
const GOLDEN = 0x9e3779b9;
const MIX_A = 0x21f0aaad, MIX_B = 0x735a2d97;

/** One splitmix32 round: int32 in, full 32-bit avalanche out. */
function mix32(x: number): number {
  let z = (x + GOLDEN) | 0;
  z = Math.imul(z ^ (z >>> 16), MIX_A);
  z = Math.imul(z ^ (z >>> 15), MIX_B);
  return (z ^ (z >>> 15)) >>> 0;
}

/** Stateless hash of three ints into [0, 1). No PRNG object, no sequence. */
export function hash01(a: number, b: number, c: number): number {
  return mix32(mix32(mix32(a) ^ b) ^ c) / 2 ** 32;
}

/** Which shift quantum wall-clock `tSeconds` falls in. Whole periods only:
 *  between them the figure is frozen, and each one snaps a new pattern. */
export function arcSeed(tSeconds: number, shiftPeriod = TOKENS.arc.shift_period_s): number {
  return Math.floor(tSeconds / shiftPeriod);
}

// Hash streams. Displacement reads the line id raw, so the count and the tint
// are pushed far enough away that neither correlates with where the beam bends.
const COUNT_STREAM = 301, TINT_STREAM = 601;

/** Segments a beam of `lenPx` breaks into — target length, breathing with the
 *  seed so the subdivision itself re-rolls, not just the offsets. */
export function segmentCount(
  lenPx: number,
  seed: number,
  lineId: number,
  cfg: { seg_len_px: number; seg_var: number } = TOKENS.arc,
): number {
  const base = Math.max(1, Math.round(lenPx / cfg.seg_len_px));
  const varied = Math.round(hash01(seed, lineId + COUNT_STREAM, 0) * cfg.seg_var * base);
  return Math.max(1, base + varied);
}

/** The n+1 perpendicular offsets along a beam, in the units of `amp`. Endpoints
 *  are pinned at 0: vertices stay sharp and the flares on them stay anchored. */
export function arcOffsets(n: number, seed: number, lineId: number, amp: number): number[] {
  const offsets = new Array<number>(n + 1).fill(0);
  for (let i = 1; i < n; i++) offsets[i] = amp * (hash01(seed, lineId, i) * 2 - 1);
  return offsets;
}

/** A stretch of consecutive segments sharing a tint. `to` is exclusive. */
export interface ArcRun {
  from: number;
  to: number;
  streak: boolean;
}

/** Roll each segment white or streak, then merge neighbours that agree: colour
 *  washes along the beam in runs rather than flickering as per-segment confetti. */
export function arcRuns(
  n: number,
  seed: number,
  lineId: number,
  tintChance = TOKENS.arc.tint_chance,
): ArcRun[] {
  const runs: ArcRun[] = [];
  for (let s = 0; s < n; s++) {
    const streak = hash01(seed, lineId + TINT_STREAM, s) < tintChance;
    const open = runs.at(-1);
    if (open && open.streak === streak) open.to = s + 1;
    else runs.push({ from: s, to: s + 1, streak });
  }
  return runs;
}
