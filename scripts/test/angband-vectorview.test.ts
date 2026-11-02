import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRID, GRID_FLAG, GRID_STRIDE } from "../../src/modules/angband/mapRecords";
import type { AngbandEvent } from "../../src/modules/angband/protocol";

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
  effectFired = vi.fn();
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
    _canvas.addEventListener("pointerdown", () => {});
    _canvas.addEventListener("pointermove", () => {});
    _canvas.addEventListener("pointerup", () => {});
    _canvas.addEventListener("wheel", () => {});
    _canvas.addEventListener("contextmenu", () => {});
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
  style: Record<string, string> = {};
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

const { VectorView } = await import("../../src/modules/angband/ui/VectorView");

function add(id: string, parent?: StubEl): StubEl {
  const el = new StubEl(); el.id = id; els.set(id, el); parent?.appendChild(el); return el;
}

function record(fields: { x?: number; y?: number; flags?: number; feature?: number; top?: string; terrain?: string } = {}) {
  const r = new Int32Array(GRID_STRIDE);
  r[GRID.X] = fields.x ?? 4; r[GRID.Y] = fields.y ?? 7;
  r[GRID.FEATURE] = fields.feature ?? 1; r[GRID.FLAGS] = fields.flags ?? 0;
  r[GRID.TOP_COLOR] = 12; r[GRID.TOP_RGB] = 0xa1b2c3;
  r[GRID.TOP_CHAR] = (fields.top ?? "o").codePointAt(0)!;
  r[GRID.TERRAIN_COLOR] = 6; r[GRID.TERRAIN_RGB] = 0x123456;
  r[GRID.TERRAIN_CHAR] = (fields.terrain ?? ".").codePointAt(0)!;
  return r;
}

const flush = async () => { await vi.runAllTimersAsync(); };

describe("Angband VectorView", () => {
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

  it("classifies map batches and recentres exactly once after a level finds its hero", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    view.handle({ name: "level", width: 80, height: 24 });
    expect(renderer.recentre).toHaveBeenCalledTimes(1);
    view.handle({ name: "map", records: record({ x: 9, y: 10, flags: GRID_FLAG.PLAYER, top: "@" }) });
    expect(renderer.map.at(9, 10)).toMatchObject({ category: "being", hero: true, ch: "@" });
    expect(renderer.syncHero).toHaveBeenCalledTimes(1);
    expect(renderer.recentre).toHaveBeenCalledTimes(2);
    view.handle({ name: "map", records: record({ x: 10, y: 10, flags: GRID_FLAG.PLAYER, top: "@" }) });
    expect(renderer.recentre).toHaveBeenCalledTimes(2);
    expect(renderer.syncHero).toHaveBeenCalledTimes(2);
  });

  it("keeps level recentering pending until a later map batch contains the hero", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    view.handle({ name: "level", width: 80, height: 24 });
    view.handle({ name: "map", records: record({ x: 2, y: 3 }) });
    expect(renderer.recentre).toHaveBeenCalledTimes(1);
    view.handle({ name: "map", records: record({ x: 4, y: 5, flags: GRID_FLAG.PLAYER, top: "@" }) });
    expect(renderer.recentre).toHaveBeenCalledTimes(2);
  });

  it("preserves known terrain beneath effects and lets a map update replace them", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const map = seam.renderers[0]!.map;
    view.handle({ name: "map", records: record({ x: 3, y: 4, feature: 2, terrain: "+" }) });
    view.handle({ name: "effect", x: 3, y: 4, ch: "-", color: 4, rgb: 0xff0000, beam: true });
    expect(map.at(3, 4)).toEqual({
      category: "effect", ch: "-", color: 4, rgb: 0xff0000, beam: true,
      terrain: expect.objectContaining({ category: "door", ch: "+" }),
    });
    view.handle({ name: "map", records: record({ x: 3, y: 4, feature: 1, terrain: "." }) });
    expect(map.at(3, 4).category).toBe("floor");
  });

  it("renders clean bounded messages safely", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const messages = els.get("messages")!;
    view.handle({ name: "message", text: "orc\u0000 says <boo>", messageType: 0 });
    // Assert cleanliness on the message's OWN element, while it is still
    // there: the 205-notice flood below evicts it past the 200-line cap, and
    // scanning the survivors for "<boo>" only ever walks lines that never
    // contained it (vect-hack-8r0). StubEl keeps textContent and innerHTML
    // as independent fields, so which property production assigned is
    // directly observable — line.innerHTML = text (the XSS regression) leaves
    // textContent empty, and cleanText's NUL stripping shows up in the value.
    const posted = messages.children[0]!;
    expect(posted.textContent).toBe("orc says <boo>");
    expect(posted.innerHTML).toBe("");
    for (let i = 0; i < 205; i++) view.onNotice(`notice ${i}`);
    expect(messages.children[0]!.textContent).toBe("notice 5");
    expect(messages.children).toHaveLength(200);
  });

  it("mirrors prompt, left sidebar, status, and full tty overlay on a coalesced render", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    view.handle({ name: "text", x: 0, y: 0, attr: 1, rgb: 0xffffff, text: "Command:" });
    view.handle({ name: "text", x: 0, y: 1, attr: 1, rgb: 0xffffff, text: "Race Elf" });
    view.handle({ name: "text", x: 0, y: 23, attr: 1, rgb: 0xffffff, text: "HP 12" });
    view.handle({ name: "overlay", active: true });
    view.handle({ name: "flush" });
    await flush();
    expect(els.get("prompt")!.innerHTML).toContain("ommand:");
    expect(els.get("status")!.innerHTML).toContain("HP 12");
    const sidebar = els.get("stage")!.children.find((e) => e.id === "angband-sidebar")!;
    expect(sidebar.innerHTML).toContain("Race Elf");
    expect(sidebar.hidden).toBe(true);
    expect(els.get("overlay")!.hidden).toBe(false);
    expect(els.get("overlay")!.innerHTML.split("\n")).toHaveLength(24);
    view.handle({ name: "overlay", active: false });
    await flush();
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(els.get("overlay")!.innerHTML).toBe("");
    expect(sidebar.hidden).toBe(false);
  });

  it("toggles F2 with player-facing messages and never queues the function key", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const e = { key: "F2", preventDefault: vi.fn() };
    for (const fn of keydown) fn(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(seam.renderers[0]!.toggleMode).toHaveBeenCalledTimes(1);
    expect(els.get("messages")!.children.at(-1)!.textContent).toContain("First-person view");
    expect(view.nextKey(false, true)).toBeNull();
  });

  it("feeds mapped keys, draws radar on renderer frames, and queues no command from a pointer event", () => {
    const canvas = els.get("view")!;
    const view = new VectorView(canvas as unknown as HTMLCanvasElement);
    for (const fn of keydown) fn({ key: "j", preventDefault() {} });
    expect(view.nextKey(false, false)).toEqual({ code: 0x6a, mods: 0 });
    seam.renderers[0]!.onFrame!(1.25);
    expect(seam.radars[0]!.draw).toHaveBeenCalledWith(seam.renderers[0]!.map, 1.25);
    for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "contextmenu"]) {
      canvas.dispatch(type, { preventDefault() {} });
    }
    expect(view.nextKey(false, false)).toBeNull();
    // Angband still has no pointer command menu (main.ts removes #cmdbtn); the
    // one click listener the canvas now carries is the Look HUD's tap-to-look
    // (spec 2026-08-18, Look.ts), which never feeds the key queue — proven
    // with a real pickCell() result so the click travels the whole handler,
    // not just its early "missed every cell" return. The structural half
    // still catches a second, unintended click listener.
    expect(canvas.listeners.get("click")).toHaveLength(1);
    canvas.dispatch("click", { preventDefault() {}, clientX: 0, clientY: 0 });
    expect(view.nextKey(false, false)).toBeNull();
  });

  it("remaps arrows only while Angband is asking for a command", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;

    view.nextKey(false, false);
    for (const fn of keydown) fn({ key: "ArrowUp", shiftKey: true, preventDefault() {} });
    expect(view.nextKey(false, false)).toEqual({ code: 0x83, mods: 0x02 });

    const pending = view.nextKey(true, true);
    renderer.heading = -Math.PI / 2;
    for (const fn of keydown) fn({ key: "ArrowUp", shiftKey: true, preventDefault() {} });
    await expect(pending).resolves.toEqual({ code: 0x36, mods: 0x12 });
  });

  it("does not arm command remapping after a nonblocking poll misses", () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    expect(view.nextKey(false, true)).toBeNull();
    for (const fn of keydown) fn({ key: "ArrowUp", shiftKey: false, preventDefault() {} });
    expect(view.nextKey(false, false)).toEqual({ code: 0x83, mods: 0 });
  });

  it("ends command remapping when a key answers that request", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const pending = view.nextKey(true, true);
    for (const fn of keydown) fn({ key: "ArrowUp", shiftKey: false, preventDefault() {} });
    // No second engine request has arrived, so typeahead returns to native
    // prompt keys instead of assuming that every future request is a command.
    for (const fn of keydown) fn({ key: "ArrowRight", shiftKey: false, preventDefault() {} });
    await expect(pending).resolves.toEqual({ code: 0x38, mods: 0x10 });
    expect(view.nextKey(false, false)).toEqual({ code: 0x82, mods: 0 });
  });

  it("turns and resets first-person facing locally without queuing a turn", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.mode = "first";
    const pending = view.nextKey(true, true);

    for (const fn of keydown) fn({ key: "ArrowLeft", shiftKey: false, preventDefault() {} });
    expect(renderer.turn).toHaveBeenCalledWith(Math.PI / 4);

    renderer.heading = 1;
    for (const fn of keydown) fn({ key: "Clear", shiftKey: false, preventDefault() {} });
    expect(renderer.resetFacing).toHaveBeenCalledTimes(1);
    // The same parked request is still waiting: local camera actions answer
    // no engine request and consume no game time.
    for (const fn of keydown) fn({ key: "ArrowUp", shiftKey: false, preventDefault() {} });
    await expect(pending).resolves.toEqual({ code: 0x38, mods: 0x10 });
  });

  it("moves left and right in orbital mode rather than turning", async () => {
    const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
    const renderer = seam.renderers[0]!;
    renderer.mode = "orbital";
    const pending = view.nextKey(true, true);
    for (const fn of keydown) fn({ key: "ArrowRight", shiftKey: false, preventDefault() {} });
    expect(renderer.turn).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual({ code: 0x36, mods: 0x10 });
  });

  describe("hit flash wiring", () => {
    // A keypad direction only ever comes off the command-level remap, so a move
    // is: park a command request, then press the arrow for that bearing.
    const press = (key: string) => {
      for (const fn of keydown) fn({ key, shiftKey: false, preventDefault() {} });
    };
    const boot = () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      const renderer = seam.renderers[0]!;
      renderer.map.hero = { x: 10, y: 5 };
      return { view, renderer };
    };

    it("melee hit after a keypad move pulses hero + direction", () => {
      const { view, renderer } = boot();
      view.nextKey(true, true);
      press("ArrowRight"); // orbital, heading 0 -> keypad East
      view.handle({ name: "message", text: "You hit the kobold.", messageType: 2 });
      expect(renderer.hitFlash).toHaveBeenCalledWith(11, 5);
    });

    it("MON_HIT pulses the hero cell", () => {
      const { view, renderer } = boot();
      view.handle({ name: "message", text: "The kobold hits you.", messageType: 34 });
      expect(renderer.hitFlash).toHaveBeenCalledWith(10, 5);
    });

    it("MON_HIT between two monsters pulses nothing (vect-hack-xqg)", () => {
      // The command-monster mechanic (cmd-cave.c monster_attack_monster) puts
      // the same msgt on a blow the hero was not the target of.
      const { view, renderer } = boot();
      view.handle({ name: "message", text: "The kobold hits the orc.", messageType: 34 });
      expect(renderer.hitFlash).not.toHaveBeenCalled();
      // and a real blow on the hero, on the same view, still does:
      view.handle({ name: "message", text: "The orc hits you.", messageType: 34 });
      expect(renderer.hitFlash).toHaveBeenCalledWith(10, 5);
    });

    it("SHOOT_HIT pulses the last effect cell; MISS pulses nothing", () => {
      const { view, renderer } = boot();
      view.handle({ name: "effect", x: 3, y: 9, ch: "*", color: 1, rgb: 0, beam: false });
      view.handle({ name: "message", text: "The arrow hits.", messageType: 85 });
      expect(renderer.hitFlash).toHaveBeenCalledWith(3, 9);
      renderer.hitFlash.mockClear();
      view.handle({ name: "message", text: "You miss.", messageType: 3 });
      expect(renderer.hitFlash).not.toHaveBeenCalled();
    });

    it("a key send drops the effect cell, so a later ambiguous hit does not guess", () => {
      const { view, renderer } = boot();
      view.handle({ name: "effect", x: 3, y: 9, ch: "*", color: 1, rgb: 0, beam: false });
      press("Escape"); // a new command: the previous command's effect is stale
      view.handle({ name: "message", text: "It was a good hit!", messageType: 141 });
      expect(renderer.hitFlash).not.toHaveBeenCalled();
    });

    it("spends the effect cell on the first message and never reuses it", () => {
      const { view, renderer } = boot();
      view.handle({ name: "effect", x: 3, y: 9, ch: "*", color: 1, rgb: 0, beam: false });
      view.handle({ name: "message", text: "The arrow hits.", messageType: 85 });
      expect(renderer.hitFlash).toHaveBeenCalledWith(3, 9);
      renderer.hitFlash.mockClear();
      // The borg answers the engine itself, so no key send ever clears this:
      // a later melee crit must not inherit the missile's cell.
      view.handle({ name: "message", text: "It was a good hit!", messageType: 141 });
      expect(renderer.hitFlash).not.toHaveBeenCalled();
    });

    it("a new level drops the old level's effect cell", () => {
      const { view, renderer } = boot();
      view.handle({ name: "effect", x: 3, y: 9, ch: "*", color: 1, rgb: 0, beam: false });
      view.handle({ name: "level", width: 80, height: 24 });
      view.handle({ name: "map", records: record({ x: 10, y: 5, flags: GRID_FLAG.PLAYER, top: "@" }) });
      view.handle({ name: "message", text: "It was a good hit!", messageType: 141 });
      expect(renderer.hitFlash).not.toHaveBeenCalled();
    });

    it("a new level drops the old level's direction", () => {
      const { view, renderer } = boot();
      view.nextKey(true, true);
      press("ArrowRight");
      view.handle({ name: "level", width: 80, height: 24 });
      view.handle({ name: "map", records: record({ x: 10, y: 5, flags: GRID_FLAG.PLAYER, top: "@" }) });
      view.handle({ name: "message", text: "You hit the kobold.", messageType: 2 });
      expect(renderer.hitFlash).not.toHaveBeenCalled();
    });

    it("a non-direction key clears lastDir, so a later ranged crit uses the effect cell", () => {
      const { view, renderer } = boot();
      view.nextKey(true, true);
      press("ArrowRight"); // direction: lastDir = E
      press("Escape");     // fires the shot: no direction, so lastDir is stale
      view.handle({ name: "effect", x: 3, y: 9, ch: "*", color: 1, rgb: 0, beam: false });
      view.handle({ name: "message", text: "It was a good hit!", messageType: 141 });
      expect(renderer.hitFlash).toHaveBeenCalledWith(3, 9);
    });
  });

  describe("effect lifetime wiring (vect-hack-auo)", () => {
    // The grid is engine truth and nothing in the record stream retracts an
    // effect Cell — the engine's own repaint does. So the render layer is told
    // the effect FIRED, as an event, and keeps it drawable for its own
    // envelope: with delay_factor 0 the set and the repaint arrive in one
    // batch and a grid the renderer samples per frame never holds the blast.
    it("signals the render layer, with the terrain the blast is standing on", () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      const renderer = seam.renderers[0]!;
      view.handle({ name: "map", records: record({ x: 3, y: 9 }) });
      const terrain = { ...renderer.map.at(3, 9) };
      view.handle({ name: "effect", x: 3, y: 9, ch: "*", color: 1, rgb: 0x112233, beam: false });

      expect(renderer.effectFired).toHaveBeenCalledTimes(1);
      const [x, y, cell] = renderer.effectFired.mock.calls[0]!;
      expect([x, y]).toEqual([3, 9]);
      // The same Cell the grid took, so the two can never draw different things.
      expect(cell).toEqual(renderer.map.at(3, 9));
      expect(cell.category).toBe("effect");
      expect(cell.terrain).toEqual(terrain);
    });

    it("signals a beam as a beam", () => {
      const view = new VectorView(els.get("view") as unknown as HTMLCanvasElement);
      const renderer = seam.renderers[0]!;
      view.handle({ name: "effect", x: 4, y: 2, ch: "-", color: 1, rgb: 0, beam: true });
      expect(renderer.effectFired.mock.calls[0]![2].beam).toBe(true);
    });
  });

  it("ignores every semantic event without disturbing the tty composition", async () => {
    const { TtyView } = await import("../../src/modules/angband/ui/TtyView");
    const view = new TtyView();
    view.handle({ name: "text", x: 0, y: 0, attr: 1, rgb: 0xffffff, text: "Command:" });
    await flush();
    const map = els.get("stage")!.children.find((e) => e.id === "map")!;
    const drawn = map.innerHTML;
    expect(drawn).toContain("ommand:");
    const events: AngbandEvent[] = [
      { name: "map", records: record() }, { name: "level", width: 80, height: 24 },
      { name: "message", text: "hi", messageType: 0 }, { name: "overlay", active: true },
      { name: "effect", x: 1, y: 1, ch: "*", color: 4, rgb: 0xff0000, beam: false },
    ];
    expect(() => events.forEach((event) => view.handle(event))).not.toThrow();
    await flush();
    // not.toThrow() was the whole test (vect-hack-8r0): a TtyView that answered
    // these events by clearing or repainting its grid passed it. The tty view's
    // contract is that the semantic stream is not its business, so the drawn
    // 80x24 composition must come out byte-identical.
    expect(map.innerHTML).toBe(drawn);
  });
});
