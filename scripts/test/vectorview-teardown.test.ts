// The vector views' half of vect-hack-a8r. TtyView is what the bead named,
// but a debug view is not what anyone plays: the product view binds the same
// document keydown, owns the same KeyQueue, AND builds three parts that each
// put something on a node they do not own — the renderer's camera and the
// Look HUD on the canvas, the radar's ResizeObserver on the stage. A dispose
// that unbinds the view's own listener and forgets those three is the same
// leak one layer down, so each part's dispose is asserted here by name.
//
// The renderer, radar and Look HUD are mocked: this file is about who calls
// whose dispose, and a real DungeonRenderer needs a GPU.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: never) => void;

const seam = vi.hoisted(() => ({
  rendererDisposals: 0,
  radarDisposals: 0,
  lookDisposals: 0,
}));

class FakeRenderer {
  map: import("../../src/backplane/cell").CellGrid;
  onFrame: ((heading: number) => void) | null = null;
  backend = "webgpu";
  mode: "orbital" | "first" = "orbital";
  heading = 0;
  start = vi.fn(async () => {});
  stop = vi.fn();
  syncHero = vi.fn();
  recentre = vi.fn();
  hitFlash = vi.fn();
  toggleMode = vi.fn(() => this.mode);
  turn = vi.fn();
  resetFacing = vi.fn();
  pickCell = vi.fn(() => ({ x: 1, y: 1 }));
  setHighlight = vi.fn();
  dispose = vi.fn(() => { seam.rendererDisposals++; });
  constructor(_canvas: unknown, map: import("../../src/backplane/cell").CellGrid) { this.map = map; }
}

class FakeRadar {
  draw = vi.fn();
  invalidate = vi.fn();
  dispose = vi.fn(() => { seam.radarDisposals++; });
  constructor(_parent: unknown) {}
}

class FakeLook {
  describe: ((x: number, y: number) => Promise<string | null>) | null = null;
  clear = vi.fn();
  dispose = vi.fn(() => { seam.lookDisposals++; });
  constructor(_canvas: unknown, _parent: unknown, _renderer: unknown) {}
}

vi.mock("../../src/render/DungeonRenderer", () => ({ DungeonRenderer: FakeRenderer }));
vi.mock("../../src/ui/hud/Radar", () => ({ Radar: FakeRadar }));
vi.mock("../../src/ui/hud/Look", () => ({ LookHud: FakeLook }));

class StubEl {
  id = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  style = { visibility: "" };
  parentElement: StubEl | null = null;
  children: StubEl[] = [];
  classList = { add: vi.fn(), remove: vi.fn() };
  listeners = new Map<string, Set<Listener>>();
  appendChild(c: StubEl) { c.parentElement = this; this.children.push(c); return c; }
  remove() {}
  get childElementCount() { return this.children.length; }
  get firstChild(): StubEl | null { return this.children[0] ?? null; }
  addEventListener(t: string, fn: Listener) {
    const set = this.listeners.get(t) ?? new Set<Listener>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn); }
}

const els = new Map<string, StubEl>();
const docListeners = new Map<string, Set<Listener>>();
const documentStub = {
  getElementById: (id: string) => els.get(id) ?? null,
  createElement: () => new StubEl(),
  addEventListener(t: string, fn: Listener) {
    const set = docListeners.get(t) ?? new Set<Listener>();
    docListeners.set(t, set).get(t)!.add(fn);
  },
  removeEventListener(t: string, fn: Listener) { docListeners.get(t)?.delete(fn); },
};

const bound = () => docListeners.get("keydown")?.size ?? 0;
const press = (key: string, extra: Record<string, unknown> = {}) => {
  const e = { key, preventDefault() {}, ...extra } as never;
  for (const fn of [...(docListeners.get("keydown") ?? [])]) fn(e);
};

/** Awaiting a never-settling promise HANGS the suite instead of failing it. */
async function raceClock<T>(p: Promise<T>, ms = 50) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<{ won: "timer" }>((r) => { timer = setTimeout(() => r({ won: "timer" }), ms); });
  const out = await Promise.race([p.then((value) => ({ won: "promise" as const, value })), clock]);
  clearTimeout(timer);
  return out;
}

// loadBindings() reads it while NetHack's view is constructed.
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { VectorView: AngbandVector } = await import("../../src/modules/angband/ui/VectorView");
const { VectorView: NethackVector } = await import("../../src/modules/nethack/ui/VectorView");
const { VectorView: LarnVector } = await import("../../src/modules/larn/ui/VectorView");
const { VectorView: MoriaVector } = await import("../../src/modules/moria/ui/VectorView");

const add = (id: string, parent?: StubEl) => {
  const el = new StubEl();
  el.id = id;
  els.set(id, el);
  parent?.appendChild(el);
  return el;
};

/** The page as index.html leaves it, plus a canvas inside #stage. */
const canvas = () => {
  const stage = add("stage");
  const view = add("view", stage);
  // #cmdbtn is NetHack's alone — the other three Modules remove it on the
  // synchronous path in main.ts — but it costs nothing to leave here.
  add("messages"); add("prompt"); add("status"); add("overlay"); add("cmdbtn");
  return view as unknown as HTMLCanvasElement;
};

beforeEach(() => {
  els.clear();
  docListeners.clear();
  seam.rendererDisposals = 0;
  seam.radarDisposals = 0;
  seam.lookDisposals = 0;
  (globalThis as Record<string, unknown>).document = documentStub;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
});

describe("Angband VectorView teardown", () => {
  it("delivers one key to BOTH views when neither is disposed — the leak this fixes", () => {
    const c = canvas();
    const first = new AngbandVector(c);
    const second = new AngbandVector(c);
    expect(bound()).toBe(2);
    press("j");
    expect(first.nextKey(false, false)).not.toBeNull();
    expect(second.nextKey(false, false)).not.toBeNull();
  });

  it("takes nothing after dispose, and leaves the surviving view alone", () => {
    const c = canvas();
    const first = new AngbandVector(c);
    const second = new AngbandVector(c);
    first.dispose();
    expect(bound()).toBe(1);
    press("j");
    expect(first.nextKey(false, false)).toBeNull();
    expect(second.nextKey(false, false)).not.toBeNull();
  });

  it("hands its dispose on to the renderer, the radar and the Look HUD", () => {
    const view = new AngbandVector(canvas());
    view.dispose();
    view.dispose(); // idempotent: each part is torn down once, not twice
    expect([seam.rendererDisposals, seam.radarDisposals, seam.lookDisposals]).toEqual([1, 1, 1]);
  });

  it("settles a parked key wait rather than leaving the engine's dispatch awaiting it", async () => {
    const view = new AngbandVector(canvas());
    const parked = view.nextKey(true, true) as Promise<unknown>;
    expect(parked).toBeInstanceOf(Promise);
    view.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: null });
  });
});

describe("NetHack VectorView teardown", () => {
  // The odd one out: NetHack's keys and its KeyQueue live in the TextHud this
  // view composes, and the view's own document listener is F2 alone. What it
  // does bind directly is three pointer listeners on the page's canvas, which
  // is why the canvas is asserted here by name.
  const clicks = (c: HTMLCanvasElement) => {
    const el = c as unknown as StubEl;
    return ["pointerdown", "click", "contextmenu"]
      .map((t) => el.listeners.get(t)?.size ?? 0);
  };

  it("leaves both views bound when neither is disposed — the leak this fixes", () => {
    const c = canvas();
    new NethackVector(c);
    new NethackVector(c);
    // Two F2 listeners and two HUDs' keydowns: one press toggles the camera
    // twice and feeds two engines.
    expect(bound()).toBe(4);
    expect(clicks(c)).toEqual([2, 2, 2]);
  });

  it("unbinds F2, all three canvas listeners, and hands the rest on", () => {
    const c = canvas();
    const first = new NethackVector(c);
    new NethackVector(c);
    first.dispose();
    first.dispose();
    expect(bound()).toBe(2);           // the survivor's F2 and its HUD's keydown
    expect(clicks(c)).toEqual([1, 1, 1]);
    expect([seam.rendererDisposals, seam.radarDisposals, seam.lookDisposals]).toEqual([1, 1, 1]);
  });

  it("settles the HUD's parked read rather than leaving the engine's dispatch awaiting it", async () => {
    const view = new NethackVector(canvas());
    const parked = view.handle({ name: "nhgetch" } as never) as Promise<number>;
    view.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: 27 });
  });
});

describe("Larn VectorView teardown", () => {
  it("delivers one key to BOTH views when neither is disposed — the leak this fixes", () => {
    const c = canvas();
    const first = new LarnVector(c);
    const second = new LarnVector(c);
    expect(bound()).toBe(2);
    press("j");
    expect(first.nextKey(false, false)).not.toBeNull();
    expect(second.nextKey(false, false)).not.toBeNull();
  });

  it("takes nothing after dispose, and hands its dispose on to every part", () => {
    const c = canvas();
    const first = new LarnVector(c);
    const second = new LarnVector(c);
    first.dispose();
    expect(bound()).toBe(1);
    press("j");
    expect(first.nextKey(false, false)).toBeNull();
    expect(second.nextKey(false, false)).not.toBeNull();
    expect([seam.rendererDisposals, seam.radarDisposals, seam.lookDisposals]).toEqual([1, 1, 1]);
  });

  it("settles a parked key wait rather than leaving the engine's dispatch awaiting it", async () => {
    const view = new LarnVector(canvas());
    const parked = view.nextKey(true, true) as Promise<unknown>;
    expect(parked).toBeInstanceOf(Promise);
    view.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: null });
  });
});

describe("Moria VectorView teardown", () => {
  it("delivers one key to BOTH views when neither is disposed — the leak this fixes", async () => {
    const c = canvas();
    const first = new MoriaVector(c);
    const second = new MoriaVector(c);
    expect(bound()).toBe(2);
    const a = first.nextKey(true, "outer-command", "original");
    const b = second.nextKey(true, "outer-command", "original");
    press("j");
    await expect(a).resolves.not.toBeNull();
    await expect(b).resolves.not.toBeNull();
  });

  it("takes nothing after dispose, and hands its dispose on to every part", async () => {
    const c = canvas();
    const first = new MoriaVector(c);
    const second = new MoriaVector(c);
    first.dispose();
    expect(bound()).toBe(1);
    press("j");
    expect(await first.nextKey(false, "poll", "original")).toBeNull();
    expect(await second.nextKey(false, "poll", "original")).not.toBeNull();
    expect([seam.rendererDisposals, seam.radarDisposals, seam.lookDisposals]).toEqual([1, 1, 1]);
  });

  it("settles a parked key wait rather than leaving the engine's dispatch awaiting it", async () => {
    const view = new MoriaVector(canvas());
    const parked = view.nextKey(true, "outer-command", "original") as Promise<number | null>;
    expect(parked).toBeInstanceOf(Promise);
    view.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: null });
  });
});
