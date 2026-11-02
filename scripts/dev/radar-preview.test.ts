// Offline radar preview: runs the real drawRadar() against a 2D context that
// emits SVG instead of pixels, so the widget's layout can be checked from a
// terminal. Companion to scene-preview.test.ts, which does the same job for the
// dungeon. Stroke opacity stands in for additive compositing, so the glow reads
// dimmer here than it does on the GPU; the geometry is exact.
//
//   npm run preview            # writes .preview/radar.svg (+ .png if available)
import { it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLR } from "../../src/backplane/colors";
import { CellGrid } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import { drawRadar, radarBlips } from "../../src/ui/hud/Radar";
import type { GlyphCell } from "../../src/modules/nethack/protocol";

const OUT = process.env.RADAR_PREVIEW_OUT ?? ".preview/radar.svg";
const SIZE = 400;
/** Camera bearing: 0 looks north, which is how the map reads on paper. */
const FACING = Number(process.env.RADAR_PREVIEW_FACING ?? 0);
/** 0..1 blend of the rim toward the alert colour — the approach pulse's peak. */
const ALERT = Number(process.env.RADAR_PREVIEW_ALERT ?? 0);

/** Synthetic GLYPH_*_OFF values: only the ordering matters to the classifier. */
const GLYPH_OFFSETS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201, GLYPH_BODY_OFF: 301,
  GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501, GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700,
  GLYPH_EXPLODE_OFF: 800, GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910,
  GLYPH_UNEXPLORED_OFF: 1500,
};
const MONSTER = 12;
const HERO = { x: 40, y: 10 };

/** One of each case the layout has to survive, from underfoot to off-radar. */
const CONTACTS: [dx: number, dy: number, ch: string, color: number][] = [
  [1, 0, "d", CLR.RED],            // adjacent: the tightest numeral
  [0, -3, "F", CLR.GREEN],         // mid-range
  [3, 3, "k", CLR.BRIGHT_BLUE],    // exactly on the rim, diagonally
  [-10, -6, "Z", CLR.CYAN],        // beyond the rim
  [15, 8, "@", CLR.MAGENTA],       // beyond, and the widest glyph there is
  [0, 8, "h", CLR.YELLOW],         // beyond, straight down
];

const cell = (ch: string, color: number, glyphflags = 0): GlyphCell =>
  ({ glyph: MONSTER, ch, color, glyphflags });

/** The slice of CanvasRenderingContext2D drawRadar uses, spelled as SVG. */
function svgContext(parts: string[]) {
  let path = "";
  const ctx = {
    strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1,
    lineCap: "butt", lineJoin: "miter", globalCompositeOperation: "source-over",
    save() {}, restore() {}, setTransform() {}, clearRect() {}, closePath() {},
    beginPath() { path = ""; },
    moveTo(x: number, y: number) { path += `M${n(x)} ${n(y)}`; },
    lineTo(x: number, y: number) { path += `L${n(x)} ${n(y)}`; },
    // SVG has no circle command, so a full turn is two half-arcs.
    arc(x: number, y: number, r: number) {
      path += `M${n(x - r)} ${n(y)}A${n(r)} ${n(r)} 0 1 0 ${n(x + r)} ${n(y)}`
        + `A${n(r)} ${n(r)} 0 1 0 ${n(x - r)} ${n(y)}`;
    },
    fill() { parts.push(`<path d="${path}" fill="${ctx.fillStyle}"/>`); },
    stroke() {
      parts.push(`<path d="${path}" fill="none" stroke="${ctx.strokeStyle}"`
        + ` stroke-width="${n(ctx.lineWidth)}" stroke-opacity="${n(ctx.globalAlpha)}"`
        + ` stroke-linecap="round" stroke-linejoin="round"/>`);
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const n = (v: number): string => v.toFixed(2);

it("writes an SVG preview of the radar", () => {
  const clf = new NetHackClassifier();
  clf.configure(GLYPH_OFFSETS);
  const map = new CellGrid(NETHACK_COLS, NETHACK_ROWS);
  const put = (x: number, y: number, g: GlyphCell) => map.set(x, y, clf.classify(g));
  put(HERO.x, HERO.y, cell("@", CLR.WHITE, MG.HERO));
  for (const [dx, dy, ch, color] of CONTACTS)
    put(HERO.x + dx, HERO.y + dy, cell(ch, color));

  const parts = [`<rect width="${SIZE}" height="${SIZE}" fill="#000000"/>`];
  drawRadar(svgContext(parts), radarBlips(map, FACING), SIZE, ALERT);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"`
    + ` viewBox="0 0 ${SIZE} ${SIZE}">${parts.join("")}</svg>\n`);
});
