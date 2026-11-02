// The shared grid movement primitives, driven over hand-drawn CellGrids: the
// BFS first step, the exploration frontier test and the farthest reachable
// cell. No engine, no Module — only the Backplane grid.
import { describe, expect, it } from "vitest";
import { CellGrid, type Category } from "../../src/backplane/cell";
import { DIRS, farthest, isFrontier, nextStep, posKey } from "../../src/bot/pathing";

/** Build a grid from rows: '#' wall, '.' floor, '+' door, ' ' unseen, '@' hero on floor. */
function grid(rows: string[]) {
  const g = new CellGrid(rows[0]!.length, rows.length);
  let hero = { x: 0, y: 0 };
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const cat: Category = ch === "#" ? "wall" : ch === "+" ? "door" : ch === " " ? "unseen" : "floor";
    if (ch === "@") { hero = { x, y }; g.set(x, y, { category: "being", ch: "@", color: 15, hero: true, terrain: { category: "floor", ch: ".", color: 7 } }); }
    else if (ch !== " ") g.set(x, y, { category: cat, ch, color: 7 });
  }));
  const passable = (x: number, y: number) => { const c = g.at(x, y).category; return c === "floor" || c === "door" || c === "being"; };
  return { g, hero, passable };
}

describe("DIRS", () => {
  it("runs clockwise from north, matching Larn's movementKey compass index", () => {
    expect(DIRS.map((d) => [d.dx, d.dy])).toEqual([[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]);
    expect(DIRS.map((d) => d.compass)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("nextStep", () => {
  it("returns the first step of a shortest path to the nearest target", () => {
    const { g, hero, passable } = grid([
      "#######",
      "#@....#",
      "#.....#",
      "#.....#",
      "#######",
    ]);
    // (1,1) -> (3,3): two diagonal steps; any first step but SE costs three. Unique.
    expect(nextStep(g, hero, (x, y) => x === 3 && y === 3, { passable })).toEqual({ x: 2, y: 2, dir: DIRS[3] });
    // Nearest of several targets wins: (2,1) is one step, (3,3) is two.
    expect(nextStep(g, hero, (x, y) => (x === 2 && y === 1) || (x === 3 && y === 3), { passable })).toEqual({ x: 2, y: 1, dir: DIRS[2] });
  });
  it("routes around blocked cells and returns null when nothing is reachable", () => {
    const { g, hero, passable } = grid([
      "#####",
      "#@..#",
      "#####",
    ]);
    const blocked = new Set([posKey(g, 2, 1)]);
    expect(nextStep(g, hero, (x) => x === 3, { passable, blocked })).toBeNull();
    expect(nextStep(g, hero, (x) => x === 3, { passable })).toEqual({ x: 2, y: 1, dir: DIRS[2] });
  });
  it("forbids diagonal moves into or out of a doorway only when asked (NetHack's rule)", () => {
    const { g, hero, passable } = grid([
      "####",
      "#@.#",
      "#.+#",
      "####",
    ]);
    // Target: the door at (2,2). Diagonal from (1,1) is the one-step route.
    expect(nextStep(g, hero, (x, y) => x === 2 && y === 2, { passable })).toEqual({ x: 2, y: 2, dir: DIRS[3] });
    // With the rule on, the door may only be entered orthogonally: first step is E or S.
    const on = nextStep(g, hero, (x, y) => x === 2 && y === 2, { passable, noDiagonalThroughDoors: true });
    expect(on!.dir.dx === 0 || on!.dir.dy === 0).toBe(true);
    expect(on!.x === 2 && on!.y === 2).toBe(false);
  });
  it("sees the doorway the hero is standing on through the terrain underlay", () => {
    const { g, passable } = grid([
      "####",
      "#..#",
      "#..#",
      "####",
    ]);
    // The hero glyph overwrites the Cell, so (1,1) reads "being"; only the
    // underlay still says door.
    g.set(1, 1, { category: "being", ch: "@", color: 15, hero: true, terrain: { category: "door", ch: "+", color: 7 } });
    const from = { x: 1, y: 1 };
    expect(nextStep(g, from, (x, y) => x === 2 && y === 2, { passable })).toEqual({ x: 2, y: 2, dir: DIRS[3] });
    // Stepping diagonally *out of* a doorway is the half a category read misses.
    const on = nextStep(g, from, (x, y) => x === 2 && y === 2, { passable, noDiagonalThroughDoors: true });
    expect(on!.dir.dx === 0 || on!.dir.dy === 0).toBe(true);
    expect(on!.x === 2 && on!.y === 2).toBe(false);
  });
  it("sees the doorway the hero is standing on through CellGrid.under", () => {
    const { g, passable } = grid([
      "####",
      "#+.#",
      "#..#",
      "####",
    ]);
    // No terrain hint this time: landing on the door is what stashes it in
    // grid.under, the only record left of what the hero is standing on.
    g.set(1, 1, { category: "being", ch: "@", color: 15, hero: true });
    const from = { x: 1, y: 1 };
    expect(nextStep(g, from, (x, y) => x === 2 && y === 2, { passable })).toEqual({ x: 2, y: 2, dir: DIRS[3] });
    const on = nextStep(g, from, (x, y) => x === 2 && y === 2, { passable, noDiagonalThroughDoors: true });
    expect(on!.dir.dx === 0 || on!.dir.dy === 0).toBe(true);
    expect(on!.x === 2 && on!.y === 2).toBe(false);
  });
});

describe("isFrontier and farthest", () => {
  it("a frontier cell is passable with an unseen neighbour", () => {
    const { g, passable } = grid([
      "#####",
      "#@.  ",
      "#####",
    ]);
    expect(isFrontier(g, 2, 1, passable)).toBe(true);
    expect(isFrontier(g, 1, 1, passable)).toBe(false);
    expect(isFrontier(g, 0, 0, passable)).toBe(false); // a wall is never a frontier
  });
  it("farthest returns the last cell BFS reaches, or null when the hero cannot move", () => {
    const { g, hero, passable } = grid([
      "#######",
      "#@....#",
      "#######",
    ]);
    expect(farthest(g, hero, { passable })).toBe(posKey(g, 5, 1));
    const { g: g2, hero: h2, passable: p2 } = grid(["###", "#@#", "###"]);
    expect(farthest(g2, h2, { passable: p2 })).toBeNull();
  });
  it("farthest treats the blocked set as impassable, not as a filter on the answer", () => {
    const { g, hero, passable } = grid([
      "#########",
      "#@......#",
      "#########",
    ]);
    expect(farthest(g, hero, { passable })).toBe(posKey(g, 7, 1));
    // One blocked cell pinches the corridor. Everything past it stays passable,
    // so a farthest() that only refused to *return* a blocked cell would still
    // answer (7,1); routing around it, the hero reaches no farther than (3,1).
    const pinched = new Set([posKey(g, 4, 1)]);
    expect(farthest(g, hero, { passable, blocked: pinched })).toBe(posKey(g, 3, 1));
    // Blocking the hero's only exit is the same as having none: no vantage point.
    const { g: g2, hero: h2, passable: p2 } = grid([
      "#####",
      "#@..#",
      "#####",
    ]);
    expect(farthest(g2, h2, { passable: p2, blocked: new Set([posKey(g2, 2, 1)]) })).toBeNull();
  });
});
