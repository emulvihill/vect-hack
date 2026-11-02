// Entity hit-testing for the pointer (vect-hack-hqo). The letterforms stand
// up from the floor, so a click aimed at a glyph the player can see would
// otherwise resolve through the floor plane to a cell behind it — the ray
// passes over the letter and lands farther from the camera. Before the plane
// gets its say, the ray is tested against a stand-in volume per occupied
// cell: a box from the floor to the letter's highest point in its bob cycle.
//
// Occupancy comes from the Backplane grid, never from the scene graph — the
// line meshes are not raycast (same boundary DungeonRenderer.pickCell always
// kept), which is also what lets this run under node with no GPU.
import { Box3, Vector3, type Ray } from "three/webgpu";
import { glyphTop } from "./EntityLayer";
import type { CellGrid } from "../backplane/cell";

/** Half-width of a pick volume, in cells: a shade under the half-cell so
 *  adjacent columns keep a seam, wide enough that the letter's sway never
 *  carries it outside. */
const PICK_HALF_WIDTH = 0.45;

export interface PickOptions {
  /** Skip the hero's volume. First person must: the eye stands inside it, and
   *  a distance-0 self-hit would win every click. */
  skipHero?: boolean;
}

/**
 * The occupied cell whose volume the ray enters first, or null when it
 * crosses none — the caller falls back to the floor plane. Monsters and
 * objects only: terrain is the plane's business, and a transient effect
 * (a zap crossing a cell) must not eat a click on the floor behind it.
 */
export function pickEntityCell(
  ray: Ray, map: CellGrid, opts: PickOptions = {},
): { x: number; y: number } | null {
  const box = new Box3();
  const hit = new Vector3();
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      const cell = map.at(x, y);
      if (cell.category !== "being" && cell.category !== "item") continue;
      if (opts.skipHero && cell.hero) continue;
      box.min.set(x - PICK_HALF_WIDTH, 0, y - PICK_HALF_WIDTH);
      box.max.set(x + PICK_HALF_WIDTH, glyphTop(cell), y + PICK_HALF_WIDTH);
      if (!ray.intersectBox(box, hit)) continue;
      const d = hit.distanceToSquared(ray.origin);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}
