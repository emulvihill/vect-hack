// The degrade policy's own unit: WHICH view chooseView() builds, and — since
// vect-hack-po4 — which one it never even fetches.
//
// The second half is the whole bead. A browser with no GPU is shown a character
// grid, and it used to download three/webgpu and src/render (810 kB of chunk)
// to draw it, because main.ts had to resolve both `import()`s before it could
// call this function at all. The views arrive as loaders now, and the assertion
// that matters is a negative one: on every tty arm the vector loader is never
// called. A test that only checked the returned view would pass just as happily
// on the old code.
//
// The byte-level proof is `npm run check:payload`'s no-GPU arm, which denies
// both graphics APIs at the Chromium switch and fails if the page fetched the
// three.js chunk; the playable-surface proof is `npm run check:browser`'s
// nethack-nogpu arm. This is the half that runs in `npm test`.
import { beforeEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ gpu: true, gpuArgs: [] as unknown[] }));
vi.mock("../../src/ui/gpuSupport", () => ({
  GPU_UNAVAILABLE_NOTICE: "no gpu",
  browserGpuProbe: () => ({}),
  gpuAvailable: async (...args: unknown[]) => (seam.gpuArgs = args, seam.gpu),
}));

import { chooseView } from "../../src/ui/chooseView";

class Canvas {
  removed = false;
  remove() { this.removed = true; }
}

class Tty {
  notices: string[] = [];
  onNotice(text: string) { this.notices.push(text); }
}

class Vector {
  constructor(readonly canvas: unknown, readonly opts: { forceWebGL: boolean }) {}
}

let canvas: Canvas;

beforeEach(() => {
  canvas = new Canvas();
  seam.gpu = true;
  seam.gpuArgs = [];
  (globalThis as any).document = { getElementById: (id: string) => (id === "view" ? canvas : null) };
});

/** The two loaders, each a spy, so "was this module fetched" is a question the
 *  test can ask. A real page's loaders are `await import(...)` expressions. */
function loaders() {
  const vector = vi.fn(async () => Vector);
  const tty = vi.fn(async () => Tty);
  return { vector, tty };
}

function at(search: string) {
  (globalThis as any).location = { search };
}

it("builds the vector view on a GPU, and never fetches the tty one", async () => {
  at("?game=nethack");
  const load = loaders();
  const chosen = await chooseView(load);

  expect(chosen.kind).toBe("vector");
  expect(chosen.view).toBeInstanceOf(Vector);
  expect(canvas.removed).toBe(false);
  expect(load.vector).toHaveBeenCalledOnce();
  expect(load.tty).not.toHaveBeenCalled();
});

it("never fetches the vector view for a browser with no GPU (vect-hack-po4)", async () => {
  seam.gpu = false;
  at("?game=nethack");
  const load = loaders();
  const chosen = await chooseView(load);

  // The point of the bead: the renderer's chunk is what this page must not pay
  // for. Not "the tty view was returned" — the old code returned it too.
  expect(load.vector).not.toHaveBeenCalled();
  expect(load.tty).toHaveBeenCalledOnce();
  expect(chosen.kind).toBe("tty");
  expect(canvas.removed).toBe(true);
  expect((chosen.view as Tty).notices).toEqual(["no gpu"]);
});

it("never fetches the vector view for ?view=debug either", async () => {
  at("?game=nethack&view=debug");
  const load = loaders();
  const chosen = await chooseView(load);

  // A debug page draws a character grid for the same reason and pays the same
  // 810 kB if this is wrong. It gets no notice: nothing degraded, it was asked
  // for. The GPU is not even probed — the flag settles it.
  expect(load.vector).not.toHaveBeenCalled();
  expect(chosen.kind).toBe("tty");
  expect((chosen.view as Tty).notices).toEqual([]);
  expect(canvas.removed).toBe(true);
  expect(seam.gpuArgs).toEqual([]);
});

it("pins the WebGL backend for ?gl, in the probe and in the view it builds", async () => {
  at("?game=nethack&gl");
  const chosen = await chooseView(loaders());

  expect(seam.gpuArgs[1]).toEqual({ forceWebGL: true });
  expect((chosen.view as Vector).opts).toEqual({ forceWebGL: true });
  expect((chosen.view as Vector).canvas).toBe(canvas);
});

it("takes the tty arm when ?gl finds no WebGL, and still fetches no renderer", async () => {
  // ?gl forces the backend; it does not promise there is one. gpuAvailable()
  // answers false and this is an ordinary no-GPU page.
  seam.gpu = false;
  at("?game=nethack&gl");
  const load = loaders();
  const chosen = await chooseView(load);

  expect(chosen.kind).toBe("tty");
  expect(load.vector).not.toHaveBeenCalled();
});
