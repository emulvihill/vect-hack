// The stroke font is hand-authored coordinate data; a single mistyped digit
// produces a silently mangled letter. These checks pin the encoding invariants.
import { describe, expect, it } from "vitest";
import { GRID, RAW_FONT, glyphSegmentCount, glyphStrokes } from "../../src/render/vectorFont";

const POINT = new RegExp(`^([0-${GRID.xMax}][0-${GRID.yMax}]){2,}$`);

const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));

describe("vector font", () => {
  it("covers every printable ASCII character", () => {
    const missing = PRINTABLE.filter((ch) => !(ch in RAW_FONT));
    expect(missing).toEqual([]);
  });

  it("encodes strokes as whole points inside the authoring grid", () => {
    for (const [ch, spec] of Object.entries(RAW_FONT)) {
      if (spec === "") continue;
      for (const stroke of spec.split("|")) {
        expect(stroke, `bad stroke in ${JSON.stringify(ch)}`)
          .toMatch(POINT);
      }
    }
  });

  it("normalises capitals to a 1x1 box centred on the origin", () => {
    for (const pts of glyphStrokes("H")) {
      for (let i = 0; i < pts.length; i += 2) {
        expect(Math.abs(pts[i]!)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(pts[i + 1]!)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it("draws something for every character except space", () => {
    for (const ch of PRINTABLE) {
      if (ch === " ") continue;
      expect(glyphSegmentCount(ch), `no segments for ${JSON.stringify(ch)}`)
        .toBeGreaterThan(0);
    }
    expect(glyphSegmentCount(" ")).toBe(0);
  });

  it("falls back to a visible mark for characters outside the table", () => {
    expect(glyphSegmentCount("é")).toBeGreaterThan(0);
  });
});
