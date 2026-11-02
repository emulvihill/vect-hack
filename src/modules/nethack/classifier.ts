// The NetHack Classifier: engine glyphs -> Backplane Cells (CONTEXT.md).
// Category comes from the glyph number (unambiguous); within the terrain
// group, the Category comes from the tty character, because NetHack only
// exports the coarse GLYPH_*_OFF boundaries and not per-symbol cmap
// offsets. Moved out of the render layer's MapModel by the Backplane extraction
// (docs/specs/2026-08-02-backplane-design.md); the
// classification itself is pinned unchanged by nethack-classifier.test.ts.
import type { Category, Cell } from "../../backplane/cell";
import { CLR } from "../../backplane/colors";
import type { GlyphCell } from "./protocol";

/** NetHack's map is 80x21 (COLNO x ROWNO); the Module's views size their
 *  CellGrid from these, so they stop being render-layer constants. */
export const NETHACK_COLS = 80;
export const NETHACK_ROWS = 21;

/** MG_* bits from include/display.h that the client cares about. */
export const MG = {
  HERO: 0x1, CORPSE: 0x2, INVIS: 0x4, DETECT: 0x8,
  PET: 0x10, RIDDEN: 0x20, STATUE: 0x40, OBJPILE: 0x80,
} as const;

/** The GLYPH_* offsets libnhmain exposes on nethackGlobal.constants.GLYPH. */
interface GlyphOffsets {
  pet: number; invis: number; detect: number; body: number; ridden: number;
  obj: number; cmap: number; zap: number; explode: number; warning: number;
  statue: number; unexplored: number;
}

const NO_GLYPH = -1;

export class NetHackClassifier {
  private off: GlyphOffsets | null = null;

  configure(glyphConstants: Record<string, number | string> | undefined): void {
    const n = (k: string) => Number(glyphConstants?.[k] ?? -1);
    if (!glyphConstants) return;
    this.off = {
      pet: n("GLYPH_PET_OFF"), invis: n("GLYPH_INVIS_OFF"), detect: n("GLYPH_DETECT_OFF"),
      body: n("GLYPH_BODY_OFF"), ridden: n("GLYPH_RIDDEN_OFF"), obj: n("GLYPH_OBJ_OFF"),
      cmap: n("GLYPH_CMAP_OFF"), zap: n("GLYPH_ZAP_OFF"), explode: n("GLYPH_EXPLODE_OFF"),
      warning: n("GLYPH_WARNING_OFF"), statue: n("GLYPH_STATUE_OFF"),
      unexplored: n("GLYPH_UNEXPLORED_OFF"),
    };
  }

  /** One decoded glyph -> one Backplane Cell. Fresh object every call: the
   *  CellGrid takes ownership of what it is handed and keeps the displaced
   *  Cell as the under-stash, so a reused scratch object would rewrite the
   *  stash on the next glyph. Never hand out a cached Cell from here. */
  classify(g: GlyphCell): Cell {
    const cell: Cell = { category: this.categorize(g), ch: g.ch, color: g.color };
    if (g.glyphflags & MG.HERO) cell.hero = true;
    if (this.isPet(g)) cell.pet = true;
    if (this.off && g.glyph >= this.off.zap && g.glyph < this.off.explode) cell.beam = true;
    return cell;
  }

  private categorize(g: GlyphCell): Category {
    const o = this.off;
    if (!o) return "unseen";
    const n = g.glyph;
    if (n === NO_GLYPH || n < 0 || n >= o.unexplored) return "unseen";
    if (n >= o.statue) return "item";            // statues + piletop objects
    if (n >= o.warning) return "being";          // warning symbols track monsters
    if (n >= o.zap) return "effect";             // zaps, beams, explosions, swallow
    if (n >= o.cmap) return terrainCategory(g.ch, g.color);
    if (n >= o.obj) return "item";
    if (n >= o.body && n < o.ridden) return "item"; // corpses
    return "being";
  }

  /** Pets are flagged by MG_PET, or fall in the dedicated pet glyph range. */
  private isPet(g: GlyphCell): boolean {
    return (g.glyphflags & MG.PET) !== 0
      || (this.off !== null && g.glyph >= this.off.pet && g.glyph < this.off.invis);
  }
}

function terrainCategory(ch: string, color: number): Category {
  switch (ch) {
    // Dark stone. Was category "terrain" + kind "none", which every consumer
    // drew as nothing; "unseen" is the same nothing said directly.
    case " ": return "unseen";
    // Open doors share the wall symbols; NetHack tints them brown.
    case "|": case "-": return color === CLR.BROWN ? "door-open" : "wall";
    case ".": return "floor";
    case "#": return "corridor";
    case "+": return "door";
    case "<": case ">": return "stairs";
    // Pools and lava share '}'; only the colour tells them apart, and
    // mistaking one for the other is usually fatal. Lava is CLR_RED, or
    // CLR_ORANGE where the level tints it.
    case "}": return color === CLR.RED || color === CLR.ORANGE ? "lava" : "water";
    // Every trap type shares '^' in the default symset, and upstream's
    // is_cmap_trap() range also covers the web and the vibrating square.
    case "^": case "\"": case "~": return "trap";
    default: return "feature";
  }
}
