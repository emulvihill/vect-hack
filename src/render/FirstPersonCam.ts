// First-person camera: the eye stands in the hero's cell and looks around with
// the pointer. Same follow ease and the same drag feel as the orbital camera —
// only the shape of the view changes — so a toggle between the two never feels
// like two different games. Pointer events are bound to the canvas only; the
// keyboard belongs to the game.
import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { TURN_STEP, type DungeonCamera } from "./DungeonCamera";

/**
 * Eye height above the floor, in cells. Under a wall top (1.1) so walls read as
 * walls rather than railings, and over a door sill so a doorway frames the room
 * beyond it. Roughly the letterforms' own eye level, which is the point.
 */
export const EYE_HEIGHT = 0.55;
/** Short of straight up or down: past this the horizon leaves the frame. */
export const MAX_PITCH = 1.2;

const FOLLOW_TAU = 0.18;      // seconds to close ~63% of the gap to the hero
const TURN_TAU = 0.1;         // the same, for a keyboard turn: crisper than the follow
const YAW_PER_PIXEL = 0.006;  // radians of bearing per pixel dragged
const PITCH_PER_PIXEL = 0.005;
const FULL_TURN = 2 * Math.PI;

/** Wider than the orbital 50°: standing inside a room, a narrow cone feels
 *  like a periscope, and the walls either side are what tells you where you
 *  are. */
const FOV_DEGREES = 68;
/** The nearest wall can be half a cell away, so the orbital 0.1 would clip it. */
const NEAR = 0.03, FAR = 400;
/** Where the eye sits before the first map draw: middle of an 80x21 grid. */
const HOME = { x: 40, y: 10 } as const;

export interface FirstPersonCamOptions {
  /** Opening heading, handed over from the camera being replaced. */
  yaw?: number;
  /** Opening pitch; level by default. */
  pitch?: number;
}

export class FirstPersonCam implements DungeonCamera {
  readonly camera = new PerspectiveCamera(FOV_DEGREES, 1, NEAR, FAR);

  /** Bearing in radians; 0 looks from +z toward the top of the map. */
  yaw: number;
  /** Positive looks up. Clamped to +/- MAX_PITCH. */
  pitch: number;
  /** Where a keyboard turn is heading; `yaw` chases it. Drag writes both. */
  private yawTarget: number;

  private readonly eye = new Vector3(HOME.x, EYE_HEIGHT, HOME.y);
  private readonly desired = new Vector3(HOME.x, EYE_HEIGHT, HOME.y);
  /**
   * The pointer the look is following, or null. First person has no orbit
   * radius, so it has no pinch to bind (vect-hack-lxd): the only zoom it could
   * offer is the field of view, and that is a distortion rather than a
   * framing — which is also why it binds no wheel. What a second finger does
   * need is to be ignored, so a pinch begun over this camera cannot feed two
   * fingers' motion into one look.
   */
  private looking: number | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(private readonly dom: HTMLElement, opts: FirstPersonCamOptions = {}) {
    this.yaw = opts.yaw ?? 0;
    this.yawTarget = this.yaw;
    this.pitch = clamp(opts.pitch ?? 0, -MAX_PITCH, MAX_PITCH);
    // YXZ so yaw is applied in world space and pitch in the camera's own: any
    // other order rolls the horizon as soon as both are non-zero.
    this.camera.rotation.order = "YXZ";
    dom.addEventListener("pointerdown", this.onDown);
    dom.addEventListener("pointermove", this.onMove);
    dom.addEventListener("pointerup", this.onUp);
    dom.addEventListener("pointercancel", this.onUp);
    dom.addEventListener("contextmenu", preventDefault);
  }

  /** The radar's heading. Glyphs use facingAt() instead — see DungeonCamera. */
  get azimuth(): number {
    return this.yaw;
  }

  /** See DungeonCamera.heading: the turn target, which `yaw` is easing toward. */
  get heading(): number {
    return this.yawTarget;
  }

  /**
   * Snap onto the eighth-turn lattice, then step. Snapping first is what keeps a
   * turn taken after a free-look drag landing square on a direction rather than
   * a few degrees off one.
   *
   * Neither yaw nor its target is wrapped. Drag has always accumulated it
   * unbounded, and folding it to +/-PI would put a discontinuity inside the ease
   * below — a real seam, traded against a precision loss that needs on the order
   * of 1e10 radians of dragging to show up.
   */
  turnBy(delta: number): void {
    this.yawTarget = Math.round(this.yawTarget / TURN_STEP) * TURN_STEP + delta;
  }

  /** Face north (the map's up), the short way round — the nearest multiple
   *  of a full turn, since drag accumulates yaw unbounded (see turnBy). The
   *  existing ease carries the view there. */
  resetFacing(): void {
    this.yawTarget = Math.round(this.yaw / FULL_TURN) * FULL_TURN;
  }

  facingAt(x: number, y: number): number {
    // The yaw that points the letter's +z face (see place()) at the eye.
    return Math.atan2(this.eye.x - x, this.eye.z - y);
  }

  /** How far the eye still is from the cell being followed. */
  get drift(): number {
    return this.eye.distanceTo(this.desired);
  }

  follow(x: number, y: number): void {
    this.desired.set(x, EYE_HEIGHT, y);
  }

  snap(): void {
    this.eye.copy(this.desired);
  }

  update(dt: number): void {
    this.eye.lerp(this.desired, 1 - Math.exp(-dt / FOLLOW_TAU));
    this.yaw += (this.yawTarget - this.yaw) * (1 - Math.exp(-dt / TURN_TAU));
    this.camera.position.copy(this.eye);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.dom.removeEventListener("pointerdown", this.onDown);
    this.dom.removeEventListener("pointermove", this.onMove);
    this.dom.removeEventListener("pointerup", this.onUp);
    this.dom.removeEventListener("pointercancel", this.onUp);
    this.dom.removeEventListener("contextmenu", preventDefault);
  }

  private onDown = (e: PointerEvent) => {
    if (this.looking !== null) return; // a second finger is not a second look
    this.looking = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.dom.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (this.looking !== e.pointerId) return;
    // Both signs match OrbitCam: drag right and the view turns the same way,
    // drag down and it looks down, whichever camera is running.
    this.yaw -= (e.clientX - this.lastX) * YAW_PER_PIXEL;
    this.yawTarget = this.yaw; // a drag is 1:1, never chased
    this.pitch = clamp(
      this.pitch - (e.clientY - this.lastY) * PITCH_PER_PIXEL, -MAX_PITCH, MAX_PITCH);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  /** Up and cancel alike: a cancelled finger is a finger that is gone. */
  private onUp = (e: PointerEvent) => {
    if (this.looking !== e.pointerId) return;
    this.looking = null;
    this.dom.releasePointerCapture?.(e.pointerId);
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function preventDefault(e: Event): void {
  e.preventDefault();
}
