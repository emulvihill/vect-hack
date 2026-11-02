// Pinch zoom and the opening framing (vect-hack-lxd). Two halves of one
// complaint: a touchscreen cannot produce a wheel event, so a phone player
// could orbit and never zoom — and at a portrait aspect the fixed orbit radius
// showed about seven of the map's eighty columns, which is a hero you can
// drive and a level you cannot see.
//
// Everything here is arithmetic over a DOM stub that records what the camera
// binds and fires it back, so a two-finger gesture can be driven headlessly.
// The browser half — a real pinch, through real touch events — is
// scripts/dev/touch-check.mjs.
import { describe, expect, it } from "vitest";
import { DungeonRenderer } from "../../src/render/DungeonRenderer";
import { FirstPersonCam } from "../../src/render/FirstPersonCam";
import { OrbitCam, framedRadius } from "../../src/render/OrbitCam";
import { CellGrid } from "../../src/backplane/cell";

/** An element that records what was bound to it and can fire it back. */
function stubDom() {
  const bound = new Map<string, Set<(e: unknown) => void>>();
  return {
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
const orbit = (dom: StubDom) => new OrbitCam(asDom(dom));

/** One finger: down, move, up — the desktop mouse drag as well. */
function drag(dom: StubDom, dx: number, dy: number, id = 1): void {
  dom.fire("pointerdown", { clientX: 0, clientY: 0, pointerId: id });
  dom.fire("pointermove", { clientX: dx, clientY: dy, pointerId: id });
  dom.fire("pointerup", { clientX: dx, clientY: dy, pointerId: id });
}

/** Two fingers on one horizontal line, `span` pixels apart, centred on 200. */
function fingers(dom: StubDom, type: string, span: number): void {
  dom.fire(type, { clientX: 200 - span / 2, clientY: 300, pointerId: 1 });
  dom.fire(type, { clientX: 200 + span / 2, clientY: 300, pointerId: 2 });
}

/** Put two fingers down `from` apart and take them to `to` apart. */
function pinch(dom: StubDom, from: number, to: number): void {
  fingers(dom, "pointerdown", from);
  fingers(dom, "pointermove", to);
  fingers(dom, "pointerup", to);
}

/**
 * The map width the camera actually frames, in cells, read off the projection
 * three built rather than re-derived from the field of view here: element 0 of
 * a perspective matrix is 1 / (aspect * tan(fovY / 2)), and the target sits at
 * `radius` along the view axis.
 */
function framedWidth(cam: OrbitCam): number {
  return (2 * cam.radius) / cam.camera.projectionMatrix.elements[0]!;
}

/** A desktop stage: a 1280x800 window, less the message and status strips. */
const DESKTOP = { w: 1280, h: 670 };
/** A phone in portrait: the 390x844 the whole touch scheme is measured at,
 *  less the same strips (check:touch reports the stage at 718px). */
const PHONE = { w: 390, h: 718 };

describe("pinch to zoom", () => {
  it("spreads to zoom in and closes to zoom out", () => {
    const wide = stubDom(), narrow = stubDom();
    const a = orbit(wide), b = orbit(narrow);
    const opened = a.radius;
    pinch(wide, 100, 200);   // fingers apart: more magnification, closer camera
    pinch(narrow, 200, 100); // fingers together: pull back
    expect(a.radius).toBeLessThan(opened);
    expect(b.radius).toBeGreaterThan(opened);
    a.dispose();
    b.dispose();
  });

  it("moves the radius by the ratio of the finger separation", () => {
    const dom = stubDom();
    const cam = orbit(dom);
    const opened = cam.radius;
    pinch(dom, 120, 240);
    expect(cam.radius).toBeCloseTo(opened / 2, 9);
    cam.dispose();
  });

  it("clamps at the ends of the zoom range", () => {
    const inward = stubDom(), outward = stubDom();
    const a = orbit(inward), b = orbit(outward);
    pinch(inward, 1, 100000);
    pinch(outward, 100000, 1);
    expect(a.radius).toBeGreaterThan(0);
    expect(a.radius).toBeLessThan(b.radius);
    // Two more of the same must not move them: they are already at the stops.
    const stops = { in: a.radius, out: b.radius };
    pinch(inward, 1, 100000);
    pinch(outward, 100000, 1);
    expect(a.radius).toBeCloseTo(stops.in, 9);
    expect(b.radius).toBeCloseTo(stops.out, 9);
    a.dispose();
    b.dispose();
  });

  it("leaves the desktop alone: one pointer drags and never zooms", () => {
    const dom = stubDom();
    const cam = orbit(dom);
    const opened = cam.radius;
    drag(dom, 100, 60);
    expect(cam.radius).toBeCloseTo(opened, 9);
    expect(cam.azimuth).not.toBeCloseTo(0, 6);
    // And the wheel still zooms, in the direction it always did.
    dom.fire("wheel", { deltaY: 400 });
    expect(cam.radius).toBeGreaterThan(opened);
    dom.fire("wheel", { deltaY: -400 });
    expect(cam.radius).toBeCloseTo(opened, 9);
    cam.dispose();
  });

  it("stands the orbit down the moment a second finger lands", () => {
    const dom = stubDom();
    const cam = orbit(dom);
    const opened = cam.radius;
    dom.fire("pointerdown", { clientX: 100, clientY: 300, pointerId: 1 });
    dom.fire("pointermove", { clientX: 130, clientY: 300, pointerId: 1 });
    const swung = { az: cam.azimuth, el: cam.elevation };
    expect(swung.az).not.toBeCloseTo(0, 6); // the drag was live

    dom.fire("pointerdown", { clientX: 300, clientY: 300, pointerId: 2 });
    // Now the SAME finger keeps moving. Under a drag that never stood down
    // this would keep swinging the bearing through the whole pinch.
    dom.fire("pointermove", { clientX: 60, clientY: 380, pointerId: 1 });
    expect(cam.azimuth).toBeCloseTo(swung.az, 9);
    expect(cam.elevation).toBeCloseTo(swung.el, 9);
    expect(cam.radius).toBeLessThan(opened); // it zoomed instead: the span grew
    cam.dispose();
  });

  it("hands the drag back to the finger that is left, from where it is", () => {
    const pinched = stubDom(), plain = stubDom();
    const a = orbit(pinched), b = orbit(plain);
    fingers(pinched, "pointerdown", 200); // fingers at x=100 and x=300
    // Finger 1 travels DURING the pinch. That is what makes this test able to
    // fail: with both fingers still where they started, the stale drag anchor
    // and the survivor's position are the same number, and a handover that
    // never re-anchored would look correct.
    pinched.fire("pointermove", { clientX: 60, clientY: 300, pointerId: 1 });
    pinched.fire("pointerup", { clientX: 300, clientY: 300, pointerId: 2 });

    // The survivor is at x=60, and the drag anchor must be there too. A 40px
    // drag from there turns the view by exactly what a plain 40px drag turns
    // it — not by the 40px back to where the finger first landed.
    const az = a.azimuth;
    pinched.fire("pointermove", { clientX: 100, clientY: 300, pointerId: 1 });
    drag(plain, 40, 0);
    expect(a.azimuth - az).toBeCloseTo(b.azimuth, 9);
    expect(a.azimuth - az).not.toBeCloseTo(0, 9);
    a.dispose();
    b.dispose();
  });

  it("treats a cancelled finger as a finger that is gone", () => {
    const dom = stubDom();
    const cam = orbit(dom);
    fingers(dom, "pointerdown", 200);
    dom.fire("pointercancel", { clientX: 300, clientY: 300, pointerId: 2 });
    const radius = cam.radius, az = cam.azimuth;
    // The survivor drags; nothing zooms, because there is no second finger to
    // measure a span against.
    dom.fire("pointermove", { clientX: 140, clientY: 300, pointerId: 1 });
    expect(cam.radius).toBeCloseTo(radius, 9);
    expect(cam.azimuth).not.toBeCloseTo(az, 6);
    // And both fingers cancelled leaves nothing dragging.
    dom.fire("pointercancel", { clientX: 140, clientY: 300, pointerId: 1 });
    const settled = cam.azimuth;
    dom.fire("pointermove", { clientX: 400, clientY: 300, pointerId: 1 });
    expect(cam.azimuth).toBeCloseTo(settled, 9);
    cam.dispose();
  });

  it("first person has no pinch, because it has no radius to zoom", () => {
    const dom = stubDom();
    const cam = new FirstPersonCam(asDom(dom));
    dom.fire("pointerdown", { clientX: 100, clientY: 300, pointerId: 1 });
    dom.fire("pointerdown", { clientX: 300, clientY: 300, pointerId: 2 });
    const yaw = cam.yaw, pitch = cam.pitch;
    // A second finger drives nothing: the look follows the first pointer only,
    // so a pinch gesture over this camera cannot smear the view around.
    dom.fire("pointermove", { clientX: 500, clientY: 500, pointerId: 2 });
    expect(cam.yaw).toBeCloseTo(yaw, 9);
    expect(cam.pitch).toBeCloseTo(pitch, 9);
    // The first one still looks.
    dom.fire("pointermove", { clientX: 140, clientY: 300, pointerId: 1 });
    expect(cam.yaw).not.toBeCloseTo(yaw, 6);
    cam.dispose();
  });
});

describe("opening framing", () => {
  it("opens a wide viewport exactly where it always did", () => {
    const dom = stubDom();
    const cam = orbit(dom);
    const opened = cam.radius;
    cam.resize(DESKTOP.w, DESKTOP.h);
    expect(cam.radius).toBeCloseTo(opened, 9);
    // Every landscape shape past the reference is the same historical radius:
    // the rule only ever pulls a NARROW viewport back.
    for (const [w, h] of [[1920, 940], [1280, 670], [1600, 1000]] as const) {
      cam.resize(w, h);
      expect(cam.radius).toBeCloseTo(opened, 9);
    }
    cam.dispose();
  });

  it("pulls a portrait viewport back until the same width of map fits", () => {
    const phone = orbit(stubDom()), desk = orbit(stubDom());
    phone.resize(PHONE.w, PHONE.h);
    desk.resize(DESKTOP.w, DESKTOP.h);
    expect(phone.radius).toBeGreaterThan(desk.radius);

    // The invariant: at the reference shape and below, the view frames the
    // same map width. A wide desktop sees more than that, never less.
    const reference = orbit(stubDom());
    reference.resize(1600, 1000); // exactly 1.6:1
    expect(framedWidth(phone)).toBeCloseTo(framedWidth(reference), 6);
    expect(framedWidth(desk)).toBeGreaterThan(framedWidth(reference));

    // And what that is worth in cells, which is the point of the exercise:
    // the phone was framing about seven columns before this.
    expect(framedWidth(phone)).toBeGreaterThan(18);
    phone.dispose();
    desk.dispose();
    reference.dispose();
  });

  it("reframes while the framing is the viewport's, and stops once it is the player's", () => {
    const dom = stubDom();
    const cam = orbit(dom);
    cam.resize(PHONE.w, PHONE.h);
    const portrait = cam.radius;
    cam.resize(PHONE.h, PHONE.w); // the phone turned landscape
    expect(cam.radius).toBeLessThan(portrait);
    cam.resize(PHONE.w, PHONE.h);
    expect(cam.radius).toBeCloseTo(portrait, 9);

    // A pinch makes it the player's, and no later resize may take it back.
    pinch(dom, 200, 100);
    const chosen = cam.radius;
    expect(chosen).not.toBeCloseTo(portrait, 6);
    cam.resize(PHONE.h, PHONE.w);
    cam.resize(DESKTOP.w, DESKTOP.h);
    expect(cam.radius).toBeCloseTo(chosen, 9);
    cam.dispose();
  });

  it("never frames outside the zoom range a pinch can reach", () => {
    // The stops a pinch settles on, read off the camera rather than restated
    // as constants: an opening framing outside them would be a shot the player
    // cannot get back to.
    const inward = stubDom(), outward = stubDom();
    const near = orbit(inward), far = orbit(outward);
    pinch(inward, 1, 100000);
    pinch(outward, 100000, 1);
    for (const [w, h] of [[100, 4000], [4000, 100], [1, 1], [390, 718]] as const) {
      const cam = orbit(stubDom());
      cam.resize(w, h);
      expect(cam.radius).toBeGreaterThanOrEqual(near.radius);
      expect(cam.radius).toBeLessThanOrEqual(far.radius);
      cam.dispose();
    }
    near.dispose();
    far.dispose();
  });

  it("is the same function the renderer's resize path uses", () => {
    // framedRadius is exported so the rule can be stated once. Two shapes
    // either side of the reference, against a live camera.
    const cam = orbit(stubDom());
    cam.resize(PHONE.w, PHONE.h);
    expect(cam.radius).toBeCloseTo(framedRadius(PHONE.w / PHONE.h), 9);
    cam.resize(DESKTOP.w, DESKTOP.h);
    expect(cam.radius).toBeCloseTo(framedRadius(DESKTOP.w / DESKTOP.h), 9);
    cam.dispose();
  });
});

describe("framing across a camera swap", () => {
  // Same stubbing as the camera-swap block in first-person.test.ts: nothing
  // here reaches a GPU, which is all behind start().
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  g.devicePixelRatio ??= 1;
  const stubCanvas = (w: number, h: number) =>
    Object.assign(stubDom(), { clientWidth: w, clientHeight: h });
  const live = (r: DungeonRenderer) => (r as unknown as { cam: OrbitCam }).cam;

  it("keeps a viewport framing the viewport's to revise", () => {
    const dom = stubCanvas(PHONE.w, PHONE.h);
    const renderer = new DungeonRenderer(dom as unknown as HTMLCanvasElement, new CellGrid(80, 21));
    renderer.toggleMode();          // to first person and back: a fresh OrbitCam
    expect(renderer.toggleMode()).toBe("orbital");
    const portrait = live(renderer).radius;
    expect(portrait).toBeCloseTo(framedRadius(PHONE.w / PHONE.h), 9);

    // The phone turned landscape after the round trip. Nobody chose that
    // radius, so the viewport is still allowed to.
    live(renderer).resize(PHONE.h, PHONE.w);
    expect(live(renderer).radius).toBeLessThan(portrait);
  });

  it("keeps a pinched framing the player's across the round trip", () => {
    const dom = stubCanvas(PHONE.w, PHONE.h);
    const renderer = new DungeonRenderer(dom as unknown as HTMLCanvasElement, new CellGrid(80, 21));
    pinch(dom, 200, 100);
    const chosen = live(renderer).radius;
    renderer.toggleMode();
    expect(renderer.toggleMode()).toBe("orbital");
    expect(live(renderer).radius).toBeCloseTo(chosen, 9);
    // setMode resized the replacement; a player's zoom survived it.
    live(renderer).resize(DESKTOP.w, DESKTOP.h);
    expect(live(renderer).radius).toBeCloseTo(chosen, 9);
  });
});
