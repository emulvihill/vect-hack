import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRID, GRID_STRIDE, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import type { LarnEvent } from "../../src/modules/larn/protocol";

const seam = vi.hoisted(() => ({ renderers: [] as FakeRenderer[], radars: [] as FakeRadar[] }));

class FakeRenderer {
  map: import("../../src/backplane/cell").CellGrid;
  onFrame: ((heading: number) => void) | null = null;
  backend = "webgpu";
  mode: "orbital" | "first" = "orbital";
  heading = 0;
  start = vi.fn(async () => {});
  syncHero = vi.fn();
  recentre = vi.fn();
  toggleMode = vi.fn(() => (this.mode = this.mode === "orbital" ? "first" : "orbital"));
  turn = vi.fn((delta: number) => { this.heading += delta; });
  resetFacing = vi.fn(() => { this.heading = 0; });
  // A real cell, not null: a click that misses every cell short-circuits
  // LookHud.point()'s early return before it reaches a handler gated on a
  // successful pick, and a future click-to-travel/attack binding on that gate
  // would then queue a key this test would never see either way.
  pickCell = vi.fn(() => ({ x: 3, y: 4 }));
  setHighlight = vi.fn();
  constructor(_canvas: HTMLCanvasElement, map: import("../../src/backplane/cell").CellGrid) {
    this.map = map;
    seam.renderers.push(this);
  }
}

class FakeRadar {
  draw = vi.fn();
  invalidate = vi.fn();
  constructor(_parent: HTMLElement) { seam.radars.push(this); }
}

vi.mock("../../src/render/DungeonRenderer", () => ({ DungeonRenderer: FakeRenderer }));
vi.mock("../../src/ui/hud/Radar", () => ({ Radar: FakeRadar }));

class StubEl {
  id = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  style = { visibility: "" };
  parentElement: StubEl | null = null;
  children: StubEl[] = [];
  classList = { add: vi.fn() };
  listeners = new Map<string, Array<(e: any) => void>>();
  appendChild(c: StubEl) { c.parentElement = this; this.children.push(c); return c; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); }
  addEventListener(type: string, fn: (e: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, e: any) { for (const fn of this.listeners.get(type) ?? []) fn(e); }
  get childElementCount() { return this.children.length; }
  get firstChild(): StubEl | null { return this.children[0] ?? null; }
}

const els = new Map<string, StubEl>();
let keydown: Array<(e: any) => void> = [];
const documentStub = {
  getElementById: (id: string) => els.get(id) ?? null,
  createElement: () => new StubEl(),
  addEventListener: (type: string, fn: (e: any) => void) => {
    if (type === "keydown") keydown.push(fn);
  },
};

const { VectorView } = await import("../../src/modules/larn/ui/VectorView");

function add(id: string, parent?: StubEl): StubEl {
  const el = new StubEl(); el.id = id; els.set(id, el); parent?.appendChild(el); return el;
}

/** Build one GRID_STRIDE-word record. Field order matches mapRecords.ts. */
function rec(
  x: number, y: number,
  tcat: number = TERRAIN.FLOOR, tchar: number = ".".codePointAt(0)!, tcolor = 6, tkind = 0,
  opcat: number = TOP.NONE, opchar = 0, opcolor = 0,
): Int32Array {
  const r = new Int32Array(GRID_STRIDE);
  r[GRID.X] = x; r[GRID.Y] = y;
  r[GRID.TERRAIN_CAT] = tcat; r[GRID.TERRAIN_CHAR] = tchar; r[GRID.TERRAIN_COLOR] = tcolor; r[GRID.TERRAIN_KIND] = tkind;
  r[GRID.TOP_CAT] = opcat; r[GRID.TOP_CHAR] = opchar; r[GRID.TOP_COLOR] = opcolor;
  return r;
}

const flush = async () => { await vi.runAllTimersAsync(); };

describe("Larn VectorView", () => {
  beforeEach(() => {
    vi.useFakeTimers(); els.clear(); keydown = []; seam.renderers.length = 0; seam.radars.length = 0;
    (globalThis as any).document = documentStub;
    const stage = add("stage");
    add("view", stage); add("messages"); add("prompt"); add("status"); add("overlay");
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
  });

  it("classifies map batches, syncs the hero, and sets the hero cell", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    view.handle({ name: "map", records: rec(9, 10, TERRAIN.FLOOR, ".".codePointAt(0)!, 6, 0, TOP.HERO) });
    expect(renderer.map.at(9, 10)).toMatchObject({ category: "being", hero: true, ch: "@" });
    expect(renderer.map.hero).toEqual({ x: 9, y: 10 });
    expect(renderer.syncHero).toHaveBeenCalledTimes(1);
  });

  it("applies an old/new blind delta by restoring the underlay and moving the hero", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    view.handle({ name: "map", records: rec(9, 10, TERRAIN.FLOOR, ".".codePointAt(0)!, 6, 0, TOP.HERO) });
    const delta = new Int32Array(GRID_STRIDE * 2);
    delta.set(rec(9, 10, TERRAIN.FLOOR, ".".codePointAt(0)!, 6, 0, TOP.ITEM, "*".codePointAt(0)!, 11));
    delta.set(rec(10, 10, TERRAIN.FLOOR, ".".codePointAt(0)!, 6, 0, TOP.HERO), GRID_STRIDE);
    view.handle({ name: "map", records: delta });

    expect(renderer.map.at(9, 10)).toMatchObject({ category: "item", ch: "*" });
    expect(renderer.map.at(10, 10)).toMatchObject({ category: "being", hero: true, ch: "@" });
    expect(renderer.map.hero).toEqual({ x: 10, y: 10 });
  });

  it("clears + recentres on a level event and keeps recentre pending until the first hero batch", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    view.handle({ name: "level", width: 67, height: 17 });
    expect(renderer.map.hero).toBeNull();
    expect(renderer.recentre).toHaveBeenCalledTimes(1);
    // A map batch without the hero does NOT recentre again (needsRecentre still armed).
    view.handle({ name: "map", records: rec(2, 3) });
    expect(renderer.recentre).toHaveBeenCalledTimes(1);
    // The first hero-bearing batch recentres exactly once and clears the flag.
    view.handle({ name: "map", records: rec(4, 5, TERRAIN.FLOOR, ".".codePointAt(0)!, 6, 0, TOP.HERO) });
    expect(renderer.recentre).toHaveBeenCalledTimes(2);
    // A subsequent same-level hero batch does NOT recentre.
    view.handle({ name: "map", records: rec(6, 7, TERRAIN.FLOOR, ".".codePointAt(0)!, 6, 0, TOP.HERO) });
    expect(renderer.recentre).toHaveBeenCalledTimes(2);
  });

  it("routes text/wipe/curs/clear into the tty mirror and renders the Larn status/sidebar/prompt regions", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    // Status line 1 (0-based row 17; display.c:70 cursor(1,18)).
    view.handle({ name: "text", x: 0, y: 17, rgb: 0xffffff, text: "Spells:  0( 0)  AC: 10   WC: 10  Level  1 Exp: 0         Conjurer" });
    // Status line 2 (0-based row 18; the HP line after the \n at display.c:80).
    view.handle({ name: "text", x: 0, y: 18, rgb: 0xffffff, text: "HP: 12(12) STR=10 INT=10 WIS=10 CON=10 DEX=10 CHA=10 LV: Home" });
    // botside panel (display.c:211 cursor(70, i+1) => 0-based col 69, row 0).
    view.handle({ name: "text", x: 69, y: 0, rgb: 0xffcc00, text: "stealth" });
    // Scrolling message area (0-based row 19).
    view.handle({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: "Welcome to Larn" });
    view.handle({ name: "curs", x: 0, y: 19 });
    view.handle({ name: "wipe", x: 0, y: 19, n: 15 });
    view.handle({ name: "clear" });
    view.handle({ name: "flush" });
    await flush();
    // After clear() the regions are blank; re-seed and re-flush for the assertions.
    view.handle({ name: "text", x: 0, y: 17, rgb: 0xffffff, text: "Spells:  0( 0)" });
    view.handle({ name: "text", x: 69, y: 0, rgb: 0xffcc00, text: "stealth" });
    view.handle({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: "Welcome to Larn" });
    // Park the cursor off the asserted cells so the cursor span does not split them.
    view.handle({ name: "curs", x: 79, y: 23 });
    await flush();
    expect(els.get("status")!.innerHTML).toContain("Spells:");
    const sidebar = els.get("stage")!.children.find((e) => e.id === "larn-sidebar")!;
    expect(sidebar.innerHTML).toContain("stealth");
    expect(els.get("prompt")!.innerHTML).toContain("Welcome to Larn");
  });

  it("renders the full tty grid into #overlay and hides the 3D surface when overlay is active; restores on inactive", async () => {
    const canvas = els.get("view")!;
    const view = new VectorView(canvas as unknown as HTMLCanvasElement);
    view.handle({ name: "text", x: 0, y: 0, rgb: 0xffffff, text: "Welcome to the game" });
    // Park the cursor off the asserted cell so the cursor span does not split it.
    view.handle({ name: "curs", x: 79, y: 23 });
    view.handle({ name: "overlay", active: true });
    view.handle({ name: "flush" });
    await flush();
    expect(els.get("overlay")!.hidden).toBe(false);
    expect(els.get("overlay")!.innerHTML.split("\n")).toHaveLength(24);
    expect(els.get("overlay")!.innerHTML).toContain("Welcome to the game");
    // The 3D surface (canvas) and sidebar are hidden while the overlay is up.
    expect(canvas.style.visibility).toBe("hidden");
    const sidebar = els.get("stage")!.children.find((e) => e.id === "larn-sidebar")!;
    expect(sidebar.hidden).toBe(true);
    view.handle({ name: "overlay", active: false });
    await flush();
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(els.get("overlay")!.innerHTML).toBe("");
    expect(canvas.style.visibility).toBe("");
    expect(sidebar.hidden).toBe(false);
  });

  it("toggles F2 with a player-facing message and never queues the function key", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const e = { key: "F2", preventDefault: vi.fn() };
    for (const fn of keydown) fn(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(seam.renderers[0]!.toggleMode).toHaveBeenCalledTimes(1);
    expect(els.get("messages")!.children.at(-1)!.textContent).toContain("First-person");
    expect(view.nextKey(false, false)).toBeNull();
  });

  it("feeds mapped vi-keys through nextKey, draws radar on frames, and leaves the queue empty after a drain", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    expect(view.nextKey(false, false)).toBeNull();
    for (const fn of keydown) fn({ key: "h", preventDefault() {} });
    expect(view.nextKey(false, false)).toEqual({ code: 0x68, mods: 0 });
    expect(view.nextKey(false, false)).toBeNull();
    seam.renderers[0]!.onFrame!(1.25);
    expect(seam.radars[0]!.draw).toHaveBeenCalledWith(seam.renderers[0]!.map, 1.25);
  });

  it("round-trips a pushed key through a blocking nextKey(wait=true)", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const pending = view.nextKey(true, false);
    for (const fn of keydown) fn({ key: "j", preventDefault() {} });
    await expect(pending).resolves.toEqual({ code: 0x6a, mods: 0 });
  });

  it("strips control bytes, escapes HTML, and caps the message log at 200", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    // Bell + a raw tag: cleanText must drop the bell and the message layer must
    // escape the angle brackets (textContent carries them, innerHTML does not).
    const bell = String.fromCharCode(7);
    view.onNotice(`${bell}orc says <boo>`);
    for (let i = 0; i < 205; i++) view.onNotice(`notice ${i}`);
    const messages = els.get("messages")!;
    expect(messages.children).toHaveLength(200);
    expect(messages.children.some((c) => c.innerHTML.includes("<boo>"))).toBe(false);
    // The bell was stripped before the DOM write.
    expect(messages.children.some((c) => c.textContent!.includes(bell))).toBe(false);
    // The first (oldest) notices were evicted by the 200-cap.
    expect(messages.children[0]!.textContent).toBe("notice 5");
  });

  describe("gaze-relative movement (vect-hack-bil)", () => {
    // Larn's vi encoding clockwise from north: k u l n j b h y; run is the
    // uppercase byte with the shift mod (keys.ts's movementKey).
    const press = (key: string, shiftKey = false) => {
      for (const fn of keydown) fn({ key, shiftKey, preventDefault() {} });
    };

    it("remaps direction keys only while Larn is asking for a command", async () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      const renderer = seam.renderers[0]!;

      // Prompt context (cmd=false): the arrow keeps its plain vi fold.
      view.nextKey(false, false);
      press("ArrowUp");
      expect(view.nextKey(false, false)).toEqual({ code: 0x6b, mods: 0 });

      // A parked command request arms the remap: facing East, forward is 'l'.
      const pending = view.nextKey(true, true);
      renderer.heading = -Math.PI / 2;
      press("ArrowUp", true);
      await expect(pending).resolves.toEqual({ code: 0x4c, mods: 0x02 }); // 'L' = run east
    });

    it("does not arm command remapping after a nonblocking poll misses", () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      seam.renderers[0]!.heading = -Math.PI / 2;
      expect(view.nextKey(false, true)).toBeNull();
      press("ArrowUp");
      expect(view.nextKey(false, false)).toEqual({ code: 0x6b, mods: 0 });
    });

    it("ends command remapping when a key answers that request", async () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      const renderer = seam.renderers[0]!;
      renderer.heading = Math.PI / 2; // facing West: gaze-forward is 'h'
      const pending = view.nextKey(true, true);
      press("ArrowUp");
      // Typeahead before the next engine request stays a native prompt key.
      press("ArrowUp");
      await expect(pending).resolves.toEqual({ code: 0x68, mods: 0 });
      expect(view.nextKey(false, false)).toEqual({ code: 0x6b, mods: 0 });
    });

    it("turns and resets first-person facing locally without queuing a key", async () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      const renderer = seam.renderers[0]!;
      renderer.mode = "first";
      const pending = view.nextKey(true, true);

      press("ArrowLeft");
      expect(renderer.turn).toHaveBeenCalledWith(Math.PI / 4);

      renderer.heading = 1;
      press("Clear");
      expect(renderer.resetFacing).toHaveBeenCalledTimes(1);
      // The parked request is still waiting: camera actions consume no turn.
      renderer.heading = 0;
      press("ArrowUp");
      await expect(pending).resolves.toEqual({ code: 0x6b, mods: 0 });
    });

    it("moves left and right in orbital mode rather than turning", async () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      const renderer = seam.renderers[0]!;
      const pending = view.nextKey(true, true);
      press("ArrowRight");
      expect(renderer.turn).not.toHaveBeenCalled();
      await expect(pending).resolves.toEqual({ code: 0x6c, mods: 0 });
    });
  });

  it("lets the phase-1 TtyView take every phase-2 LarnEvent, drawing only the tty ones", async () => {
    const { TtyView } = await import("../../src/modules/larn/ui/TtyView");
    const view = new TtyView();
    const tty: LarnEvent[] = [
      { name: "text", x: 0, y: 0, rgb: 0xffffff, text: "hi" },
      { name: "curs", x: 1, y: 1 },
      { name: "flush" },
    ];
    expect(() => tty.forEach((event) => view.handle(event))).not.toThrow();
    await flush();
    const map = els.get("stage")!.children.find((e) => e.id === "map")!;
    const drawn = map.innerHTML;
    expect(drawn).toContain("hi");

    // not.toThrow() was the whole test (vect-hack-8r0), so a TtyView that
    // answered a semantic event by clearing or repainting its grid passed it.
    // The semantic stream is not the tty view's business: the drawn
    // composition must come out byte-identical across all of it.
    const semantic: LarnEvent[] = [
      { name: "map", records: rec(1, 1) },
      { name: "level", width: 67, height: 17 },
      { name: "overlay", active: true },
      { name: "overlay", active: false },
    ];
    expect(() => semantic.forEach((event) => view.handle(event))).not.toThrow();
    await flush();
    expect(map.innerHTML).toBe(drawn);

    // The tty half still reaches the grid afterwards — otherwise "drawing only
    // the tty ones" would also hold for a view that had stopped drawing.
    view.handle({ name: "wipe", x: 0, y: 0, n: 5 });
    view.handle({ name: "clear" });
    await flush();
    expect(map.innerHTML).not.toBe(drawn);
  });
});
