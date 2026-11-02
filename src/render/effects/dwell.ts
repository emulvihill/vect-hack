// Dwell heat (vector-CRT model §3.1): a stroke rides its energy from its
// own hue up to white, the way a vector tube's beam whitens where it lingers.
import { Color } from "three/webgpu";

/** Per-channel lerp of `base` toward white by energy. Returns a new Color —
 *  the palette hands out shared instances and this runs per frame. */
export function heat(base: Color, energy: number): Color {
  const t = Math.min(Math.max(energy, 0), 1);
  return new Color(
    base.r + (1 - base.r) * t,
    base.g + (1 - base.g) * t,
    base.b + (1 - base.b) * t,
  );
}
