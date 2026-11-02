// Grid movement primitives every Module's bot needs: a BFS first-step toward
// the nearest target, the frontier test that drives exploration, and the
// farthest reachable cell (a fresh vantage point when exploration is done).
// Ported from the NetHack bot's policy.ts with the model replaced by
// callbacks, so it knows only the Backplane CellGrid. Game-free.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import { terrainOf, type CellGrid } from "../backplane/cell.ts";

export interface Dir { dx: number; dy: number; compass: number }

/** Clockwise from north. `compass` is the index Larn's movementKey() takes;
 *  every Module maps a Dir to its own key encoding. */
export const DIRS: readonly Dir[] = [
  { dx: 0, dy: -1, compass: 0 }, { dx: 1, dy: -1, compass: 1 },
  { dx: 1, dy: 0, compass: 2 }, { dx: 1, dy: 1, compass: 3 },
  { dx: 0, dy: 1, compass: 4 }, { dx: -1, dy: 1, compass: 5 },
  { dx: -1, dy: 0, compass: 6 }, { dx: -1, dy: -1, compass: 7 },
];

export const posKey = (grid: { cols: number }, x: number, y: number) => y * grid.cols + x;

export interface PathRules {
  /** May the hero step onto (x, y)? Bounds are already checked. */
  passable(x: number, y: number): boolean;
  /** posKeys to route around: the anti-stuck list. */
  blocked?: ReadonlySet<number>;
  /** NetHack forbids diagonal movement into or out of a doorway. The doorway
   *  is resolved through the underlay (a Cell's `terrain`, or CellGrid.under
   *  for the hero's own cell): the hero glyph overwrites the grid Cell, so the
   *  cell being stepped out of reads "being", never "door". */
  noDiagonalThroughDoors?: boolean;
}

export interface Step { x: number; y: number; dir: Dir }

const inBounds = (grid: CellGrid, x: number, y: number) =>
  x >= 0 && x < grid.cols && y >= 0 && y < grid.rows;

/** Is (x, y) a doorway? Read through the underlay, not the drawn category: a
 *  being/item cell hides its terrain in `terrain`, and the hero's own cell —
 *  the one a diagonal step leaves, so the "out of a doorway" half of the rule
 *  depends on it — keeps its terrain only in CellGrid.under. */
const isDoorway = (grid: CellGrid, x: number, y: number) => {
  const c = grid.at(x, y);
  const cat = terrainOf(c) ?? (c.hero ? grid.under?.category : undefined) ?? c.category;
  return cat === "door" || cat === "door-open";
};

function canStep(grid: CellGrid, rules: PathRules, cx: number, cy: number, d: Dir): boolean {
  const nx = cx + d.dx, ny = cy + d.dy;
  if (!inBounds(grid, nx, ny)) return false;
  if (rules.blocked?.has(posKey(grid, nx, ny))) return false;
  if (!rules.passable(nx, ny)) return false;
  if (rules.noDiagonalThroughDoors && d.dx !== 0 && d.dy !== 0
    && (isDoorway(grid, cx, cy) || isDoorway(grid, nx, ny))) return false;
  return true;
}

/** BFS from `from`; the FIRST step toward the nearest cell satisfying
 *  isTarget (the start cell itself never counts). Null when none is reachable. */
export function nextStep(
  grid: CellGrid,
  from: { x: number; y: number },
  isTarget: (x: number, y: number) => boolean,
  rules: PathRules,
): Step | null {
  const prev = new Int32Array(grid.cols * grid.rows).fill(-1);
  const start = posKey(grid, from.x, from.y);
  prev[start] = start;
  const queue = [start];
  let found = -1;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const cx = cur % grid.cols, cy = (cur / grid.cols) | 0;
    if (cur !== start && isTarget(cx, cy)) { found = cur; break; }
    for (const d of DIRS) {
      if (!canStep(grid, rules, cx, cy, d)) continue;
      const nk = posKey(grid, cx + d.dx, cy + d.dy);
      if (prev[nk] !== -1) continue;
      prev[nk] = cur;
      queue.push(nk);
    }
  }
  if (found === -1) return null;
  let cur = found;
  while (prev[cur] !== start) cur = prev[cur]!;
  const x = cur % grid.cols, y = (cur / grid.cols) | 0;
  const dir = DIRS.find((d) => d.dx === x - from.x && d.dy === y - from.y)!;
  return { x, y, dir };
}

/** A passable cell with at least one unseen neighbour: where exploring goes. */
export function isFrontier(
  grid: CellGrid, x: number, y: number, passable: (x: number, y: number) => boolean,
): boolean {
  if (!inBounds(grid, x, y) || !passable(x, y)) return false;
  for (const d of DIRS) {
    const nx = x + d.dx, ny = y + d.dy;
    if (inBounds(grid, nx, ny) && grid.at(nx, ny).category === "unseen") return true;
  }
  return false;
}

/** BFS layer sweep; the posKey of the last cell visited — the farthest
 *  reachable one — or null when the hero cannot move at all. */
export function farthest(grid: CellGrid, from: { x: number; y: number }, rules: PathRules): number | null {
  const start = posKey(grid, from.x, from.y);
  const seen = new Uint8Array(grid.cols * grid.rows);
  seen[start] = 1;
  let layer = [start];
  let last = -1;
  while (layer.length) {
    const next: number[] = [];
    for (const cur of layer) {
      last = cur;
      const cx = cur % grid.cols, cy = (cur / grid.cols) | 0;
      for (const d of DIRS) {
        if (!canStep(grid, rules, cx, cy, d)) continue;
        const nk = posKey(grid, cx + d.dx, cy + d.dy);
        if (seen[nk]) continue;
        seen[nk] = 1;
        next.push(nk);
      }
    }
    layer = next;
  }
  return last === start ? null : last;
}
