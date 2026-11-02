// Orbital 3/4 camera: tilted overhead, following the hero, with drag to rotate,
// wheel to zoom, and two fingers to pinch the same zoom. Pointer events are
// bound to the canvas only — the keyboard belongs to the game.
import { PerspectiveCamera, Vector3 } from "three/webgpu";
import type { DungeonCamera } from "./DungeonCamera";

const MIN_ELEVATION = 0.25, MAX_ELEVATION = 1.45;
const MIN_RADIUS = 6, MAX_RADIUS = 60;
const FOLLOW_TAU = 0.18;      // seconds to close ~63% of the gap to the hero
const YAW_PER_PIXEL = 0.006;  // radians of bearing per pixel dragged
const PITCH_PER_PIXEL = 0.005;
const ZOOM_PER_WHEEL = 0.0012; // exponential, so zoom feels even at any radius
const TURN_TAU = 0.1;         // seconds for a facing-reset swing; matches FirstPersonCam
const FULL_TURN = 2 * Math.PI;

const FOV_DEGREES = 50;
const NEAR = 0.1, FAR = 400;
/** Where the camera sits before the first map draw: middle of an 80x21 grid. */
const HOME = { x: 40, y: 0, z: 10 } as const;

/**
 * The orbit distance a wide viewport opens on — the framing this camera has
 * always had, and the one every desktop screenshot was tuned against.
 */
const RESTING_RADIUS = 14;
/**
 * The viewport shape RESTING_RADIUS was chosen for, as canvas width / height.
 * A desktop stage is around 1.9:1 (a 1280x800 window leaves ~1280x670 of
 * canvas), so anything a desktop is likely to produce sits comfortably past
 * this and opens exactly where it used to.
 */
const REFERENCE_ASPECT = 1.6;

/**
 * How far out the camera opens for a viewport of this shape (vect-hack-lxd).
 *
 * The opening framing is a width of MAP, not a distance. A phone in portrait
 * gives the stage an aspect around 0.55, and at a fixed radius that is
 * 2 * r * tan(FOV/2) * aspect ≈ 7 map columns across the middle of the view —
 * a hero you can drive and a level you cannot see. Holding the width instead
 * means pulling back until the same ~21 columns REFERENCE_ASPECT shows still
 * fit, which is what "enough of the map to play" costs on a narrow screen.
 *
 * Only narrower-than-reference viewports move: past REFERENCE_ASPECT the
 * min() pins the radius at RESTING_RADIUS, so a desktop opens on the framing
 * it always had rather than on a wider one derived from the same rule. The
 * grid is deliberately not consulted — see resize(), which applies this.
 */
export function framedRadius(aspect: number): number {
  const shape = Math.min(aspect, REFERENCE_ASPECT);
  return clamp(RESTING_RADIUS * (REFERENCE_ASPECT / shape), MIN_RADIUS, MAX_RADIUS);
}

/** The orbital framing a camera swap carries across (DungeonRenderer). */
export interface OrbitFraming {
  elevation: number;
  radius: number;
  /** True once a zoom was the player's own; see OrbitCam.radius. */
  chosen: boolean;
}

export class OrbitCam implements DungeonCamera {
  readonly camera = new PerspectiveCamera(FOV_DEGREES, 1, NEAR, FAR);

  /** Where a facing reset is heading; `az` chases it. Drag writes both. */
  private azTarget = 0;
  private az = 0;

  elevation = 0.62;

  private radiusValue = RESTING_RADIUS;
  /** Set once something outside the framing rule has picked a radius — a
   *  wheel, a pinch, or a framing handed over by a mode swap. */
  private radiusChosen = false;

  private readonly target = new Vector3(HOME.x, HOME.y, HOME.z);
  private readonly desired = new Vector3(HOME.x, HOME.y, HOME.z);
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  /**
   * Live pointers on the canvas, in the order they landed. One is a drag; two
   * are a pinch, and the drag stands down for as long as the second is there —
   * without that the orbit would keep swinging on whichever finger moved.
   * A mouse only ever produces one, so nothing here can reach a desktop.
   */
  private readonly points = new Map<number, { x: number; y: number }>();
  /** Finger separation when the pinch was last sampled, in pixels; 0 = none. */
  private pinchSpan = 0;

  constructor(private readonly dom: HTMLElement) {
    dom.addEventListener("pointerdown", this.onDown);
    dom.addEventListener("pointermove", this.onMove);
    dom.addEventListener("pointerup", this.onUp);
    dom.addEventListener("pointercancel", this.onUp);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", preventDefault);
  }

  /** Orbit distance. Assigning it is a player's zoom by definition — it stops
   *  the viewport reframing the shot underneath them on the next resize. */
  get radius(): number {
    return this.radiusValue;
  }
  set radius(v: number) {
    this.radiusValue = v;
    this.radiusChosen = true;
  }

  /** Bearing in radians; 0 looks from +z toward the top of the map.
   *  Assignment is a cut, not a request: it writes the target too, so a
   *  drag (and setMode's bearing handoff) is 1:1, never chased. */
  get azimuth(): number {
    return this.az;
  }
  set azimuth(v: number) {
    this.az = v;
    this.azTarget = v;
  }

  /** See DungeonCamera.heading: the reset target, which the view is easing
   *  toward — so keys mean north-up the moment Clear is pressed. */
  get heading(): number {
    return this.azTarget;
  }

  /**
   * One bearing serves the whole map from out here: at orbit distance the
   * look-at angle to any cell is within a few degrees of the azimuth, and the
   * cell being followed matches it exactly (see DungeonCamera).
   */
  facingAt(_x: number, _y: number): number {
    return this.az;
  }

  /** Swing the bearing home to north-up, the short way round: the nearest
   *  multiple of a full turn, since drag accumulates the azimuth unbounded
   *  (same trade as FirstPersonCam.turnBy). */
  resetFacing(): void {
    this.azTarget = Math.round(this.az / FULL_TURN) * FULL_TURN;
  }

  /** How far the eased target still is from the cell being followed. */
  get drift(): number {
    return this.target.distanceTo(this.desired);
  }

  /** Aim at a map cell; the camera eases toward it rather than snapping. */
  follow(x: number, y: number): void {
    this.desired.set(x, 0, y);
  }

  /** Jump straight to the current follow target (level change, first draw). */
  snap(): void {
    this.target.copy(this.desired);
  }

  /** What a mode swap carries across, including whose radius it is: a framing
   *  the viewport chose must stay the viewport's to revise on the next resize,
   *  and one the player chose must not. */
  get framing(): OrbitFraming {
    return { elevation: this.elevation, radius: this.radiusValue, chosen: this.radiusChosen };
  }

  restoreFraming(f: OrbitFraming): void {
    this.elevation = f.elevation;
    this.radiusValue = f.radius;
    this.radiusChosen = f.chosen;
  }

  update(dt: number): void {
    this.az += (this.azTarget - this.az) * (1 - Math.exp(-dt / TURN_TAU));
    const a = 1 - Math.exp(-dt / FOLLOW_TAU);
    this.target.lerp(this.desired, a);
    const cosE = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + this.radiusValue * cosE * Math.sin(this.az),
      this.target.y + this.radiusValue * Math.sin(this.elevation),
      this.target.z + this.radiusValue * cosE * Math.cos(this.az),
    );
    this.camera.lookAt(this.target);
  }

  /**
   * The viewport decides the opening framing (framedRadius), and keeps
   * deciding it until the player zooms: a phone rotated to landscape should
   * reframe, and a window dragged narrow should pull back.
   *
   * It reads the viewport and not the CellGrid on purpose. Every Module's map
   * is wider than the framed width — Larn's 67 is the narrowest — so a
   * grid-derived clamp would be code that cannot fire, and framing a FRACTION
   * of the map is the wrong target anyway: Moria's 198 columns across a 390px
   * phone is two pixels a cell. What a player needs is a fixed number of cells
   * of context, which is what this gives every Module alike.
   */
  resize(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (!this.radiusChosen) this.radiusValue = framedRadius(aspect);
  }

  dispose(): void {
    this.dom.removeEventListener("pointerdown", this.onDown);
    this.dom.removeEventListener("pointermove", this.onMove);
    this.dom.removeEventListener("pointerup", this.onUp);
    this.dom.removeEventListener("pointercancel", this.onUp);
    this.dom.removeEventListener("wheel", this.onWheel);
    this.dom.removeEventListener("contextmenu", preventDefault);
  }

  private onDown = (e: PointerEvent) => {
    this.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dom.setPointerCapture?.(e.pointerId);
    if (this.points.size === 1) {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    // A second finger turns the drag into a pinch. `dragging` is deliberately
    // left alone: the standdown is onMove's `size >= 2` branch, which shadows
    // it for as long as two fingers are down, and onUp is what decides whose
    // drag it is afterwards. Clearing it here as well would be a second answer
    // to the same question that no test could tell from the first.
    this.pinchSpan = this.span();
  };

  private onMove = (e: PointerEvent) => {
    const p = this.points.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    // Two fingers are a pinch, and the orbit stands down for the whole of it:
    // without this the view would keep swinging on whichever finger moved,
    // and a pinch that started as a drag would leave the bearing mid-swing.
    if (this.points.size >= 2) {
      const span = this.span();
      // Ratio per move, not against where the pinch started: the same feel at
      // any radius, and the same arithmetic as the wheel's exponential step.
      if (this.pinchSpan > 0 && span > 0) this.zoom(this.pinchSpan / span);
      this.pinchSpan = span;
      return;
    }
    if (!this.dragging) return;
    this.azimuth -= (e.clientX - this.lastX) * YAW_PER_PIXEL;
    this.elevation = clamp(
      this.elevation + (e.clientY - this.lastY) * PITCH_PER_PIXEL, MIN_ELEVATION, MAX_ELEVATION);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  /** Up and cancel alike: a cancelled finger is a finger that is gone. */
  private onUp = (e: PointerEvent) => {
    if (!this.points.delete(e.pointerId)) return;
    this.dom.releasePointerCapture?.(e.pointerId);
    if (this.points.size >= 2) {
      this.pinchSpan = this.span(); // still a pinch, one finger different
      return;
    }
    this.pinchSpan = 0;
    const [rest] = this.points.values();
    // One finger of a pinch lifted: the survivor takes the drag over from
    // where it IS, so the view carries on instead of jumping by the distance
    // between the two.
    this.dragging = !!rest;
    if (rest) {
      this.lastX = rest.x;
      this.lastY = rest.y;
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * ZOOM_PER_WHEEL));
  };

  /** Multiply the orbit distance: >1 pulls back, <1 moves in. */
  private zoom(factor: number): void {
    this.radius = clamp(this.radiusValue * factor, MIN_RADIUS, MAX_RADIUS);
  }

  /** Pixels between the first two live pointers — the pinch, whichever other
   *  fingers are also down. */
  private span(): number {
    const [a, b] = this.points.values();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function preventDefault(e: Event): void {
  e.preventDefault();
}
