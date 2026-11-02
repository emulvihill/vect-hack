// The camera seam the renderer draws through. Orbital and first person are two
// implementations of it rather than two branches inside DungeonRenderer.
//
// The split that matters is `azimuth` versus `facingAt()`. Both answer "which
// way is the camera", but for different consumers: the radar wants one heading
// for the whole frame, while every letterform wants to turn toward the camera
// individually. Orbiting from far away those are the same number — at 14 cells
// out the parallax across the map is small and the target cell's look-at *is*
// the azimuth — but standing inside the room they are not, and a glyph one cell
// to the left has to turn nearly ninety degrees further than one straight ahead.
import type { PerspectiveCamera } from "three/webgpu";

export type CameraMode = "orbital" | "first";

/**
 * One eighth-turn: the lattice NetHack's eight directions sit on, and the step
 * a keyboard turn takes. It lives here rather than with the key mapper that
 * also needs it because the dependency runs ui -> render, and one constant is
 * not a reason to add the edge back the other way.
 */
export const TURN_STEP = Math.PI / 4;

export interface DungeonCamera {
  readonly camera: PerspectiveCamera;
  /** Heading in radians; 0 looks from +z toward the top of the map. */
  readonly azimuth: number;
  /**
   * The bearing movement resolves against. Identical to `azimuth` at rest, but
   * while a keyboard turn is easing it leads — so a key pressed mid-swing means
   * the direction the player asked for rather than one the view is passing
   * through.
   */
  readonly heading: number;
  /** Swing the view by `delta` radians, snapping onto the TURN_STEP lattice
   *  first. Absent on cameras that do not turn from the keyboard. */
  turnBy?(delta: number): void;
  /** Swing the view back to north-up (heading 0 mod 2π), the short way
   *  round. Movement resolves against `heading`, which commits immediately;
   *  the view eases after it. Absent on a camera with no facing to reset. */
  resetFacing?(): void;
  /** Yaw that turns a glyph at map cell (x, y) to face the camera. */
  facingAt(x: number, y: number): number;
  /** How far the eased view still is from the cell being followed, in cells. */
  readonly drift: number;
  update(dt: number): void;
  /** Aim at a map cell; the camera eases toward it rather than snapping. */
  follow(x: number, y: number): void;
  /** Jump straight to the current follow target (level change, first draw). */
  snap(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
