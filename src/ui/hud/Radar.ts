// Monster radar: a circular overlay in the corner of the stage that gives back
// the positional awareness a 3/4 orbital camera takes away. The hero at the
// centre, the rim at RADAR_RANGE, and every monster the map knows about as one
// stroked blip pointing the way it lies.
//
// Two distances, deliberately: the ring is Manhattan, because that is how far
// the monster has to walk, while the bearing is euclidean, because that is the
// direction you would look. Inside the rim, position IS the reading — a numeral
// there would only restate it — so only blips pinned to the rim, whose position
// has stopped meaning anything, carry their distance. And when a non-pet closes
// inside ALERT_RANGE the rim itself pulses to the alert colour: the approach
// warning does not depend on reading any one blip.
//
// It is 2D chrome over the scene rather than scene geometry — it must not move
// with the world, and it has to read the same under whichever camera is
// running. Only the beam stack is borrowed from the 3D side, so the two halves
// of the display still look like one machine.
import { Color } from "three/webgpu";
import { CLR, CLR_MAX } from "../../backplane/colors";
import { beamLayers } from "../../render/LineBatch";
import type { CellGrid } from "../../backplane/cell";
import { TOKENS, clr } from "../../render/palette";
import { glyphStrokes } from "../../render/vectorFont";
import { activeSkin } from "../../skins";

/** The rim, in Manhattan map squares. Inside it, a monster is a live threat. */
export const RADAR_RANGE = 6;
/** A non-pet closer than this pulses the rim: it is about to be adjacent. */
export const ALERT_RANGE = 3;

// Layout, as fractions of the widget's half-width. RIM is where a contact at
// RADAR_RANGE plots, and everything outside it — arrowheads, numerals — is the
// margin that keeps those marks inside the box.
const RIM = 0.66;
const BACKDROP_RADIUS = 0.97;
const TICK = 0.07;
const FORWARD_TICK = 0.13;
/** Small: an adjacent monster plots almost on top of it, and must win. */
const HERO_MARK = 0.035;
const GLYPH_CAP = 0.10;
const DIGIT_CAP = 0.06;
/** How far below its letter a blip's distance sits. */
const DIGIT_DROP = 0.10;
/**
 * Arrowhead: clearance from the blip centre, then length and half-width. The
 * gap has to clear the corner of the letter box, not just its side, or a wide
 * glyph like '@' grows a spike.
 */
const ARROW = { gap: 0.09, length: 0.08, half: 0.045 } as const;
/** Core stroke width; the beam layers widen out from it. */
const STROKE = 0.014;

const TAU = Math.PI * 2;
const LAYERS = beamLayers(TOKENS.glow.beam_layers);

const S = TOKENS.semantic;
const T = TOKENS.track_palette;
/** Near-clear: the widget is a lens over the scene, not a plate on top of it. */
const BACKDROP = activeSkin().radar.backdrop;
const RIM_INK = S.accent;
const ALERT_INK = S.alert;
/** The forward tick is the only mark that says which way the camera points. */
const FORWARD_INK = S.pointer;
const HERO_INK = S.white;

const RIM_GAIN = 0.55;
const HERO_GAIN = 0.9;
const ARROW_GAIN = 0.75;
/** Contacts beyond the rim recede; the closest ones lean in this far. */
const FAR_GAIN = 0.7, NEAREST_GAIN = 1.6;

// Numerals belong to rim-pinned blips, so the ramp runs outward: alert red for
// one just past the rim, cooling to token yellow by NUMBER_FAR and beyond.
const NUMBER_FAR = 3 * RADAR_RANGE;
const PROXIMITY = Array.from({ length: NUMBER_FAR + 1 }, (_, d) =>
  new Color(S.alert).lerp(new Color(T[6]!),
    Math.max(d - RADAR_RANGE, 0) / (NUMBER_FAR - RADAR_RANGE)).getStyle());

/** CLR_* index -> the same vector-palette ink the 3D letterforms use. */
const CLR_CSS = Array.from({ length: CLR_MAX }, (_, i) => clr(i).getStyle());

/** Ink for the numeral at `distance`, clamped to the ends of the ramp. */
export function proximityInk(distance: number): string {
  return PROXIMITY[Math.min(Math.max(distance, 0), NUMBER_FAR)]!;
}

export interface Blip {
  /** The monster's map symbol. */
  ch: string;
  /** Its CLR_* index — a blip keeps the colour it has on the map. */
  color: number;
  /** Radar coordinates: +u right, +v forward. Length <= 1, the rim being 1. */
  u: number;
  v: number;
  /** Manhattan distance in map squares. */
  distance: number;
  /** Inside the rim, where its plotted position is the distance reading. */
  near: boolean;
  /** Pets never trip the approach alert. */
  pet: boolean;
}

/** True when something that is not a pet is inside ALERT_RANGE. */
export function underThreat(blips: Blip[]): boolean {
  return blips.some((b) => !b.pet && b.distance < ALERT_RANGE);
}

/**
 * Every monster on the level's known map, placed on the radar.
 *
 * @param facing camera bearing in radians — the same one the letterforms yaw
 *   to, so the radar stays true under any camera that reports its own.
 */
export function radarBlips(map: CellGrid, facing: number): Blip[] {
  const hero = map.hero;
  if (!hero) return [];
  // Forward is away from the camera, (-sin, -cos) across the map, and right is
  // a quarter turn from it.
  const sin = Math.sin(facing), cos = Math.cos(facing);
  const blips: Blip[] = [];
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      const cell = map.at(x, y);
      if (cell.category !== "being" || cell.hero) continue;
      const dx = x - hero.x, dy = y - hero.y;
      if (dx === 0 && dy === 0) continue; // the hero's own cell, unflagged
      const span = Math.hypot(dx, dy);
      const distance = Math.abs(dx) + Math.abs(dy);
      const reach = Math.min(distance / RADAR_RANGE, 1);
      blips.push({
        ch: cell.ch,
        color: cell.color,
        u: ((dx * cos - dy * sin) / span) * reach,
        v: (-(dx * sin + dy * cos) / span) * reach,
        distance,
        near: distance <= RADAR_RANGE,
        pet: cell.pet === true,
      });
    }
  }
  return blips;
}

/**
 * Paint the radar into a `size` x `size` box of CSS pixels. The caller owns the
 * canvas and its device-pixel transform; this draws in CSS units from (0, 0).
 *
 * @param alert 0..1 blend of the rim toward the alert colour — the approach
 *   warning's pulse envelope. 0 is the resting widget.
 */
export function drawRadar(
  ctx: CanvasRenderingContext2D, blips: Blip[], size: number, alert = 0,
): void {
  const half = size / 2;
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.fillStyle = BACKDROP;
  ctx.beginPath();
  ctx.arc(half, half, half * BACKDROP_RADIUS, 0, TAU);
  ctx.fill();

  ctx.globalCompositeOperation = "lighter";
  chrome(ctx, half, alert);
  for (const b of blips) blip(ctx, half, b);
  ctx.restore();
}

/** The rim, the cardinal ticks and the mark standing in for the hero. */
function chrome(ctx: CanvasRenderingContext2D, half: number, alert: number): void {
  const rimInk = alert > 0
    ? new Color(RIM_INK).lerp(new Color(ALERT_INK), alert).getStyle()
    : RIM_INK;
  const rimGain = RIM_GAIN + (1.4 - RIM_GAIN) * alert;

  ctx.beginPath();
  ctx.arc(half, half, half * RIM, 0, TAU);
  beam(ctx, half, rimInk, rimGain);

  // Ticks at the four quarters. The forward one runs longer and brighter: it
  // is what tells a glance which way the camera — and so the radar — is turned.
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const forward = dy === -1;
    const out = RIM + (forward ? FORWARD_TICK : TICK);
    ctx.beginPath();
    ctx.moveTo(half + dx * half * RIM, half + dy * half * RIM);
    ctx.lineTo(half + dx * half * out, half + dy * half * out);
    beam(ctx, half, forward ? FORWARD_INK : rimInk, forward ? 1 : rimGain);
  }

  ctx.beginPath();
  ctx.arc(half, half, half * HERO_MARK, 0, TAU);
  beam(ctx, half, HERO_INK, HERO_GAIN);
}

/** One contact: its letter, an arrowhead, and — pinned to the rim — its distance. */
function blip(ctx: CanvasRenderingContext2D, half: number, b: Blip): void {
  const px = half + b.u * half * RIM;
  const py = half - b.v * half * RIM;
  const ink = CLR_CSS[b.color] ?? CLR_CSS[CLR.GRAY]!;
  const gain = b.near
    ? 1 + (NEAREST_GAIN - 1) * ((RADAR_RANGE - b.distance) / (RADAR_RANGE - 1))
    : FAR_GAIN;

  text(ctx, b.ch, px, py, half * GLYPH_CAP);
  beam(ctx, half, ink, gain);

  arrowhead(ctx, half, b, px, py);
  beam(ctx, half, ink, gain * ARROW_GAIN);

  // Inside the rim the plotted position already reads as distance; a blip
  // pinned to the rim (RADAR_RANGE or past it) has lost that, so only it gets
  // the numeral back.
  if (b.distance >= RADAR_RANGE) {
    text(ctx, String(b.distance), px, py + half * DIGIT_DROP, half * DIGIT_CAP);
    beam(ctx, half, proximityInk(b.distance), 1);
  }
}

/** Advance between characters laid side by side, in caps. */
const KERN = 0.85;

/** Lay a stroke-font string into the current path, centred on (px, py). */
function text(
  ctx: CanvasRenderingContext2D, s: string, px: number, py: number, cap: number,
): void {
  ctx.beginPath();
  let x0 = px - ((s.length - 1) / 2) * cap * KERN;
  for (const ch of s) {
    for (const stroke of glyphStrokes(ch))
      for (let i = 0; i + 1 < stroke.length; i += 2) {
        // Glyph space is y-up; the canvas is y-down.
        const x = x0 + stroke[i]! * cap, y = py - stroke[i + 1]! * cap;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    x0 += cap * KERN;
  }
}

/** A chevron just outside the blip, pointing the way the monster lies. */
function arrowhead(
  ctx: CanvasRenderingContext2D, half: number, b: Blip, px: number, py: number,
): void {
  const span = Math.hypot(b.u, b.v) || 1;
  const ox = b.u / span, oy = -b.v / span; // outward, in screen coordinates
  const base = half * ARROW.gap, tip = base + half * ARROW.length;
  const wing = half * ARROW.half;
  ctx.beginPath();
  ctx.moveTo(px + ox * base - oy * wing, py + oy * base + ox * wing);
  ctx.lineTo(px + ox * tip, py + oy * tip);
  ctx.lineTo(px + ox * base + oy * wing, py + oy * base - ox * wing);
}

/**
 * Stroke the current path as a beam: the vector-CRT layer stack (model
 * §3.2, via beamLayers()) rendered as repeated strokes, widest and dimmest
 * first. The path survives stroke(), so each layer is one more pass over it.
 */
function beam(
  ctx: CanvasRenderingContext2D, half: number, ink: string, gain: number,
): void {
  ctx.strokeStyle = ink;
  for (const layer of LAYERS) {
    ctx.lineWidth = half * STROKE * layer.widthMul;
    ctx.globalAlpha = Math.min(layer.alpha * gain, 1);
    ctx.stroke();
  }
}

/** Retina is worth it; past 2x the widget costs fill rate for no visible gain. */
const MAX_PIXEL_RATIO = 2;

/**
 * Point a canvas's backing store at a `size`-CSS-pixel square widget, and
 * return the device pixels per CSS pixel the context should be scaled by.
 *
 * Both dimensions are tested, not just width: a canvas starts out 300 x 150,
 * so at ratio 1.25 a 240px widget asks for exactly the 300 it already has and
 * a width-only guard would keep the default 150 height — painting a square
 * radar into a 2:1 store, stretched to twice its height and cropped in half.
 */
export function fitBacking(
  canvas: { width: number; height: number }, size: number, ratio: number,
): number {
  const pixels = Math.round(size * Math.min(ratio, MAX_PIXEL_RATIO));
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  return pixels / size;
}

/** The approach warning: two beats, dying away, then the rim rests again. */
const PULSE_SECONDS = 1.1;
const PULSE_BEATS = 2;

/**
 * Pulse envelope, 0..1 over 0..PULSE_SECONDS: `beats` swells under a linear
 * fade, so the warning arrives loud and leaves quietly. 0 outside the window.
 */
export function pulseEnvelope(t: number): number {
  if (t < 0 || t >= PULSE_SECONDS) return 0;
  const fade = 1 - t / PULSE_SECONDS;
  return Math.abs(Math.sin((t / PULSE_SECONDS) * Math.PI * PULSE_BEATS)) * fade;
}

/** The radar as a DOM overlay: its own canvas, sized by CSS, painted on demand. */
export class Radar {
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private dirty = true;
  private facing = Number.NaN;
  private blips: Blip[] = [];
  private threatened = false;
  /** performance.now() when the current pulse began, or -Infinity at rest. */
  private pulseStart = -Infinity;
  private alert = 0;

  constructor(parent: HTMLElement) {
    this.canvas.id = "radar";
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.observer = new ResizeObserver(() => (this.dirty = true));
    this.observer.observe(this.canvas);
  }

  /** The map moved on; the blips are stale. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Repaint if anything has moved. Safe to call every frame — with the map and
   * the camera both still and no pulse running, it does nothing at all.
   */
  draw(map: CellGrid, facing: number): void {
    const size = this.canvas.clientWidth;
    if (size <= 0) return;

    const stale = this.dirty || facing !== this.facing;
    if (stale) {
      this.dirty = false;
      this.facing = facing;
      this.blips = radarBlips(map, facing);
      // The pulse is a short warning of an approach, not a persistent state:
      // it fires on the edge where a non-pet first closes inside ALERT_RANGE,
      // and again only after everything has backed out of range.
      const threatened = underThreat(this.blips);
      if (threatened && !this.threatened) this.pulseStart = performance.now();
      this.threatened = threatened;
    }

    const alert = pulseEnvelope((performance.now() - this.pulseStart) / 1000);
    if (!stale && alert === this.alert) return;
    this.alert = alert;

    const dpr = fitBacking(this.canvas, size, devicePixelRatio);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRadar(this.ctx, this.blips, size, alert);
  }

  dispose(): void {
    this.observer.disconnect();
    this.canvas.remove();
  }
}
