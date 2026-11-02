// The radar is geometry: a bearing that has to survive a camera rotation and a
// ring that has to stay Manhattan while the bearing stays euclidean. Driven by
// a synthetic map, and painted into a recording 2D context so the drawing side
// can be checked without a canvas.
import { describe, expect, it } from "vitest";
import { CLR } from "../../src/backplane/colors";
import { CellGrid } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import {
  ALERT_RANGE, RADAR_RANGE, drawRadar, fitBacking, proximityInk, pulseEnvelope, radarBlips,
  underThreat,
} from "../../src/ui/hud/Radar";
import type { Blip } from "../../src/ui/hud/Radar";
import type { GlyphCell } from "../../src/modules/nethack/protocol";

// Stand-in for the GLYPH_*_OFF values libnhmain exports; only the ordering and
// the relative gaps matter to the classifier.
const GLYPH_CONSTANTS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};
const TERRAIN = 610, OBJECT = 520, MONSTER = 12, PET = 110, ZAP = 710;

const HERO = { x: 40, y: 10 };
/** Camera bearing looking north up the map — the radar's default reading. */
const NORTH_UP = 0;

const cell = (glyph: number, ch: string, color: number = CLR.GRAY, glyphflags = 0): GlyphCell =>
  ({ glyph, ch, color, glyphflags });

const clf = new NetHackClassifier();
clf.configure(GLYPH_CONSTANTS);

const put = (m: CellGrid, x: number, y: number, g: GlyphCell) =>
  m.set(x, y, clf.classify(g));

function model(): CellGrid {
  const m = new CellGrid(NETHACK_COLS, NETHACK_ROWS);
  put(m, HERO.x, HERO.y, cell(MONSTER, "@", CLR.WHITE, MG.HERO));
  return m;
}

/** One monster `dx, dy` cells from the hero. dy is negative toward the north. */
function withMonster(dx: number, dy: number, color: number = CLR.GREEN): CellGrid {
  const m = model();
  put(m, HERO.x + dx, HERO.y + dy, cell(MONSTER, "d", color));
  return m;
}

const only = (m: CellGrid, facing = NORTH_UP): Blip => {
  const blips = radarBlips(m, facing);
  expect(blips).toHaveLength(1);
  return blips[0]!;
};

const reach = (b: Blip): number => Math.hypot(b.u, b.v);

describe("radarBlips", () => {
  it("plots one blip per monster and nothing else", () => {
    const m = model();
    put(m, 42, 10, cell(MONSTER, "d"));
    put(m, 38, 12, cell(MONSTER, "F"));
    put(m, 41, 9, cell(PET, "f"));          // pets are monsters too
    put(m, 43, 11, cell(OBJECT, "["));
    put(m, 44, 11, cell(TERRAIN, "."));
    put(m, 45, 11, cell(ZAP, "|"));
    expect(radarBlips(m, NORTH_UP).map((b) => b.ch).sort()).toEqual(["F", "d", "f"]);
  });

  it("shows nothing before the hero has a position", () => {
    const m = new CellGrid(NETHACK_COLS, NETHACK_ROWS);
    put(m, 42, 10, cell(MONSTER, "d"));
    expect(radarBlips(m, NORTH_UP)).toEqual([]);
  });

  it("carries the monster's own symbol and colour", () => {
    const b = only(withMonster(0, -3, CLR.MAGENTA));
    expect(b.ch).toBe("d");
    expect(b.color).toBe(CLR.MAGENTA);
  });

  it("puts north at the top when the camera looks north", () => {
    const north = only(withMonster(0, -4));
    expect(north.v).toBeGreaterThan(0);
    expect(north.u).toBeCloseTo(0);

    const east = only(withMonster(4, 0));
    expect(east.u).toBeGreaterThan(0);
    expect(east.v).toBeCloseTo(0);
  });

  it("turns the blips with the camera, so up is always forward", () => {
    // Bearing pi/2 puts the camera east of the hero looking west; from there
    // north is off the right shoulder.
    const north = only(withMonster(0, -4), Math.PI / 2);
    expect(north.u).toBeCloseTo(1 * (4 / RADAR_RANGE));
    expect(north.v).toBeCloseTo(0);

    // Half a turn from the default flips the map end for end.
    const flipped = only(withMonster(0, -4), Math.PI);
    expect(flipped.v).toBeCloseTo(-(4 / RADAR_RANGE));
  });

  it("measures the ring in Manhattan squares, not euclidean ones", () => {
    // Three east and three north is six squares of walking, so it sits on the
    // rim even though it is only 4.24 cells away as the crow flies.
    const diagonal = only(withMonster(3, -3));
    expect(diagonal.distance).toBe(6);
    expect(reach(diagonal)).toBeCloseTo(1);
    // ...and still bears north-east.
    expect(diagonal.u).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.v).toBeCloseTo(Math.SQRT1_2);
  });

  it("plots what is inside the rim proportionally, and flags it near", () => {
    const b = only(withMonster(0, -3));
    expect(b.distance).toBe(3);
    expect(b.near).toBe(true);
    expect(reach(b)).toBeCloseTo(0.5);
  });

  it("closes on the centre step by step as the distance falls", () => {
    let prev = Infinity;
    for (let d = RADAR_RANGE; d >= 1; d--) {
      const r = reach(only(withMonster(0, -d)));
      expect(r).toBeLessThan(prev);
      prev = r;
    }
  });

  it("lets a monster at distance zero leave the radar", () => {
    // A monster standing where the hero stands has no bearing to plot; the
    // scene itself is showing it. It simply drops off.
    const m = model();
    put(m, HERO.x, HERO.y, cell(MONSTER, "X", CLR.RED));
    expect(radarBlips(m, NORTH_UP)).toEqual([]);
  });

  it("marks pets as pets, by flag or glyph range", () => {
    const m = model();
    put(m, HERO.x + 2, HERO.y, cell(MONSTER, "d", CLR.GRAY, MG.PET));
    expect(only(m).pet).toBe(true);
    expect(only(withMonster(2, 0)).pet).toBe(false);
  });

  it("clamps what is beyond the rim to the rim, at its true bearing", () => {
    const b = only(withMonster(0, -9));
    expect(b.distance).toBe(9);
    expect(b.near).toBe(false);
    expect(reach(b)).toBeCloseTo(1);
    expect(b.u).toBeCloseTo(0);
    expect(b.v).toBeCloseTo(1);
  });

  it("keeps a monster exactly on the rim as a live threat", () => {
    const b = only(withMonster(0, -RADAR_RANGE));
    expect(b.near).toBe(true);
    expect(reach(b)).toBeCloseTo(1);
  });
});

// ---- painting ------------------------------------------------------------

interface Stroked { style: string; points: number[] }

/**
 * The slice of CanvasRenderingContext2D the radar uses, recording every stroke
 * with the ink it was drawn in. Ink is what identifies a mark: the proximity
 * ramp belongs to the distance numerals and to nothing else.
 */
function recordingCtx(): { ctx: CanvasRenderingContext2D; strokes: Stroked[] } {
  const strokes: Stroked[] = [];
  let path: number[] = [];
  const ctx = {
    strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1,
    lineCap: "butt", lineJoin: "miter", globalCompositeOperation: "source-over",
    save() {}, restore() {}, setTransform() {}, clearRect() {}, closePath() {}, fill() {},
    beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push(x, y); },
    lineTo(x: number, y: number) { path.push(x, y); },
    // The radar's arcs are all centred on the widget, so the four quarter
    // points stand in for the whole circle.
    arc(x: number, y: number, r: number) { path.push(x - r, y, x + r, y, x, y - r, x, y + r); },
    stroke() { strokes.push({ style: String(ctx.strokeStyle), points: [...path] }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const SIZE = 200;

function paint(m: CellGrid, facing = NORTH_UP): Stroked[] {
  const { ctx, strokes } = recordingCtx();
  drawRadar(ctx, radarBlips(m, facing), SIZE);
  return strokes;
}

/** Every ink the distance numerals can be drawn in, and no other mark uses. */
const PROXIMITY_INKS = new Set(
  Array.from({ length: 50 }, (_, d) => proximityInk(d)));

describe("drawRadar", () => {
  it("numbers a monster pinned to the rim", () => {
    const marks = paint(withMonster(0, -9));
    expect(marks.some((s) => s.style === proximityInk(9))).toBe(true);
  });

  it("leaves a monster inside the rim without a number — its position says it", () => {
    const m = withMonster(0, -3);
    expect(only(m).near).toBe(true);
    expect(paint(m).some((s) => PROXIMITY_INKS.has(s.style))).toBe(false);
  });

  it("numbers a monster at exactly the rim distance", () => {
    const marks = paint(withMonster(0, -RADAR_RANGE));
    expect(marks.some((s) => s.style === proximityInk(RADAR_RANGE))).toBe(true);
  });

  it("cools the number as the monster recedes", () => {
    expect(proximityInk(RADAR_RANGE)).not.toBe(proximityInk(3 * RADAR_RANGE));
    // Clamped either side, so an off-ramp distance can never go uncoloured.
    expect(proximityInk(99)).toBe(proximityInk(3 * RADAR_RANGE));
  });

  it("colours the rim with the alert blend when one is passed", () => {
    const { ctx, strokes } = recordingCtx();
    drawRadar(ctx, [], SIZE, 0);
    const resting = new Set(strokes.map((s) => s.style));
    const { ctx: ctx2, strokes: alerted } = recordingCtx();
    drawRadar(ctx2, [], SIZE, 1);
    expect(alerted.some((s) => !resting.has(s.style))).toBe(true);
  });

  it("still draws the rim on an empty level", () => {
    const { ctx, strokes } = recordingCtx();
    drawRadar(ctx, [], SIZE);
    expect(strokes.length).toBeGreaterThan(0);
  });

  it("keeps every mark inside the widget, wherever the monsters are", () => {
    const m = model();
    // A ring of contacts at every bearing, on and beyond the rim, so the
    // arrows and numerals are pushed as far out as the layout allows.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const far = Math.round(Math.cos(a) * 9), near = Math.round(Math.sin(a) * 3);
      put(m, HERO.x + far, HERO.y + near, cell(MONSTER, "8", CLR.RED));
    }
    // The tightest case is a contact exactly on the rim: it is plotted at full
    // reach and still has to fit an arrow outside it and a numeral under it.
    for (const [dx, dy] of [[RADAR_RANGE, 0], [-RADAR_RANGE, 0], [0, RADAR_RANGE], [0, -RADAR_RANGE]])
      put(m, HERO.x + dx!, HERO.y + dy!, cell(MONSTER, "8", CLR.RED));
    // It is a round widget, so the honest bound is the inscribed circle, not
    // the box: nothing may reach past the edge at any bearing.
    for (const facing of [0, 0.7, Math.PI, 4.2])
      for (const { points } of paint(m, facing))
        for (let i = 0; i < points.length; i += 2)
          expect(Math.hypot(points[i]! - SIZE / 2, points[i + 1]! - SIZE / 2))
            .toBeLessThanOrEqual(SIZE / 2);
  });
});

describe("the backing store", () => {
  /** A fresh canvas: 300 x 150, the HTML default, and the only asymmetric start. */
  const fresh = () => ({ width: 300, height: 150 });

  it("squares the backing store whatever the pixel ratio", () => {
    // 1.25 is the trap: 240 CSS px x 1.25 lands on 300, the default width, so a
    // guard that watches width alone would leave height at the default 150 and
    // the widget would paint square into a 2:1 store — stretched and cropped.
    for (const ratio of [1, 1.25, 1.5, 2]) {
      const canvas = fresh();
      fitBacking(canvas, 240, ratio);
      expect([ratio, canvas.width]).toEqual([ratio, canvas.height]);
    }
  });

  it("scales by the ratio and reports it back for the context transform", () => {
    const canvas = fresh();
    expect(fitBacking(canvas, 240, 2)).toBeCloseTo(2);
    expect(canvas.width).toBe(480);
  });

  it("leaves an already-correct store alone", () => {
    const canvas = { width: 300, height: 300 };
    fitBacking(canvas, 240, 1.25);
    expect([canvas.width, canvas.height]).toEqual([300, 300]);
  });
});

describe("the approach warning", () => {
  const blips = (m: CellGrid) => radarBlips(m, NORTH_UP);

  it("trips on a non-pet closer than ALERT_RANGE", () => {
    expect(underThreat(blips(withMonster(0, -(ALERT_RANGE - 1))))).toBe(true);
    expect(underThreat(blips(withMonster(0, -ALERT_RANGE)))).toBe(false);
  });

  it("never trips on a pet", () => {
    const m = model();
    put(m, HERO.x + 1, HERO.y, cell(MONSTER, "f", CLR.GRAY, MG.PET));
    expect(underThreat(blips(m))).toBe(false);
    // ...but a pet's company does not mute a real threat beside it.
    put(m, HERO.x - 1, HERO.y, cell(MONSTER, "d", CLR.RED));
    expect(underThreat(blips(m))).toBe(true);
  });

  it("pulses in beats and dies away", () => {
    expect(pulseEnvelope(-0.1)).toBe(0);           // not started
    expect(pulseEnvelope(0)).toBe(0);              // rises from rest
    expect(pulseEnvelope(0.25)).toBeGreaterThan(0.5);
    expect(pulseEnvelope(99)).toBe(0);             // long over
    // The envelope fades: the second beat's peak is quieter than the first's.
    expect(pulseEnvelope(0.8)).toBeLessThan(pulseEnvelope(0.25));
  });
});
