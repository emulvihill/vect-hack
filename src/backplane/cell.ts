// The Backplane's semantic grid: one Cell per tile, presented by a Module's
// Classifier to the shared renderer/radar layer. Vocabulary per CONTEXT.md;
// design: docs/specs/2026-08-02-backplane-design.md.
//
// Grid mechanics (bounds, hero stash, cursor, terrain revision) moved verbatim
// out of the render layer's MapModel, since deleted — they were already
// engine-agnostic.
// Classification stayed behind in each Module (src/modules/nethack/
// classifier.ts). Nothing here may import from src/modules/* or src/render/.

/** Closed set, shared-layer-owned: exactly what renderer and radar branch on. */
export type Category =
  | "unseen"                                    // draw nothing
  | "floor" | "corridor" | "wall"
  | "door" | "door-open"
  | "stairs" | "water" | "lava" | "trap"
  | "feature"                                   // other terrain: letterform on floor
  | "being" | "item" | "effect";

/** The terrain group: Categories the static level geometry is built from. */
export const TERRAIN_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "floor", "corridor", "wall", "door", "door-open",
  "stairs", "water", "lava", "trap", "feature",
]);

export interface Cell {
  category: Category;
  /** Terrain beneath a being/item/effect Cell, when the Module knows it.
   *  Category must be in TERRAIN_CATEGORIES; hints on it are ignored. */
  terrain?: Cell;
  /** Open, module-owned, optional. The renderer ignores it today — the
   *  strongest form of "unknown Kinds draw acceptably". */
  kind?: string;
  /** The letterform the vector font draws; also the tty character. */
  ch: string;
  /** 16-slot palette index (the ANSI-16 vocabulary, today's CLR — see
   *  src/backplane/colors.ts). Skins retint by index; this is the only color
   *  the 3D renderer and radar read. */
  color: number;
  /** Engine-true 24-bit color; tty/debug views may prefer it. */
  rgb?: number;
  // Standard hints — named booleans, never engine flag words.
  hero?: boolean;
  pet?: boolean;
  /** Effect drawn as an arcing beam along ch's axis (-|/\), not a letterform. */
  beam?: boolean;
}

/** What an untouched or out-of-bounds cell reads as. color 7 = gray. */
const UNSEEN: Cell = { category: "unseen", ch: " ", color: 7 };

/** A cell's terrain identity for revision tracking and static geometry. */
export const terrainOf = (c: Cell): Category | null => {
  if (TERRAIN_CATEGORIES.has(c.category)) return c.category;
  const underlay = c.terrain?.category;
  return underlay !== undefined && TERRAIN_CATEGORIES.has(underlay) ? underlay : null;
};

export class CellGrid {
  /** Row-major, dumb data. Public on purpose: the AGENTS.md dumpMap page
   *  helper reads cells[y*cols+x] honestly instead of through a private. */
  readonly cells: Cell[];
  /** Bumped whenever terrain changed, so static geometry can rebuild lazily. */
  terrainRevision = 0;
  /** Hero position, set by the hero hint; modules may also write it. */
  hero: { x: number; y: number } | null = null;
  /**
   * The terrain Cell the hero landed on, either previously visible or supplied
   * beneath a being/item/effect — the hero glyph overwrites the grid Cell, so
   * this is the only record of what is beneath. Null when terrain is unknown
   * or malformed, or after clear(): a full redraw repaints the hero straight
   * over unseen ground.
   */
  under: Cell | null = null;
  /** Where the engine last put the map cursor (getpos: farlook, travel). */
  cursor: { x: number; y: number } | null = null;

  readonly cols: number;
  readonly rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: cols * rows }, () => ({ ...UNSEEN }));
  }

  at(x: number, y: number): Cell {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return UNSEEN;
    return this.cells[y * this.cols + x]!;
  }

  /** Replace a cell. The grid takes ownership of `cell` (Classifiers hand
   *  over fresh objects); hero-landing stash + revision logic ride along. */
  set(x: number, y: number, cell: Cell): void {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = y * this.cols + x;
    const prev = this.cells[i]!;
    // Landing, not repainting: a hero redrawn over the hero (Ctrl-R, level
    // redraw) must not clobber the stash with "@".
    if (cell.hero && !prev.hero) {
      const terrain = terrainOf(prev);
      this.under = terrain === null
        ? null
        : prev.category === terrain
          ? prev
          : prev.terrain?.category === terrain ? prev.terrain : null;
    }
    this.cells[i] = cell;
    if (cell.hero) this.hero = { x, y };
    if (terrainOf(cell) !== terrainOf(prev)) this.terrainRevision++;
  }

  clear(): void {
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = { ...UNSEEN };
    this.hero = null;
    this.under = null;
    this.cursor = null;
    this.terrainRevision++;
  }
}

/**
 * Whether a Category leaves its tile open — floors get a tile, walls get a
 * ridge. Only "unseen" and "wall" are closed, so "being", "item" and "effect"
 * answer true: the domain is every Category, not the terrain group alone.
 * MapModel's isOpen took a TerrainKind and could not see them.
 *
 * That widening is a trap for the caller. TerrainBuilder's kind() decides
 * open/closed from terrainOf(): a being/item/effect without a valid underlay
 * becomes "unseen" (closed), while one with a valid underlay exposes that
 * terrain. emitFloor reads the answer to pick a floor edge's border or interior
 * gain. Substituting isOpen(grid.at(x, y).category) mechanically flips an
 * occupied tile whose terrain is missing or closed from border to interior — a
 * visible brightness change in its surrounding floor edges. A caller that wants
 * terrain must keep asking about terrain: pass terrainOf(cell), or "unseen"
 * when it returns null.
 */
export function isOpen(c: Category): boolean {
  return c !== "unseen" && c !== "wall";
}

/**
 * Fair game for the pointer's one-click attack and the radar's alert: a
 * being, not the hero, not a pet. Peacefulness is not exposed at this layer
 * (NetHack never tells the windowport), so this is an approximation; the
 * engine's own attack confirmation is the real backstop.
 */
export function isHostile(c: Cell): boolean {
  return c.category === "being" && !c.hero && !c.pet;
}
