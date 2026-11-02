// The Backplane's semantic grid — grid mechanics moved verbatim out of
// MapModel (hero stash, cursor, terrain revision), asserted with hand-built
// Cells and no game imports. The NetHack-specific classification assertions
// live in nethack-classifier.test.ts.
import { describe, expect, it } from "vitest";
import {
  CellGrid, TERRAIN_CATEGORIES, isHostile, isOpen, terrainOf, type Cell,
} from "../../src/backplane/cell";

const floor = (): Cell => ({ category: "floor", ch: ".", color: 7 });
const wall = (): Cell => ({ category: "wall", ch: "|", color: 7 });
const stairs = (): Cell => ({ category: "stairs", ch: ">", color: 7 });
const orc = (): Cell => ({ category: "being", ch: "o", color: 2 });
const orcOn = (terrain: Cell): Cell => ({ ...orc(), terrain } as Cell);
const hero = (): Cell => ({ category: "being", ch: "@", color: 15, hero: true });
const pet = (): Cell => ({ category: "being", ch: "f", color: 15, pet: true });
const sword = (): Cell => ({ category: "item", ch: ")", color: 6 });

describe("CellGrid", () => {
  it("starts unseen at the given dimensions, and reads unseen out of bounds", () => {
    const g = new CellGrid(80, 21);
    expect(g.cols).toBe(80);
    expect(g.rows).toBe(21);
    expect(g.cells.length).toBe(80 * 21);
    expect(g.at(0, 0).category).toBe("unseen");
    expect(g.at(-1, 5).category).toBe("unseen");
    expect(g.at(80, 0).category).toBe("unseen");
    expect(g.hero).toBeNull();
    expect(g.under).toBeNull();
    expect(g.cursor).toBeNull();
  });

  it("stores cells row-major — the dumpMap page helper reads cells[y*cols+x]", () => {
    const g = new CellGrid(80, 21);
    g.set(3, 2, floor());
    expect(g.cells[2 * 80 + 3]!.ch).toBe(".");
  });

  it("clips out-of-bounds writes instead of throwing", () => {
    const g = new CellGrid(80, 21);
    g.set(-1, 0, floor());
    g.set(0, 21, floor());
    expect(g.terrainRevision).toBe(0);
  });

  it("tracks the hero from the hero hint and forgets it on clear()", () => {
    const g = new CellGrid(80, 21);
    g.set(20, 8, hero());
    expect(g.hero).toEqual({ x: 20, y: 8 });
    g.clear();
    expect(g.hero).toBeNull();
  });

  it("stashes the Cell under the hero when the hero lands on terrain", () => {
    const g = new CellGrid(80, 21);
    g.set(5, 5, stairs());
    g.set(5, 5, hero());
    expect(g.under).toMatchObject({ category: "stairs", ch: ">" });
  });

  it("stashes null when the hero lands on a cell showing an item", () => {
    const g = new CellGrid(80, 21);
    g.set(5, 5, sword());
    g.set(5, 5, hero());
    expect(g.under).toBeNull();
  });

  it("stashes a supplied terrain Cell when the hero lands on an occupant", () => {
    const g = new CellGrid(80, 21);
    const beneath = floor();
    g.set(5, 5, orcOn(beneath));
    g.set(5, 5, hero());
    expect(g.under).toBe(beneath);
  });

  it("does not stash a malformed non-terrain underlay", () => {
    const g = new CellGrid(80, 21);
    g.set(5, 5, orcOn(sword()));
    g.set(5, 5, hero());
    expect(g.under).toBeNull();
  });

  it("keeps the stash across an in-place hero repaint", () => {
    const g = new CellGrid(80, 21);
    g.set(5, 5, stairs());
    g.set(5, 5, hero());
    g.set(5, 5, hero()); // Ctrl-R style repaint
    expect(g.under).toMatchObject({ category: "stairs", ch: ">" });
  });

  it("replaces the stash when the hero moves to another cell", () => {
    const g = new CellGrid(80, 21);
    g.set(5, 5, stairs());
    g.set(5, 5, hero());
    g.set(5, 5, stairs());   // engine repaints the vacated cell
    g.set(6, 5, floor());
    g.set(6, 5, hero());
    expect(g.under).toMatchObject({ category: "floor", ch: "." });
  });

  it("bumps terrainRevision only when a cell's terrain identity changes", () => {
    const g = new CellGrid(80, 21);
    g.set(1, 1, floor());
    const after = g.terrainRevision;
    expect(after).toBeGreaterThan(0);
    g.set(1, 1, floor());          // same terrain: no bump
    expect(g.terrainRevision).toBe(after);
    g.set(2, 2, orc());            // being on an unseen cell: no terrain changed
    expect(g.terrainRevision).toBe(after);
    g.set(1, 1, wall());           // floor -> wall: bump
    expect(g.terrainRevision).toBeGreaterThan(after);
    const beforeOrc = g.terrainRevision;
    g.set(1, 1, orc());            // a being covering terrain: the wall stops
    expect(g.terrainRevision).toBeGreaterThan(beforeOrc); // being drawn -> bump
  });

  it("does not bump terrainRevision when floor gains an occupant carrying floor underlay", () => {
    const g = new CellGrid(80, 21);
    g.set(1, 1, floor());
    const revision = g.terrainRevision;
    g.set(1, 1, orcOn(floor()));
    expect(g.terrainRevision).toBe(revision);
  });

  it("still bumps terrainRevision when floor gains an occupant without underlay", () => {
    const g = new CellGrid(80, 21);
    g.set(1, 1, floor());
    const revision = g.terrainRevision;
    g.set(1, 1, orc());
    expect(g.terrainRevision).toBe(revision + 1);
  });

  it("bumps terrainRevision when floor gains an occupant with malformed underlay", () => {
    const g = new CellGrid(80, 21);
    g.set(1, 1, floor());
    const revision = g.terrainRevision;
    g.set(1, 1, orcOn(orc()));
    expect(g.terrainRevision).toBe(revision + 1);
  });

  it("clear() forgets cells, stash, cursor and bumps the revision", () => {
    const g = new CellGrid(80, 21);
    g.set(5, 5, stairs());
    g.set(5, 5, hero());
    g.cursor = { x: 1, y: 1 };
    const rev = g.terrainRevision;
    g.clear();
    expect(g.at(5, 5).category).toBe("unseen");
    expect(g.under).toBeNull();
    expect(g.cursor).toBeNull();
    expect(g.terrainRevision).toBeGreaterThan(rev);
  });
});

describe("category helpers", () => {
  it("terrainOf rejects a malformed non-terrain underlay", () => {
    expect(terrainOf(orcOn(orc()))).toBeNull();
  });

  it("TERRAIN_CATEGORIES is exactly the terrain group", () => {
    expect([...TERRAIN_CATEGORIES].sort()).toEqual([
      "corridor", "door", "door-open", "feature", "floor",
      "lava", "stairs", "trap", "wall", "water",
    ]);
  });

  it("isOpen: stand-on-able is everything but unseen and wall", () => {
    expect(isOpen("floor")).toBe(true);
    expect(isOpen("door")).toBe(true);
    expect(isOpen("lava")).toBe(true); // stand-on-able, briefly
    expect(isOpen("wall")).toBe(false);
    expect(isOpen("unseen")).toBe(false);
  });

  it("isHostile: a being that is neither the hero nor a pet", () => {
    expect(isHostile(orc())).toBe(true);
    expect(isHostile(hero())).toBe(false);
    expect(isHostile(pet())).toBe(false);
    expect(isHostile(sword())).toBe(false);
    expect(isHostile(floor())).toBe(false);
  });
});
