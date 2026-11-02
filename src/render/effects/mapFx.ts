// The host adapter for the atmosphere pass (vector-CRT model §2: ports
// write adapters, not new physics). NetHack hands the renderer a grid, not an
// event stream, so this watches the grid for effect glyphs appearing or
// changing and turns each one into a `fire` on the shared energy field. It also
// carries the hero light field, so everything downstream reads world space —
// never the camera.
//
// A Module that HAS an effect event may also say so directly (`effect()`), and
// must where its engine can set and erase a blast between two frames: the grid
// walk cannot see a Cell that never survived one. See EFFECT_LIFETIME_S.
import type { Cell, CellGrid } from "../../backplane/cell";
import { arcSeed } from "./arc";
import { selectFlares, type FlareCandidate } from "./flare";
import { HIT_RELEASE_S } from "./hitFx";
import { heroLightGain } from "./lighting";
import { EnergyField } from "./signal";

/** What the entity layer needs from the pass. EntityLayer depends on this, not
 *  on MapFx, so a test can hand it any of the six effects in isolation. */
export interface EntityFx {
  /** Arc shift quantum; every hashed figure is re-rolled on it. */
  seed: number;
  lightAt(x: number, y: number): number;
  energyAt(x: number, y: number): number;
  /** Hit-flash energy at a cell; 0 unless something there was just hit. */
  hitAt(x: number, y: number): number;
  /** An effect the grid no longer holds but that is still owed screen time;
   *  null for every other cell. See MapFx.effect(). */
  residueAt(x: number, y: number): Cell | null;
  flares(): FlareCandidate[];
}

/** Marks a cell that held no effect last frame; any real ch differs from it. */
const UNLIT = "";

/**
 * Minimum on-screen lifetime of a fired effect, seconds (vect-hack-auo).
 *
 * `observe()` samples the grid once per frame, so it cannot see a Cell that
 * never survived a frame — and an engine is free to set and erase one between
 * two frames. Angband does exactly that at `delay_factor` 0, an option the
 * player sets from the options menu: its own animation pacing
 * (`Term_xtra(TERM_XTRA_DELAY, delay_factor)`, 40ms per radius by default) is
 * the only thing keeping a blast on the grid across a frame boundary today.
 * So the lifetime is driven by the effect EVENT instead, and is the same
 * whatever the engine's own pacing says.
 *
 * Long enough to read at 60Hz (fifteen frames), short enough that the blast is
 * still a flash rather than a decal — and well inside the glow envelope
 * (`TOKENS.glow.energy_release_s`), so the glyph is drawn hot for all of it.
 */
export const EFFECT_LIFETIME_S = 0.25;

export class MapFx implements EntityFx {
  seed = 0;

  private readonly field = new EnergyField();
  private readonly hits = new EnergyField();
  /** The effect character each cell showed last frame, UNLIT for the rest.
   *  Category rides in it: a non-effect cell is always UNLIT. */
  private readonly seen: string[];
  /** Fired effects still inside EFFECT_LIFETIME_S, by cell id: the Cell to
   *  draw and the seconds it has left. Keyed the same way the fields are. */
  private readonly residue = new Map<number, { cell: Cell; left: number }>();
  private hero: { x: number; y: number } | null = null;

  constructor(private readonly cols: number, private readonly rows: number) {
    this.seen = new Array<string>(cols * rows).fill(UNLIT);
  }

  /** Fire every cell that just became an effect, or whose effect changed. A
   *  full grid walk per frame is cheaper than tracking dirty cells. */
  observe(map: CellGrid): void {
    this.hero = map.hero;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const cell = map.at(x, y);
        const ch = cell.category === "effect" ? cell.ch : UNLIT;
        const i = y * this.cols + x;
        if (ch !== UNLIT && ch !== this.seen[i]) this.field.fire(i, 1);
        this.seen[i] = ch;
      }
    }
  }

  /**
   * A Module's engine fired an effect at a cell (vect-hack-auo). The grid stays
   * engine truth — this does not write to it — but the Cell stays drawable for
   * EFFECT_LIFETIME_S whatever the grid does in the meantime, which is what
   * gives the blast a lifetime the engine's own animation pacing cannot take
   * away. The glow envelope is fired here too, so a residue drawn after the
   * engine's repaint is drawn as hot as one the grid still held.
   */
  effect(x: number, y: number, cell: Cell): void {
    const i = y * this.cols + x;
    this.field.fire(i, 1);
    // The grid walk fires on a change against `seen`; recording it here means
    // one event fires one envelope, whether or not the Cell also reaches the
    // grid in time for a frame to sample it.
    this.seen[i] = cell.ch;
    this.residue.set(i, { cell, left: EFFECT_LIFETIME_S });
  }

  /** Release every envelope by one frame, and age the effect residue with it. */
  step(dtSeconds: number): void {
    this.field.step(dtSeconds);
    this.hits.step(dtSeconds, HIT_RELEASE_S);
    for (const [id, r] of this.residue) {
      r.left -= dtSeconds;
      if (r.left <= 0) this.residue.delete(id);
    }
  }

  /** Re-roll the hashed figures if the shift clock has ticked over. */
  reseed(elapsedSeconds: number): void {
    this.seed = arcSeed(elapsedSeconds);
  }

  /** Hero light at a cell; everything is lit until there is a hero to light it. */
  lightAt(x: number, y: number): number {
    const h = this.hero;
    return h ? heroLightGain(h.x, h.y, x, y) : 1;
  }

  energyAt(x: number, y: number): number {
    return this.field.at(y * this.cols + x);
  }

  /** A hit landed at a cell: fire its red-pulse envelope. */
  hit(x: number, y: number): void {
    this.hits.fire(y * this.cols + x, 1);
  }

  hitAt(x: number, y: number): number {
    return this.hits.at(y * this.cols + x);
  }

  /** The effect Cell a cell is still owed, or null. `observe()` never retracts
   *  one: the grid is what the engine has repainted since, and this is what the
   *  event said. */
  residueAt(x: number, y: number): Cell | null {
    return this.residue.get(y * this.cols + x)?.cell ?? null;
  }

  /** The lit cells worth a spark burst, brightest first, capped to the budget. */
  flares(): FlareCandidate[] {
    const cands: FlareCandidate[] = [];
    for (const [id, energy] of this.field.entries())
      cands.push({ x: id % this.cols, y: Math.floor(id / this.cols), energy, id });
    return selectFlares(cands);
  }

  /** New level: the old level's beams and blasts are not this level's. */
  clear(): void {
    this.field.clear();
    this.hits.clear();
    this.residue.clear();
    this.seen.fill(UNLIT);
    this.hero = null;
  }
}
