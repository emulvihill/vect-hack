import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRID, GRID_STRIDE, OVERLAY, TERRAIN, TOP } from "../../src/modules/moria/mapRecords";
import { MORIA_FRAME_BYTES, type MoriaEvent } from "../../src/modules/moria/protocol";
import type { MoriaSemanticState } from "../../src/modules/moria/semanticProtocol";

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
  hitFlash = vi.fn();
  toggleMode = vi.fn(() => (this.mode = this.mode === "orbital" ? "first" : "orbital"));
  turn = vi.fn((delta: number) => { this.heading += delta; });
  resetFacing = vi.fn(() => { this.heading = 0; });
  // VectorView's constructor builds a LookHud against this renderer; nothing
  // in this file drives a pointer event through it, so these two only need to
  // exist and return a stable shape.
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
  listeners = new Map<string, Array<(event: any) => void>>();
  appendChild(child: StubEl) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
  addEventListener(type: string, fn: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, event: any) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  get childElementCount() { return this.children.length; }
  get firstChild(): StubEl | null { return this.children[0] ?? null; }
}

const els = new Map<string, StubEl>();
let keydown: Array<(event: any) => void> = [];
const documentStub = {
  body: new StubEl(),
  getElementById: (id: string) => els.get(id) ?? null,
  createElement: () => new StubEl(),
  addEventListener: (type: string, fn: (event: any) => void) => {
    if (type === "keydown") keydown.push(fn);
  },
};

const { VectorView } = await import("../../src/modules/moria/ui/VectorView");

function add(id: string, parent?: StubEl): StubEl {
  const element = new StubEl();
  element.id = id;
  els.set(id, element);
  parent?.appendChild(element);
  return element;
}

function record(fields: {
  x?: number; y?: number; terrainCat?: number; terrainKind?: number;
  terrainChar?: string; topCat?: number; topChar?: string;
} = {}): Int32Array {
  const words = new Int32Array(GRID_STRIDE);
  words[GRID.X] = fields.x ?? 4;
  words[GRID.Y] = fields.y ?? 7;
  words[GRID.TERRAIN_CAT] = fields.terrainCat ?? TERRAIN.FLOOR;
  words[GRID.TERRAIN_KIND] = fields.terrainKind ?? 1;
  words[GRID.TERRAIN_CHAR] = (fields.terrainChar ?? ".").codePointAt(0)!;
  words[GRID.TOP_CAT] = fields.topCat ?? TOP.NONE;
  words[GRID.TOP_CHAR] = (fields.topChar ?? " ").codePointAt(0)!;
  return words;
}

function state(overrides: Partial<MoriaSemanticState> = {}): MoriaSemanticState {
  return {
    width: 80, height: 24,
    panel: { top: 0, bottom: 23, left: 0, right: 79 },
    hero: { x: 10, y: 5 }, depth: 7, turn: 12345,
    playerName: "Public Hero", playerLevel: 9, experience: 3210, gold: 456,
    hp: 17, maxHp: 23, mana: 5, maxMana: 8, ac: 11,
    blind: false, hallucinating: false, confused: false, afraid: false,
    poisoned: false, resting: false, overlay: OVERLAY.NONE,
    ...overrides,
  };
}

function frame(text: string, row = 0, col = 0): MoriaEvent {
  const cells = new Uint8Array(MORIA_FRAME_BYTES).fill(0x20);
  cells.set([...text].map((ch) => ch.charCodeAt(0)), row * 80 + col);
  return { name: "frame", cells, x: 79, y: 23 };
}

function press(key: string, shiftKey = false) {
  const event = { key, shiftKey, ctrlKey: false, altKey: false, metaKey: false, preventDefault: vi.fn() };
  for (const fn of keydown) fn(event);
  return event;
}

const flush = async () => { await vi.runAllTimersAsync(); };

describe("Moria VectorView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    els.clear();
    keydown = [];
    seam.renderers.length = 0;
    seam.radars.length = 0;
    (globalThis as any).document = documentStub;
    const stage = add("stage");
    add("view", stage);
    add("messages");
    add("prompt");
    add("status");
    add("overlay");
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
  });

  it("clears a reset before applying records, preserves underlays, and recentres once on its hero", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.set(40, 40, { category: "wall", ch: "#", color: 6 });
    const records = Int32Array.from([
      ...record({ x: 9, y: 10, topCat: TOP.ITEM, topChar: "!" }),
      ...record({ x: 10, y: 10, topCat: TOP.HERO, topChar: "@" }),
    ]);
    view.handle({ name: "map", records, reset: true });

    expect(renderer.map.at(40, 40).category).toBe("unseen");
    expect(renderer.map.at(9, 10)).toMatchObject({
      category: "item", ch: "!", terrain: { category: "floor" },
    });
    expect(renderer.map.hero).toEqual({ x: 10, y: 10 });
    expect(renderer.syncHero).toHaveBeenCalledTimes(1);
    expect(renderer.recentre).toHaveBeenCalledTimes(1);
    expect(seam.radars[0]!.invalidate).toHaveBeenCalledTimes(1);
    view.handle({ name: "map", records: record({ x: 11, y: 10, topCat: TOP.HERO, topChar: "@" }), reset: false });
    expect(renderer.recentre).toHaveBeenCalledTimes(1);
  });

  it("draws Radar from renderer frames and structured state into the status HUD", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    view.handle({ name: "state", state: state({ confused: true, poisoned: true, resting: true }) });
    await flush();
    expect(els.get("status")!.textContent).toContain("Public Hero");
    expect(els.get("status")!.textContent).toContain("HP 17/23");
    expect(els.get("status")!.textContent).toContain("MP 5/8");
    expect(els.get("status")!.textContent).toContain("Confused Poisoned Resting");
    seam.renderers[0]!.onFrame!(1.25);
    expect(seam.radars[0]!.draw).toHaveBeenCalledWith(seam.renderers[0]!.map, 1.25);
  });

  it("mirrors the canonical prompt/sidebar regions but never infers an overlay from literal text", async () => {
    const canvas = els.get("view")!;
    const view = new VectorView(canvas as unknown as HTMLCanvasElement);
    for (const prompt of ["Which direction?", "Really quit?", "-more-"]) {
      view.handle(frame(prompt));
      view.handle({ name: "state", state: state({ overlay: OVERLAY.NONE }) });
      await flush();
      expect(els.get("prompt")!.innerHTML).toContain(prompt);
      expect(els.get("overlay")!.hidden).toBe(true);
      expect(canvas.style.visibility).toBe("");
    }
    view.handle(frame("STR: 18", 1, 0));
    await flush();
    const sidebar = els.get("stage")!.children.find((child) => child.id === "moria-sidebar")!;
    expect(sidebar.innerHTML).toContain("STR: 18");
  });

  it("uses only source overlay state for inventory/help/store/death/score screens", async () => {
    const canvas = els.get("view")!;
    const view = new VectorView(canvas as unknown as HTMLCanvasElement);
    view.handle(frame("Inventory screen"));
    for (const overlay of [
      OVERLAY.INVENTORY, OVERLAY.HELP, OVERLAY.STORE, OVERLAY.TOMB, OVERLAY.SCORE,
    ]) {
      view.handle({ name: "state", state: state({ overlay }) });
      await flush();
      expect(els.get("overlay")!.hidden).toBe(false);
      expect(els.get("overlay")!.innerHTML).toContain("Inventory screen");
      expect(canvas.style.visibility).toBe("hidden");
    }
    view.handle({ name: "state", state: state({ overlay: OVERLAY.NONE }) });
    await flush();
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(els.get("overlay")!.innerHTML).toBe("");
    expect(canvas.style.visibility).toBe("");
  });

  it("strips source control bytes, bounds messages, and flashes only inferred victims", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.hero = { x: 10, y: 5 };
    const pending = view.nextKey(true, "outer-command", "original");
    press("ArrowRight");
    view.handle({ name: "message", text: "You hit the orc.\u0007" });
    expect(renderer.hitFlash).not.toHaveBeenCalled();
    view.handle({ name: "message", text: "The orc hits you." });
    expect(renderer.hitFlash).toHaveBeenCalledWith(10, 5);
    for (let i = 0; i < 205; i++) view.onNotice(`notice ${i}`);
    expect(els.get("messages")!.children).toHaveLength(200);
    expect(els.get("messages")!.children[0]!.textContent).toBe("notice 5");
    return expect(pending).resolves.toBe("6".charCodeAt(0));
  });

  it("keeps direction through a multi-blow miss then hit, and clears it on reset", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.hero = { x: 10, y: 5 };
    const first = view.nextKey(true, "outer-command", "original");
    press("ArrowRight");
    await expect(first).resolves.toBe("6".charCodeAt(0));
    view.handle({ name: "message", text: "You miss the orc." });
    expect(renderer.hitFlash).not.toHaveBeenCalled();
    view.handle({ name: "message", text: "You hit the orc." });
    expect(renderer.hitFlash).toHaveBeenCalledWith(11, 5);

    renderer.hitFlash.mockClear();
    const second = view.nextKey(true, "outer-command", "original");
    press("ArrowRight");
    await expect(second).resolves.toBe("6".charCodeAt(0));
    view.handle({ name: "map", records: record({ x: 2, y: 2, topCat: TOP.HERO, topChar: "@" }), reset: true });
    view.handle({ name: "message", text: "You hit the orc." });
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });

  it("remaps orbital movement only while an outer-command request is parked", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    expect(view.nextKey(false, "outer-command", "original")).toBeNull();
    press("ArrowUp");
    expect(view.nextKey(false, "literal", "original")).toBeNull();

    const literal = view.nextKey(true, "literal", "original");
    press("ArrowRight");
    press("6");
    await expect(literal).resolves.toBe("6".charCodeAt(0));

    const outer = view.nextKey(true, "outer-command", "original");
    seam.renderers[0]!.heading = -Math.PI / 2;
    press("ArrowUp");
    await expect(outer).resolves.toBe("6".charCodeAt(0));
  });

  it("encodes original runs as dot then a literal direction without losing hit evidence", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.hero = { x: 10, y: 5 };
    const outer = view.nextKey(true, "outer-command", "original");
    press("ArrowUp", true);
    await expect(outer).resolves.toBe(".".charCodeAt(0));
    // Real originalCommands('.') calls getDirectionWithMemory(), which emits
    // this source message before asking the literal second read. The direction
    // is not fresh until that queued answer is actually consumed.
    view.handle({ name: "message", text: "Which direction?" });
    expect(view.nextKey(false, "literal", "original")).toBe("8".charCodeAt(0));
    view.handle({ name: "message", text: "You hit the orc." });
    expect(renderer.hitFlash).toHaveBeenCalledWith(10, 4);
  });

  it("tracks a manually typed original run only after its literal direction is consumed", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.hero = { x: 10, y: 5 };
    const outer = view.nextKey(true, "outer-command", "original");
    press(".");
    await expect(outer).resolves.toBe(".".charCodeAt(0));
    const direction = view.nextKey(true, "literal", "original");
    press("8");
    await expect(direction).resolves.toBe("8".charCodeAt(0));
    view.handle({ name: "message", text: "You hit the orc." });
    expect(renderer.hitFlash).toHaveBeenCalledWith(10, 4);
  });

  it("tracks a buffered manual original run direction only when the source consumes it", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.hero = { x: 10, y: 5 };
    const outer = view.nextKey(true, "outer-command", "original");
    press(".");
    await expect(outer).resolves.toBe(".".charCodeAt(0));
    press("8");
    expect(view.nextKey(false, "literal", "original")).toBe("8".charCodeAt(0));
    view.handle({ name: "message", text: "You hit the orc." });
    expect(renderer.hitFlash).toHaveBeenCalledWith(10, 4);
  });

  it("does not arm a queued original run direction across an unrelated prompt", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.hero = { x: 10, y: 5 };
    const outer = view.nextKey(true, "outer-command", "original");
    press("ArrowUp", true);
    await expect(outer).resolves.toBe(".".charCodeAt(0));
    view.handle({ name: "message", text: "Really quit?" });
    expect(view.nextKey(false, "literal", "original")).toBe("8".charCodeAt(0));
    view.handle({ name: "message", text: "You hit the orc." });
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });

  it("encodes roguelike camera walks as lowercase and runs as uppercase", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const walk = view.nextKey(true, "outer-command", "roguelike");
    press("ArrowUp");
    await expect(walk).resolves.toBe("k".charCodeAt(0));
    const run = view.nextKey(true, "outer-command", "roguelike");
    press("ArrowRight", true);
    await expect(run).resolves.toBe("L".charCodeAt(0));
  });

  it("turns and resets first-person facing locally without answering the request", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.mode = "first";
    const pending = view.nextKey(true, "outer-command", "original");
    press("ArrowLeft");
    expect(renderer.turn).toHaveBeenCalledWith(Math.PI / 4);
    press("Clear");
    expect(renderer.resetFacing).toHaveBeenCalledTimes(1);
    press("ArrowUp");
    await expect(pending).resolves.toBe("8".charCodeAt(0));
  });

  it("clears hit evidence when a nested prompt begins", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.map.hero = { x: 10, y: 5 };
    const outer = view.nextKey(true, "outer-command", "original");
    press("ArrowRight");
    await expect(outer).resolves.toBe("6".charCodeAt(0));
    const nested = view.nextKey(true, "literal", "original");
    press("6");
    await expect(nested).resolves.toBe("6".charCodeAt(0));
    view.handle({ name: "message", text: "You hit the orc." });
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });

  it("toggles F2 locally and never queues the function key", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const event = press("F2");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(seam.renderers[0]!.toggleMode).toHaveBeenCalledTimes(1);
    expect(els.get("messages")!.children.at(-1)!.textContent).toContain("First-person");
    expect(view.nextKey(false, "literal", "original")).toBeNull();
  });
});
