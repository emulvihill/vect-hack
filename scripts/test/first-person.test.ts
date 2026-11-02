// The first-person camera (vect-hack-4i4) and the seams it needed: a camera
// interface both cameras satisfy, a per-cell glyph facing instead of one scalar
// bearing, a hero the camera can stand inside, and a per-mode stroke width.
// Everything here is pure math or plain objects — the DOM is a stub that
// records what the camera binds, so the pointer look can be driven headlessly.
import { describe, expect, it } from "vitest";
import { Vector3 } from "three/webgpu";
import { CLR } from "../../src/backplane/colors";
import { INK } from "../../src/render/palette";
import { CellGrid } from "../../src/backplane/cell";
import {
  MG, NETHACK_COLS, NETHACK_ROWS, NetHackClassifier,
} from "../../src/modules/nethack/classifier";
import { buildEntities } from "../../src/render/EntityLayer";
import { DungeonRenderer } from "../../src/render/DungeonRenderer";
import { EYE_HEIGHT, FirstPersonCam, MAX_PITCH } from "../../src/render/FirstPersonCam";
import { OrbitCam } from "../../src/render/OrbitCam";
import { LineBatch, beamLayers } from "../../src/render/LineBatch";
import { TOKENS } from "../../src/render/palette";
import { TURN_STEP, type DungeonCamera } from "../../src/render/DungeonCamera";
import type { GlyphCell } from "../../src/modules/nethack/protocol";

/** Synthetic GLYPH_*_OFF values: only the ordering matters to the classifier. */
const GLYPH_OFFSETS = {
  GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
  GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
  GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
  GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
};
const MONSTER = 12, PET = 110;
const TIME = 1.7;

const clf = new NetHackClassifier();
clf.configure(GLYPH_OFFSETS);

const blank = () => new CellGrid(NETHACK_COLS, NETHACK_ROWS);
const put = (map: CellGrid, x: number, y: number, g: GlyphCell) =>
  map.set(x, y, clf.classify(g));

interface Seg {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  r: number; g: number; b: number; gain: number;
}

/** A LineBatch stand-in that keeps every segment the builders emit. */
function recorder(out: Seg[]): LineBatch {
  return {
    begin() { out.length = 0; },
    add(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
        c: { r: number; g: number; b: number }, gain = 1) {
      out.push({ ax, ay, az, bx, by, bz, r: c.r, g: c.g, b: c.b, gain });
    },
    commit() {},
  } as unknown as LineBatch;
}

/** Segments that belong to the cell at (x, y); nothing else reaches this far. */
const atCell = (segs: readonly Seg[], x: number, y: number) =>
  segs.filter((s) => Math.abs(s.ax - x) < 0.8 && Math.abs(s.az - y) < 0.8);

/** An element that records what was bound to it and can fire it back. */
function stubDom() {
  const bound = new Map<string, Set<(e: unknown) => void>>();
  return {
    types: () => [...bound].filter(([, fns]) => fns.size).map(([t]) => t).sort(),
    fire(type: string, e: Record<string, unknown> = {}) {
      for (const fn of [...(bound.get(type) ?? [])]) fn({ preventDefault() {}, ...e });
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      (bound.get(type) ?? bound.set(type, new Set()).get(type)!).add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      bound.get(type)?.delete(fn);
    },
    setPointerCapture() {}, releasePointerCapture() {},
  };
}

type StubDom = ReturnType<typeof stubDom>;
const asDom = (d: StubDom) => d as unknown as HTMLElement;

/** Drag from (0, 0) by (dx, dy) pixels and let go. */
function drag(dom: StubDom, dx: number, dy: number): void {
  dom.fire("pointerdown", { clientX: 0, clientY: 0, pointerId: 1 });
  dom.fire("pointermove", { clientX: dx, clientY: dy, pointerId: 1 });
  dom.fire("pointerup", { clientX: dx, clientY: dy, pointerId: 1 });
}

function firstPerson(dom = stubDom(), yaw = 0) {
  return new FirstPersonCam(asDom(dom), { yaw });
}

describe("first-person eye", () => {
  it("stands in the followed cell at eye height", () => {
    const cam = firstPerson();
    cam.follow(12, 6);
    cam.snap();
    cam.update(0);
    expect(cam.camera.position.x).toBeCloseTo(12, 9);
    expect(cam.camera.position.y).toBeCloseTo(EYE_HEIGHT, 9);
    expect(cam.camera.position.z).toBeCloseTo(6, 9);
    // Below a wall top and above a door sill: the eye is inside the level.
    expect(EYE_HEIGHT).toBeGreaterThan(0);
    expect(EYE_HEIGHT).toBeLessThan(1.1);
  });

  it("eases toward a new cell with the orbital camera's follow feel", () => {
    const cam = firstPerson();
    cam.follow(10, 10);
    cam.snap();
    cam.update(0);
    cam.follow(20, 10);
    cam.update(0.18); // one FOLLOW_TAU: ~63% of the gap
    expect(cam.camera.position.x).toBeCloseTo(10 + 10 * (1 - Math.exp(-1)), 3);
    for (let i = 0; i < 200; i++) cam.update(1 / 60);
    expect(cam.camera.position.x).toBeCloseTo(20, 6);
  });

  it("snaps the ease when the level changes", () => {
    const cam = firstPerson();
    cam.follow(10, 10);
    cam.snap();
    cam.update(0);
    cam.follow(40, 3);
    cam.snap();
    cam.update(0);
    expect(cam.camera.position.x).toBeCloseTo(40, 9);
    expect(cam.camera.position.z).toBeCloseTo(3, 9);
  });
});

describe("first-person look", () => {
  it("yaws and pitches with the drag, in the orbital camera's direction", () => {
    const orbitDom = stubDom(), fpDom = stubDom();
    const orbit = new OrbitCam(asDom(orbitDom));
    const fp = firstPerson(fpDom);
    const restingElevation = orbit.elevation;
    drag(orbitDom, 100, 60);
    drag(fpDom, 100, 60);

    // The same drag turns the view the same way in both modes, and dragging
    // down looks down — which is what raising the orbital elevation does too.
    expect(orbit.azimuth).not.toBe(0);
    expect(fp.azimuth).toBeCloseTo(orbit.azimuth, 9);
    expect(orbit.elevation).toBeGreaterThan(restingElevation);
    expect(fp.pitch).toBeLessThan(0);
  });

  it("clamps the pitch short of straight up or down", () => {
    const up = stubDom(), down = stubDom();
    const a = firstPerson(up), b = firstPerson(down);
    drag(up, 0, -100000);
    drag(down, 0, 100000);
    expect(a.pitch).toBeCloseTo(MAX_PITCH, 9);
    expect(b.pitch).toBeCloseTo(-MAX_PITCH, 9);
    expect(MAX_PITCH).toBeLessThan(Math.PI / 2);
  });

  it("points the camera where the azimuth says it does", () => {
    const dom = stubDom();
    const cam = firstPerson(dom, 0.7);
    cam.follow(12, 6);
    cam.snap();
    drag(dom, 40, -20);
    cam.update(0);
    cam.camera.updateMatrixWorld(true);
    const dir = cam.camera.getWorldDirection(new Vector3());
    expect(Math.atan2(-dir.x, -dir.z)).toBeCloseTo(cam.azimuth, 6);
    expect(Math.asin(dir.y)).toBeCloseTo(cam.pitch, 6);
  });

  it("binds no wheel — there is no orbit radius to zoom — and unbinds on dispose", () => {
    const dom = stubDom();
    const cam = firstPerson(dom);
    expect(dom.types()).not.toContain("wheel");
    expect(dom.types().length).toBeGreaterThan(0);
    cam.dispose();
    expect(dom.types()).toEqual([]);
  });

  it("leaves the orbital camera's own bindings clean too", () => {
    const dom = stubDom();
    new OrbitCam(asDom(dom)).dispose();
    expect(dom.types()).toEqual([]);
  });
});

describe("glyph facing", () => {
  /** Both cameras are drawn through the same renderer seam. */
  it("satisfies one camera interface", () => {
    const cams: DungeonCamera[] = [
      new OrbitCam(asDom(stubDom())),
      firstPerson(),
    ];
    for (const cam of cams) {
      cam.follow(10, 10);
      cam.snap();
      cam.update(0);
      cam.resize(800, 600);
      expect(typeof cam.facingAt(11, 10)).toBe("number");
      cam.dispose();
    }
  });

  it("turns every glyph toward the eye", () => {
    const cam = firstPerson();
    cam.follow(10, 10);
    cam.snap();
    cam.update(0);
    // A glyph east of the eye faces west, and so on around the compass. Yaw is
    // measured the way place() applies it: 0 leaves the letter facing +z.
    expect(cam.facingAt(13, 10)).toBeCloseTo(-Math.PI / 2, 6);
    expect(cam.facingAt(7, 10)).toBeCloseTo(Math.PI / 2, 6);
    expect(cam.facingAt(10, 7)).toBeCloseTo(0, 6);
    expect(Math.abs(cam.facingAt(10, 13))).toBeCloseTo(Math.PI, 6);
    expect(cam.facingAt(13, 13)).toBeCloseTo(-Math.PI * 3 / 4, 6);
  });

  it("gives the orbital camera's scalar bearing for every cell", () => {
    const cam = new OrbitCam(asDom(stubDom()));
    cam.azimuth = 0.35;
    cam.follow(12, 6);
    cam.snap();
    cam.update(0);
    for (const [x, y] of [[0, 0], [12, 6], [79, 20]] as const)
      expect(cam.facingAt(x, y)).toBe(cam.azimuth);
  });

  it("agrees with a per-glyph look-at at the cell the orbital camera follows", () => {
    const cam = new OrbitCam(asDom(stubDom()));
    cam.azimuth = 0.35;
    cam.follow(12, 6);
    cam.snap();
    cam.update(0);
    const p = cam.camera.position;
    expect(Math.atan2(p.x - 12, p.z - 6)).toBeCloseTo(cam.azimuth, 9);
  });
});

describe("entity facing provider", () => {
  const twoGlyphs = () => {
    const map = blank();
    put(map, 20, 10, { glyph: MONSTER, ch: "d", color: CLR.YELLOW, glyphflags: 0 });
    put(map, 60, 10, { glyph: MONSTER, ch: "d", color: CLR.YELLOW, glyphflags: 0 });
    return map;
  };
  const build = (facing: number | ((x: number, y: number) => number)) => {
    const segs: Seg[] = [];
    buildEntities(twoGlyphs(), recorder(segs), TIME, facing);
    return segs;
  };

  it("resolves the bearing per cell, and a scalar still means every cell", () => {
    const cam = firstPerson();
    cam.follow(40, 10);
    cam.snap();
    cam.update(0);
    const provided = build((x, y) => cam.facingAt(x, y));
    const near = build(cam.facingAt(20, 10));
    const far = build(cam.facingAt(60, 10));

    // The two glyphs lie either side of the eye, so they turn opposite ways...
    expect(cam.facingAt(20, 10)).not.toBeCloseTo(cam.facingAt(60, 10), 3);
    expect(atCell(provided, 20, 10)).toEqual(atCell(near, 20, 10));
    expect(atCell(provided, 60, 10)).toEqual(atCell(far, 60, 10));
    // ...which one scalar bearing cannot do for both at once.
    expect(atCell(provided, 60, 10)).not.toEqual(atCell(near, 60, 10));
  });

  it("keeps the sway riding on top of whichever facing was resolved", () => {
    const cam = firstPerson();
    cam.follow(40, 10);
    cam.snap();
    cam.update(0);
    const still = build((x, y) => cam.facingAt(x, y));
    const later: Seg[] = [];
    buildEntities(twoGlyphs(), recorder(later), TIME + 0.9, (x, y) => cam.facingAt(x, y));
    expect(atCell(later, 20, 10)).not.toEqual(atCell(still, 20, 10));
  });
});

describe("hidden hero", () => {
  const scene = (hideHero: boolean) => {
    const map = blank();
    put(map, 10, 10, { glyph: MONSTER, ch: "@", color: CLR.WHITE, glyphflags: MG.HERO });
    // Two cells clear of the hero: a floor ring is wide enough that a
    // neighbouring one lands inside atCell()'s window.
    put(map, 10, 12, { glyph: PET, ch: "f", color: CLR.WHITE, glyphflags: MG.PET });
    put(map, 14, 10, { glyph: MONSTER, ch: "d", color: CLR.YELLOW, glyphflags: 0 });
    const segs: Seg[] = [];
    buildEntities(map, recorder(segs), TIME, 0.35, undefined, { hideHero });
    return segs;
  };
  const inked = (segs: readonly Seg[], ink: { r: number; g: number; b: number }) =>
    segs.filter((s) => s.r === ink.r && s.g === ink.g && s.b === ink.b);

  it("drops the hero letterform and ring when the camera is standing in them", () => {
    const shown = scene(false), hidden = scene(true);
    expect(atCell(shown, 10, 10).length).toBeGreaterThan(0);
    expect(inked(shown, INK.heroRing).length).toBeGreaterThan(0);
    expect(atCell(hidden, 10, 10)).toEqual([]);
    expect(inked(hidden, INK.heroRing)).toEqual([]);
  });

  it("leaves the pet's ring and every other glyph alone", () => {
    const shown = scene(false), hidden = scene(true);
    expect(inked(hidden, INK.pet).length).toEqual(inked(shown, INK.pet).length);
    expect(atCell(hidden, 10, 12)).toEqual(atCell(shown, 10, 12));
    expect(atCell(hidden, 14, 10)).toEqual(atCell(shown, 14, 10));
  });
});

describe("per-mode stroke width", () => {
  const widths = (batch: LineBatch) =>
    batch.object.children.map((m) => (m as unknown as { material: { linewidth: number } }).material.linewidth);

  it("scales every bloom layer from its constructed base, idempotently", () => {
    const batch = new LineBatch(8, { width: 2 });
    const base = beamLayers(TOKENS.glow.beam_layers).map((l) => 2 * l.widthMul);
    expect(widths(batch)).toEqual(base);

    batch.setWidthScale(1.3);
    expect(widths(batch)).toEqual(base.map((w) => w * 1.3));
    // Relative to the base, not to the last call: two scales do not compound.
    batch.setWidthScale(1.3);
    expect(widths(batch)).toEqual(base.map((w) => w * 1.3));
    batch.setWidthScale(1);
    expect(widths(batch)).toEqual(base);
    batch.dispose();
  });
});

describe("keyboard turning", () => {
  it("steps one eighth-turn per press, left for positive", () => {
    const cam = firstPerson();
    expect(cam.heading).toBeCloseTo(0, 9);
    cam.turnBy(TURN_STEP);
    expect(cam.heading).toBeCloseTo(TURN_STEP, 9);
    cam.turnBy(-TURN_STEP);
    cam.turnBy(-TURN_STEP);
    expect(cam.heading).toBeCloseTo(-TURN_STEP, 9);
  });

  it("snaps a free-look drag onto the lattice before stepping", () => {
    const dom = stubDom();
    const cam = firstPerson(dom, 0);
    drag(dom, 37, 0); // some odd angle
    expect(cam.heading % TURN_STEP).not.toBeCloseTo(0, 6);
    cam.turnBy(TURN_STEP);
    // Snapped to the nearest eighth, then stepped: still on the lattice.
    expect(cam.heading / TURN_STEP).toBeCloseTo(Math.round(cam.heading / TURN_STEP), 9);
  });

  it("eases the view to the new heading instead of cutting", () => {
    const cam = firstPerson();
    cam.turnBy(TURN_STEP);
    expect(cam.azimuth).toBeCloseTo(0, 9);   // nothing has moved yet
    cam.update(1 / 60);
    expect(cam.azimuth).toBeGreaterThan(0);           // started
    expect(cam.azimuth).toBeLessThan(TURN_STEP);      // but has not arrived
    for (let i = 0; i < 200; i++) cam.update(1 / 60);
    expect(cam.azimuth).toBeCloseTo(TURN_STEP, 6);    // settles, no overshoot
  });

  it("leads the eased view, so a fast second press is not misread", () => {
    // Press right, then forward before the swing finishes: the direction the
    // player asked for is the target, not the angle the camera is passing.
    const cam = firstPerson();
    cam.turnBy(-TURN_STEP);
    cam.update(1 / 240);
    expect(cam.heading).toBeCloseTo(-TURN_STEP, 9);
    expect(cam.azimuth).not.toBeCloseTo(-TURN_STEP, 3);
  });

  it("tracks a drag immediately, with no ease", () => {
    const dom = stubDom();
    const cam = firstPerson(dom, 0);
    drag(dom, -50, 0);
    expect(cam.azimuth).toBeCloseTo(cam.heading, 9); // the drag is 1:1, not chased
  });
});

describe("facing reset", () => {
  it("orbital: commits north-up immediately and eases the view there", () => {
    const cam = new OrbitCam(asDom(stubDom()));
    cam.azimuth = 3 * TURN_STEP;
    cam.resetFacing();
    expect(cam.heading).toBeCloseTo(0, 9);             // keys are classic at once
    expect(cam.azimuth).toBeCloseTo(3 * TURN_STEP, 9); // the view has not cut
    cam.update(1 / 60);
    expect(cam.azimuth).toBeLessThan(3 * TURN_STEP);   // started swinging
    for (let i = 0; i < 400; i++) cam.update(1 / 60);
    expect(cam.azimuth).toBeCloseTo(0, 6);             // settles at north-up
  });

  it("orbital: takes the short way from an accumulated bearing", () => {
    const cam = new OrbitCam(asDom(stubDom()));
    cam.azimuth = 6 * Math.PI + 0.3; // three full turns and a bit
    cam.resetFacing();
    expect(cam.heading).toBeCloseTo(6 * Math.PI, 9); // the nearest north, not 0
  });

  it("orbital: a drag mid-swing takes over 1:1", () => {
    const dom = stubDom();
    const cam = new OrbitCam(asDom(dom));
    cam.azimuth = Math.PI;
    cam.resetFacing();
    cam.update(1 / 60);
    drag(dom, 10, 0);
    expect(cam.heading).toBeCloseTo(cam.azimuth, 9); // no longer chasing north
  });

  it("orbital: assigning azimuth still means both view and target (setMode handoff)", () => {
    const cam = new OrbitCam(asDom(stubDom()));
    cam.azimuth = 0.35; // DungeonRenderer.makeCam does exactly this
    cam.update(1);      // a whole second: any chase toward a stale target would show
    expect(cam.azimuth).toBeCloseTo(0.35, 9);
    expect(cam.heading).toBeCloseTo(0.35, 9);
  });

  it("first person: faces north the short way round, through the turn ease", () => {
    const cam = firstPerson(stubDom(), -4 * Math.PI + TURN_STEP);
    cam.resetFacing();
    expect(cam.heading).toBeCloseTo(-4 * Math.PI, 9); // the nearest north
    for (let i = 0; i < 400; i++) cam.update(1 / 60);
    expect(cam.azimuth).toBeCloseTo(-4 * Math.PI, 6);
  });
});

describe("camera swap", () => {
  // The renderer observes its canvas and reads the device pixel ratio; node has
  // neither. Nothing here reaches a GPU — that is all behind start(), which is
  // also why the renderer is left undisposed: dispose() stops the animation
  // loop, and three brings a backend up to do it.
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  g.devicePixelRatio ??= 1;
  const stubCanvas = () => Object.assign(stubDom(), { clientWidth: 800, clientHeight: 600 });

  it("keeps the orbit framing across an F2 round trip", () => {
    const dom = stubCanvas();
    const renderer = new DungeonRenderer(dom as unknown as HTMLCanvasElement, blank());
    // The live camera: the renderer publishes a bearing but no framing, and a
    // rename here fails this test rather than quietly passing it.
    const orbit = () => (renderer as unknown as { cam: OrbitCam }).cam;
    const opened = { elevation: orbit().elevation, radius: orbit().radius };

    // Zoom out and tilt: the framing the player set, not the one they were given.
    dom.fire("wheel", { deltaY: 400 });
    drag(dom, 100, 60);
    const framed = { elevation: orbit().elevation, radius: orbit().radius };
    const bearing = renderer.heading;
    expect(framed.radius).toBeGreaterThan(opened.radius);
    expect(framed.elevation).toBeGreaterThan(opened.elevation);
    expect(bearing).not.toBeCloseTo(0, 3);

    expect(renderer.toggleMode()).toBe("first");
    expect(renderer.toggleMode()).toBe("orbital");
    expect(orbit().radius).toBeCloseTo(framed.radius, 9);
    expect(orbit().elevation).toBeCloseTo(framed.elevation, 9);
    expect(renderer.heading).toBeCloseTo(bearing, 9);
  });
});
