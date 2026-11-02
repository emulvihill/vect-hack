// Arcade stroke font: every printable ASCII character as polylines, in the
// straight-segment idiom of Atari's vector games (Asteroids/Tempest), not a
// Hershey-style curve font.
//
// Authoring grid is integer x 0..4, y 0..8 with baseline y=2, x-height y=5,
// cap/ascender y=8, descender y=0. Each character is "stroke|stroke|...";
// each stroke is a run of 2-char "xy" points. Output is normalized so a
// capital letter is exactly 1x1 centred on the origin.

/** The authoring grid. Also the single source for the encoding's validation. */
export const GRID = { xMax: 4, yMax: 8, baseline: 2, capHeight: 8 } as const;

export const RAW_FONT: Record<string, string> = {
  " ": "",
  "!": "2824|2223",
  '"': "1816|3836",
  "#": "1218|3238|0444|0646",
  "$": "473818070615354443321203|2822",
  "%": "0718271607|2334433223|0248",
  "&": "421506071827260403122244",
  "'": "2826",
  "(": "38161432",
  ")": "18363412",
  "*": "2228|0347|0743",
  "+": "2327|0545",
  ",": "2211",
  "-": "0545",
  ".": "2223",
  "/": "0248",
  "0": "120307183847433212|1337",
  "1": "172822|1232",
  "2": "07183847460242",
  "3": "084825354443321203",
  "4": "32380444",
  "5": "480805354443321203",
  "6": "473818070312324344351504",
  "7": "084812",
  "8": "15060718384746351504031232434435",
  "9": "031232434738180706153546",
  ":": "2324|2627",
  ";": "2627|242312",
  "<": "480542",
  "=": "0444|0646",
  ">": "084502",
  "?": "07183847462524|2223",
  "@": "120307183847433212|1425342314",
  "A": "0206284642|0444",
  "B": "02083847463505|3544433202",
  "C": "4738180703123243",
  "D": "02083847433202",
  "E": "48080242|0535",
  "F": "480802|0535",
  "G": "47381807031232434525",
  "H": "0208|4248|0545",
  "I": "1838|2822|1232",
  "J": "3833221203",
  "K": "0208|480542",
  "L": "080242",
  "M": "0208254842",
  "N": "02084248",
  "O": "120307183847433212",
  "P": "02083847463505",
  "Q": "120307183847433212|3341",
  "R": "02083847463505|2542",
  "S": "473818070615354443321203",
  "T": "0848|2822",
  "U": "080312324348",
  "V": "082248",
  "W": "0812253248",
  "X": "0248|0842",
  "Y": "082548|2522",
  "Z": "08480242",
  "[": "38181232",
  "\\": "0842",
  "]": "18383212",
  "^": "062846",
  _: "0242",
  "`": "1836",
  a: "4542|451504031242",
  b: "0802|053544433202",
  c: "4435150403123243",
  d: "4842|451504031242",
  e: "433212030415354404",
  f: "4738281712|0535",
  g: "451504031242|4541301001",
  h: "0802|0415354442",
  i: "2728|2522",
  j: "3738|3531201001",
  k: "0802|350332",
  l: "181232",
  m: "0205|04152422|24354442",
  n: "0205|0415354442",
  o: "120304153544433212",
  p: "0500|053544433202",
  q: "451504031242|4540",
  r: "0205|041535",
  s: "4515041333421203",
  t: "18132232|0535",
  u: "0503123243|4542",
  v: "052245",
  w: "0512243245",
  x: "0542|0245",
  y: "0503123243|4541301001",
  z: "05450242",
  "{": "38272615242332",
  "|": "2228",
  "}": "18272635242312",
  "~": "0415243544",
};

/** Fallback for anything outside the table: a small diamond. */
const UNKNOWN = "2435261524";

/** A polyline in glyph space: flat [x0,y0, x1,y1, ...], y up, origin centred. */
export type GlyphStroke = Float32Array;

const cache = new Map<string, GlyphStroke[]>();

const CAP_SPAN = GRID.capHeight - GRID.baseline;
const CAP_MID = (GRID.capHeight + GRID.baseline) / 2;

function parse(spec: string): GlyphStroke[] {
  const out: GlyphStroke[] = [];
  for (const stroke of spec.split("|")) {
    if (stroke.length < 4) continue; // need at least two points
    const pts = new Float32Array(stroke.length);
    for (let i = 0; i < stroke.length; i += 2) {
      // Cap height maps to 1.0 and the glyph box is centred on the origin.
      pts[i] = Number(stroke[i]) / GRID.xMax - 0.5;
      pts[i + 1] = (Number(stroke[i + 1]) - CAP_MID) / CAP_SPAN;
    }
    out.push(pts);
  }
  return out;
}

/** Polylines for `ch`, in glyph space. Cached; do not mutate the result.
 *  External caller: src/ui/hud/Radar.ts strokes its blip glyphs with these. */
export function glyphStrokes(ch: string): GlyphStroke[] {
  let s = cache.get(ch);
  if (!s) {
    s = parse(RAW_FONT[ch] ?? UNKNOWN);
    cache.set(ch, s);
  }
  return s;
}

/** Total segment count for `ch` — used to size batch buffers up front. */
export function glyphSegmentCount(ch: string): number {
  let n = 0;
  for (const s of glyphStrokes(ch)) n += s.length / 2 - 1;
  return n;
}
