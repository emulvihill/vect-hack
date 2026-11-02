// vect-hack-po4, composed: a browser with no GPU must not fetch the vector
// view's module, and therefore not three/webgpu or src/render behind it.
//
// choose-view.test.ts pins the same rule on the policy in isolation, with two
// spy loaders. This file pins it on the real thing main.ts hands that policy —
// an `await import()` of a Module's VectorView — which is the half a refactor
// could break while chooseView's own test stayed green.
//
// It is its own file rather than another case in nethack-main.test.ts because
// the evidence is a mock FACTORY that must never run, and a factory runs once
// per file: one boot here, with the GPU denied, and a counter that has to stay
// at zero. Sharing a file with a boot that legitimately builds the vector view
// would make the assertion unfalsifiable.
import { expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  tty: { onNotice: vi.fn() },
  /** Bumped when the vector view's module is evaluated — never, here. */
  vectorModule: vi.fn(),
  handler: null as object | null,
}));
vi.mock("../../src/modules/nethack/ui/DebugView", () => ({
  DebugView: class { constructor() { return seam.tty; } },
}));
vi.mock("../../src/modules/nethack/ui/VectorView", () => (seam.vectorModule(), {
  VectorView: class {},
}));
vi.mock("../../src/modules/nethack/session", () => ({
  NetHackSession: class {
    exportSave = vi.fn();
    describe = vi.fn();
    constructor(handler: object) { seam.handler = handler; }
  },
}));
vi.mock("../../src/ui/saveMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/ui/saveMenu")>(),
  installSaveMenu: vi.fn(),
}));
// The denial itself: this page's browser hands back neither backend. Mocked at
// gpuSupport rather than at chooseView, so the decision under test is the real
// one (the browser gate denies it at the Chromium switch instead).
vi.mock("../../src/ui/gpuSupport", () => ({
  GPU_UNAVAILABLE_NOTICE: "no gpu", browserGpuProbe: () => ({}), gpuAvailable: async () => false,
}));
vi.mock("../../src/skins", () => ({ applySkinCss() {} }));

class El { removed = false; remove() { this.removed = true; } }

it("boots NetHack's text view without ever loading the vector view's module", async () => {
  const els = new Map([["view", new El()], ["cmdbtn", new El()]]);
  (globalThis as any).window = {};
  (globalThis as any).location = { search: "?game=nethack", replace: vi.fn(), pathname: "/play", hash: "" };
  (globalThis as any).document = { getElementById: (id: string) => els.get(id) ?? null };
  await (await import("../../src/main")).booted;

  // The page is playable: the text view is built, wired to the session, and
  // says why the canvas is gone.
  expect((window as any).__nhView).toBe(seam.tty);
  expect(seam.handler).toBe(seam.tty);
  expect(els.get("view")!.removed).toBe(true);
  expect(seam.tty.onNotice).toHaveBeenCalledWith("no gpu");

  // And it cost nothing to draw a character grid. Before vect-hack-po4 this
  // counter was 1: main.ts resolved both views before it could ask the policy
  // anything, so the renderer's 810 kB chunk crossed the wire on a page that
  // never built a canvas.
  expect(seam.vectorModule).not.toHaveBeenCalled();
});
