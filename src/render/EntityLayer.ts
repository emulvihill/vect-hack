// Everything that isn't level geometry: monsters, objects and effects drawn as
// stroked 3D ASCII letterforms. Rebuilt every frame — the transforms are
// per-entity, so batching beats giving each glyph its own object.
//
// Letters sway around the camera's bearing rather than spinning freely: a free
// spin puts every glyph edge-on half the time, and the map has to stay legible.
// They also float clear of the floor and bob on a slow sine, as if riding a
// gentle swell; the ring under the hero and pets marks the true cell.
import { Color, Matrix4, Vector3 } from "three/webgpu";
import { INK, TOKENS, clr } from "./palette";
import { emitLetter } from "./letterform";
import type { LineBatch } from "./LineBatch";
import { TERRAIN_CATEGORIES, type Cell, type CellGrid } from "../backplane/cell";
import { arcOffsets, arcRuns, segmentCount } from "./effects/arc";
import { heat } from "./effects/dwell";
import { RAY_START_FRAC, flareRadius, sparkRays, type FlareCandidate } from "./effects/flare";
import { HIT_POP, flashRed } from "./effects/hitFx";
import type { EntityFx } from "./effects/mapFx";

/** How one class of entity is drawn. The single source for these numbers. */
interface Style {
  /** Cap height of the letter, in cells. */
  height: number;
  /** Half-thickness of the extrusion, in glyph units. */
  depth: number;
  /** Brightness multiplier on the entity's colour. */
  gain: number;
  /** Yaw wander either side of the camera bearing, in radians. */
  sway: number;
  /** Rate through the sway cycle, in rad/s. */
  swayRate: number;
  /** Half-travel of the vertical bob, in cells. */
  bob: number;
}

const HERO: Style = { height: 0.88, depth: 0.10, gain: 1.00, sway: 0.45, swayRate: 0.9, bob: 0.07 };
const MONSTER: Style = { height: 0.82, depth: 0.09, gain: 1.00, sway: 0.45, swayRate: 0.9, bob: 0.07 };
const OBJECT: Style = { height: 0.60, depth: 0.06, gain: 0.85, sway: 0.60, swayRate: 0.5, bob: 0.04 };
const EFFECT: Style = { height: 0.92, depth: 0.07, gain: 1.15, sway: 0.00, swayRate: 0.0, bob: 0.00 };

/** Clearance between the floor and the base of a hovering glyph, in cells. */
const HOVER = 0.22;
/** Bob rate, rad/s — slow enough to read as a swell, not a jitter. */
const BOB_RATE = 1.15;

/** Floor rings marking the hero and pets; spin is in rad/s, sign sets direction. */
const HERO_RING = { radius: 0.42, color: INK.heroRing, gain: 0.9, spin: 0.6 } as const;
const PET_RING = { radius: 0.36, color: INK.pet, gain: 0.7, spin: -0.4 } as const;
/** The look ring (spec 2026-08-18): the cell the pointer is naming. Wider than
 *  the hero and pet rings and turning the other way, so it reads as a mark on
 *  the cell rather than on whatever is standing in it. INK.cursor is the one
 *  track colour nothing else uses (see src/skins/index.ts) — the same ink the
 *  getpos reticle takes, because both mean "this is what is being pointed at". */
const LOOK_RING = { radius: 0.48, color: INK.cursor, gain: 1.0, spin: 0.25 } as const;
const RING_SIDES = 12;
const RING_HEIGHT = 0.03;

/** The getpos() reticle: corner brackets with short uprights, breathing slowly. */
const RETICLE = {
  radius: 0.46, arm: 0.18, post: 0.12, height: 0.04,
  gain: 1.2, pulse: 0.25, pulseRate: 3.2,
} as const;

/** Phase spread so neighbouring glyphs never bob in lockstep. */
const PHASE_BUCKETS = 32;

/** Height of a beam and its sparks above the floor, in cells: chest height on
 *  the letterforms they fly past. */
export const ZAP_HEIGHT = 0.55;
/**
 * One cell in CRT pixels. The arc and flare tokens are px-based because they
 * describe a 2D tube; this is the single place the two spaces meet, so the
 * token values themselves are never restated in cell units.
 */
export const CELL_PX = 128;
/** The beam characters NetHack's zap glyphs use, as [dx, dz] across the cell.
 *  NetHack's y runs down the screen and maps to world z, so '\' descends. */
const BEAM_DIRS: Readonly<Record<string, readonly [number, number]>> = {
  "-": [1, 0], "|": [0, 1], "\\": [1, 1], "/": [1, -1],
};
/** The arc's white carrier (vector-CRT model §3.5); streaks keep the zap's own hue. */
const WHITE = new Color(TOKENS.semantic.white);
const CARRIER_GAIN = 0.85, STREAK_GAIN = 1;
/** Beam brightness breathes with energy rather than dwell-heating: the carrier
 *  is already white and the streaks have to stay coloured at peak (§3.5). */
const GLOW_BASE = 0.55, GLOW_ENERGY = 0.45;
/** Flare radius at full energy, in cells — a spark burst inside its own cell. */
const FLARE_BASE_RADIUS = 0.45;

/** The busiest glyph ('$', '8') is well under this once extruded and strutted. */
const MAX_SEGMENTS_PER_GLYPH = 48;
/** Monsters plus remembered objects on one level; far above any real count. */
const MAX_VISIBLE_ENTITIES = 256;
/** flare.sparkRays never throws more than eleven rays, one segment each. */
const MAX_RAYS_PER_FLARE = 11;
export const ENTITY_CAPACITY =
  MAX_VISIBLE_ENTITIES * MAX_SEGMENTS_PER_GLYPH
  + TOKENS.glow.flare_budget * MAX_RAYS_PER_FLARE;

const m = new Matrix4();
const scale = new Vector3();

/**
 * How the frame's glyphs are turned: one bearing for all of them, or a bearing
 * per cell. The orbital camera has no use for the second form and the
 * first-person camera cannot work without it (see DungeonCamera).
 */
export type Facing = number | ((x: number, y: number) => number);

export interface EntityOptions {
  /** Skip the hero's letterform and ring: in first person the camera is
   *  standing inside them, and a glyph at the eye is garbage. */
  hideHero?: boolean;
  /** The cell the Look HUD is naming, ringed. Absent, nothing is drawn. */
  highlight?: { x: number; y: number };
}

/**
 * @param facing camera bearing in radians, or one per cell; glyphs turn to face it.
 * @param fx the atmosphere pass; omitted, the frame is drawn unlit and inert.
 * @returns effect glyphs drawn this frame — the grid's own effect Cells plus
 *   the residue of the ones the engine has already erased. DungeonRenderer
 *   publishes it as `drawnEffects`, which is the only honest way to ask
 *   whether a blast reached the screen: an effect that never survives to a
 *   drawn frame is invisible however briefly it existed in the model.
 */
export function buildEntities(
  map: CellGrid, batch: LineBatch, time: number, facing: Facing, fx?: EntityFx,
  opts: EntityOptions = {},
): number {
  const bearing = typeof facing === "function" ? facing : () => facing;
  let effectsDrawn = 0;
  batch.begin();
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      let cell = map.at(x, y);
      if (cell.category === "unseen" || TERRAIN_CATEGORIES.has(cell.category)) {
        // Nothing of the engine's stands here. If an effect fired on this cell
        // recently enough, draw that instead: the engine's own repaint can
        // erase a blast in the same batch that set it (Angband at
        // delay_factor 0), and a Cell no frame ever sampled was never on
        // screen. The residue fills the hole the erase left and nothing more —
        // where the engine is showing a being or an item, that stays the truth
        // and the blast's own target is never hidden by it.
        const residue = fx?.residueAt(x, y) ?? null;
        if (!residue) continue;
        cell = residue;
      }

      if (fx && cell.beam && BEAM_DIRS[cell.ch]) {
        beam(batch, map.cols, x, y, cell, fx.seed, fx.energyAt(x, y));
        effectsDrawn++;
        continue;
      }

      const hero = cell.hero === true;
      if (hero && opts.hideHero) continue;
      const effect = cell.category === "effect";
      const style = hero ? HERO : styleFor(cell);
      const phase = (((x * 7 + y * 13) % PHASE_BUCKETS) / PHASE_BUCKETS) * Math.PI * 2;

      const yaw = bearing(x, y) + style.sway * Math.sin(time * style.swayRate + phase);
      // Bob is measured from the base, so tall and short glyphs keep the same
      // floor clearance at the bottom of the cycle.
      const centreY = HOVER + style.height / 2 + style.bob * Math.sin(time * BOB_RATE + phase);

      // The hero carries the light and effects are self-luminous; everything
      // else is only as bright as the hero's lamp reaches.
      const light = fx && !hero && !effect ? fx.lightAt(x, y) : 1;
      // Hit flash (spec 2026-08-06): a just-hit victim lerps toward the
      // skin's red and pops brighter, on hitFx's decaying envelope.
      const hitE = fx && !effect ? fx.hitAt(x, y) : 0;
      let color = hero ? INK.hero
        : fx && effect ? heat(clr(cell.color), fx.energyAt(x, y))
        : clr(cell.color);
      if (hitE > 0) color = flashRed(color, hitE);

      place(m, x, y, centreY, style.height, yaw);
      emitLetter(batch, cell.ch, color, style.gain * light * (1 + HIT_POP * hitE), m, style.depth);
      if (effect) effectsDrawn++;

      if (hero) ring(batch, x, y, HERO_RING, time);
      else if (cell.pet) ring(batch, x, y, PET_RING, time, light);
    }
  }

  if (fx) for (const f of fx.flares()) sparks(batch, f, fx.seed);

  // The engine parks the cursor on the hero between commands, where the hero
  // ring already marks the cell; drawing it there would be permanent clutter.
  // It earns its keep only once getpos() walks it somewhere else.
  const c = map.cursor;
  if (c && !(map.hero && map.hero.x === c.x && map.hero.y === c.y))
    reticle(batch, c.x, c.y, time);

  if (opts.highlight) ring(batch, opts.highlight.x, opts.highlight.y, LOOK_RING, time);

  batch.commit();
  return effectsDrawn;
}

/**
 * A zap crossing its cell as a live wire (vector-CRT model §3.5): subdivided, displaced
 * perpendicular to itself, and washed in runs of white carrier and coloured
 * streak. Endpoints sit on the cell borders, so consecutive zap cells join.
 */
function beam(
  batch: LineBatch, cols: number, x: number, y: number, cell: Cell, seed: number, energy: number,
): void {
  const [dx, dz] = BEAM_DIRS[cell.ch]!;
  const span = Math.hypot(dx, dz);           // 1 across, sqrt(2) diagonally
  const id = y * cols + x;
  const n = segmentCount(span * CELL_PX, seed, id);
  // amp is a length like the offsets it scales, so the px -> cell conversion
  // rides the amplitude rather than every offset.
  const amp = (TOKENS.arc.base_amp_px + TOKENS.arc.energy_amp_px * clamp01(energy)) / CELL_PX;
  const offsets = arcOffsets(n, seed, id, amp);
  // Unit perpendicular in the horizontal plane; the beam never leaves it.
  const px = -dz / span, pz = dx / span;
  const ax = x - dx / 2, az = y - dz / 2;

  const glow = GLOW_BASE + GLOW_ENERGY * clamp01(energy);
  const at = (i: number): [number, number] => {
    const t = i / n, o = offsets[i]!;
    return [ax + dx * t + px * o, az + dz * t + pz * o];
  };
  for (const run of arcRuns(n, seed, id)) {
    const color = run.streak ? clr(cell.color) : WHITE;
    const gain = (run.streak ? STREAK_GAIN : CARRIER_GAIN) * glow;
    for (let s = run.from; s < run.to; s++) {
      const [sx, sz] = at(s);
      const [ex, ez] = at(s + 1);
      batch.add(sx, ZAP_HEIGHT, sz, ex, ZAP_HEIGHT, ez, color, gain);
    }
  }
}

/**
 * The hashed spark burst a lit vertex throws (vector-CRT model §3.3), laid flat in the
 * horizontal plane. A ray's stroke width has no per-segment analogue in a
 * LineBatch — one width serves the whole stack — so its weight rides its gain.
 */
function sparks(batch: LineBatch, f: FlareCandidate, seed: number): void {
  const r = flareRadius(f.energy, FLARE_BASE_RADIUS);
  for (const ray of sparkRays(seed, f.id, f.energy)) {
    const cos = Math.cos(ray.angle), sin = Math.sin(ray.angle);
    const from = RAY_START_FRAC * r, to = ray.length * r;
    batch.add(
      f.x + cos * from, ZAP_HEIGHT, f.y + sin * from,
      f.x + cos * to, ZAP_HEIGHT, f.y + sin * to,
      WHITE, ray.intensity,
    );
  }
}

/** Corner brackets around a cell, pulsing, marking the position being picked. */
function reticle(batch: LineBatch, x: number, y: number, time: number): void {
  const gain = RETICLE.gain * (1 + RETICLE.pulse * Math.sin(time * RETICLE.pulseRate));
  const o = RETICLE.radius;
  const a = RETICLE.arm;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = x + o * sx;
      const cz = y + o * sy;
      batch.add(cx, RETICLE.height, cz, cx - a * sx, RETICLE.height, cz, INK.cursor, gain);
      batch.add(cx, RETICLE.height, cz, cx, RETICLE.height, cz - a * sy, INK.cursor, gain);
      batch.add(cx, RETICLE.height, cz, cx, RETICLE.height + RETICLE.post, cz, INK.cursor, gain);
    }
  }
}

function styleFor(cell: Cell): Style {
  if (cell.category === "item") return OBJECT;
  if (cell.category === "effect") return EFFECT;
  return MONSTER;
}

/** Top of a glyph's vertical extent — base clearance plus cap height plus the
 *  bob's half-travel, the letter's highest point in its cycle. The single
 *  source pick volumes (src/render/pick.ts) size themselves from, so the
 *  clickable box and the drawn letter cannot drift apart. */
export function glyphTop(cell: Cell): number {
  const style = cell.hero ? HERO : styleFor(cell);
  return HOVER + style.height + style.bob;
}

/** Upright letter of `height`, centred `centreY` above the floor, yawed. */
function place(
  out: Matrix4, x: number, y: number,
  centreY: number, height: number, yaw: number,
): void {
  out.makeRotationY(yaw);
  out.scale(scale.set(height, height, height));
  out.setPosition(x, centreY, y);
}

interface Ring { radius: number; color: Color; gain: number; spin: number }

/** @param light hero-light multiplier; the hero's own ring never dims. */
function ring(
  batch: LineBatch, x: number, y: number, spec: Ring, time: number, light = 1,
): void {
  const angle = time * spec.spin;
  for (let i = 0; i < RING_SIDES; i++) {
    const a = angle + (i / RING_SIDES) * Math.PI * 2;
    const b = angle + ((i + 1) / RING_SIDES) * Math.PI * 2;
    batch.add(
      x + Math.cos(a) * spec.radius, RING_HEIGHT, y + Math.sin(a) * spec.radius,
      x + Math.cos(b) * spec.radius, RING_HEIGHT, y + Math.sin(b) * spec.radius,
      spec.color, spec.gain * light,
    );
  }
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}
