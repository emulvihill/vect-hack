// The signal envelope every atmosphere effect reads (vector-CRT model §2):
// one energy per trigger id, instant attack on an event and exponential release
// after it. Seconds, never frames — the physics look identical at any refresh
// rate, so a slow frame decays exactly as far as the fast frames it replaced.
import { TOKENS } from "../palette";

/** Below this an envelope contributes nothing visible; retire it so a long
 *  session's dead ids never accumulate in the per-frame walk. */
const DEAD_ENERGY = 1e-3;

export class EnergyField {
  private readonly energy = new Map<number, number>();

  /** An event on `id`: its envelope jumps straight to the amplitude. */
  fire(id: number, amplitude = 1): void {
    this.energy.set(id, clamp01(amplitude));
  }

  /** Release every envelope by `dtSeconds`, dropping the ones that ran out. */
  step(dtSeconds: number, releaseSeconds = TOKENS.glow.energy_release_s): void {
    const decay = Math.exp(-dtSeconds / releaseSeconds);
    for (const [id, energy] of this.energy) {
      const next = energy * decay;
      if (next < DEAD_ENERGY) this.energy.delete(id);
      else this.energy.set(id, next);
    }
  }

  /** Current energy of `id`; 0 for anything that never fired or has faded. */
  at(id: number): number {
    return this.energy.get(id) ?? 0;
  }

  /** Live [id, energy] pairs only. */
  entries(): IterableIterator<[number, number]> {
    return this.energy.entries();
  }

  clear(): void {
    this.energy.clear();
  }
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}
