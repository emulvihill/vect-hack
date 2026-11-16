// NetHack's VectorView as the player drives it: the pointer, F2, the hero
// menu, the ?touch scheme, and the extended-command line it routes to the HUD.
// The Angband, Larn and Moria views each have a file like this; NetHack's
// pointer path (vect-hack-be3.3) had only its pure tables tested
// (pointer-actions.test.ts) and its teardown (vectorview-teardown.test.ts),
// so a VectorView that stopped sending the verb it resolved, or ran it on a
// camera drag, passed everything.
//
// The renderer, radar and Look HUD are mocked — a real DungeonRenderer needs
// a GPU — but the TextHud, the classifier, pointerActions, moveKeys and the
// touch layer are the real ones. What reaches the engine is observed the way
// the engine observes it: a parked nh_poskey, answered from the HUD's queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MG } from "../../../src/modules/nethack/classifier";
import { ctrl, key } from "../../../src/modules/nethack/ui/keys";
import type { GlyphCell } from "../../../src/modules/nethack/protocol";

const seam = vi.hoisted(() => ({ renderers: [] as FakeRenderer[] }));

class FakeRenderer {
  map: import("../../../src/backplane/cell").CellGrid;
  onFrame: ((heading: number) => void) | null = null;
  backend = "webgpu";
  mode: "orbital" | "first" = "orbital";
  heading = 0;
  pick: { x: number; y: number } | null = null;
  start = vi.fn(async () => {});
  syncHero = vi.fn();
  recentre = vi.fn();
  hitFlash = vi.fn();
  toggleMode = vi.fn(() => (this.mode = this.mode === "orbital" ? "first" : "orbital"));
  turn = vi.fn();
  resetFacing = vi.fn();
  pickCell = vi.fn(() => this.pick);
  dispose = vi.fn();
  constructor(_canvas: unknown, map: import("../../../src/backplane/cell").CellGrid) {
    this.map = map;
    seam.renderers.push(this);
  }
}
class FakeRadar {
  draw = vi.fn(); invalidate = vi.fn(); dispose = vi.fn();
  constructor(_parent: unknown) {}
}
class FakeLook {
  clear = vi.fn(); dispose = vi.fn();
  constructor(_canvas: unknown, _parent: unknown, _renderer: unknown) {}
}
vi.mock("../../../src/render/DungeonRenderer", () => ({ DungeonRenderer: FakeRenderer }));
vi.mock("../../../src/ui/hud/Radar", () => ({ Radar: FakeRadar }));
vi.mock("../../../src/ui/hud/Look", () => ({ LookHud: FakeLook }));

type Listener = (e: never) => void;
interface Bound { fn: Listener; once: boolean }

/** Minimal local DOM: records listeners so a test can fire them, and keeps a
 *  parent chain so #overlay.contains() can tell a row from the map. */
class StubEl {
  id = "";
  type = "";
  title = "";
  value = "";
  innerHTML = "";
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  style = { visibility: "" };
  parentElement: StubEl | null = null;
  children: StubEl[] = [];
  classes = new Set<string>();
  listeners = new Map<string, Bound[]>();
  onkeydown: ((e: unknown) => void) | null = null;
  #text = "";
  get textContent() { return this.#text; }
  set textContent(v: string) { this.#text = v; this.children = []; }
  get classList() {
    const s = this.classes;
    return {
      add: (c: string) => void s.add(c),
      remove: (c: string) => void s.delete(c),
      toggle: (c: string, on?: boolean) => void ((on ?? !s.has(c)) ? s.add(c) : s.delete(c)),
      contains: (c: string) => s.has(c),
    };
  }
  get childElementCount() { return this.children.length; }
  get firstChild(): StubEl | null { return this.children[0] ?? null; }
  appendChild(c: StubEl) { c.parentElement = this; this.children.push(c); return c; }
  append(...cs: StubEl[]) { for (const c of cs) this.appendChild(c); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
  }
  blur() {}
  focus() {}
  contains(n: unknown): boolean {
    for (let p = n as StubEl | null; p; p = p.parentElement) if (p === this) return true;
    return false;
  }
  addEventListener(t: string, fn: Listener, opts?: boolean | { once?: boolean }) {
    const once = typeof opts === "object" && opts.once === true;
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), { fn, once }]);
  }
  removeEventListener(t: string, fn: Listener) {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((b) => b.fn !== fn));
  }
  emit(t: string, e: Record<string, unknown> = {}) {
    const event = { preventDefault: vi.fn(), stopPropagation() {}, ...e };
    for (const b of [...(this.listeners.get(t) ?? [])]) {
      if (b.once) this.removeEventListener(t, b.fn);
      b.fn(event as never);
    }
    return event;
  }
}

const els = new Map<string, StubEl>();
const doc = new StubEl();
const body = new StubEl();
(globalThis as Record<string, unknown>).document = Object.assign(doc, {
  body,
  getElementById: (id: string) => els.get(id) ?? null,
  createElement: () => new StubEl(),
});
// loadBindings() reads it while the view is constructed.
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { VectorView } = await import("../../../src/modules/nethack/ui/VectorView");

const add = (id: string, parent?: StubEl) => {
  const el = new StubEl();
  el.id = id;
  els.set(id, el);
  parent?.appendChild(el);
  return el;
};

// Same stand-in offsets as pointer-actions.test.ts: only order and gaps matter.
const CONSTANTS = {
  GLYPH: {
    GLYPH_PET_OFF: 100, GLYPH_INVIS_OFF: 200, GLYPH_DETECT_OFF: 201,
    GLYPH_BODY_OFF: 301, GLYPH_RIDDEN_OFF: 401, GLYPH_OBJ_OFF: 501,
    GLYPH_CMAP_OFF: 601, GLYPH_ZAP_OFF: 700, GLYPH_EXPLODE_OFF: 800,
    GLYPH_WARNING_OFF: 900, GLYPH_STATUE_OFF: 910, GLYPH_UNEXPLORED_OFF: 1500,
  },
  WIN_TYPE: { NHW_MESSAGE: 1, NHW_MAP: 3 },
};
const MONSTER = 12;
const HERO = { x: 10, y: 10 };
const glyph = (g: number, ch: string, glyphflags = 0): GlyphCell => ({ glyph: g, ch, color: 7, glyphflags });

let stage: StubEl;
let canvas: StubEl;
let view: InstanceType<typeof VectorView>;
let renderer: FakeRenderer;

/** Draw a glyph the way the engine does, through the view. */
const draw = (x: number, y: number, g: GlyphCell) =>
  void view.handle({ name: "print_glyph", win: 3, x, y, cell: g, bg: null });

/** Every key the engine reads next, without waiting on one that never comes. */
async function engineReads(n = 1): Promise<number[]> {
  const got: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = view.handle({ name: "nh_poskey" }) as Promise<number>;
    const r = await Promise.race([k, new Promise<"none">((res) => setTimeout(() => res("none"), 20))]);
    if (r === "none") break;
    got.push(r);
  }
  return got;
}

/** A pointerdown/up pair as the browser delivers it: down, then the click. */
function gesture(type: "click" | "contextmenu", at: { x: number; y: number }, from = at) {
  canvas.emit("pointerdown", { clientX: from.x, clientY: from.y });
  return canvas.emit(type, { clientX: at.x, clientY: at.y });
}
const PX = { x: 200, y: 150 }; // screen point; the fake pick decides the cell

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  els.clear();
  doc.listeners.clear();
  body.classes.clear();
  seam.renderers.length = 0;
  stage = add("stage");
  canvas = add("view", stage);
  add("messages"); add("prompt"); add("status"); add("overlay"); add("cmdbtn");
  view = new VectorView(canvas as unknown as HTMLCanvasElement);
  renderer = seam.renderers[0]!;
  view.onReady(CONSTANTS);
  view.handle({ name: "create_nhwindow", wintype: 1 }); // win 1: the message window
  draw(HERO.x, HERO.y, glyph(MONSTER, "@", MG.HERO));
});

afterEach(() => {
  view.dispose();
  vi.useRealTimers();
});

describe("NetHack VectorView pointer", () => {
  it("left click on an adjacent hostile sends the attack as the direction toward it", async () => {
    draw(11, 10, glyph(MONSTER, "d")); // east
    renderer.pick = { x: 11, y: 10 };
    gesture("click", PX);
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("l")]);
  });

  it("does nothing for a click on empty floor, out of reach, or off the map", async () => {
    draw(15, 15, glyph(MONSTER, "d")); // hostile, but not adjacent
    renderer.pick = { x: 15, y: 15 };
    gesture("click", PX);
    renderer.pick = { x: 40, y: 5 }; // never drawn
    gesture("click", PX);
    renderer.pick = null; // missed the map entirely
    gesture("click", PX);
    vi.useRealTimers();
    expect(await engineReads()).toEqual([]);
  });

  it("reads a pointer that moved more than six pixels as a camera drag, not a click", async () => {
    draw(11, 10, glyph(MONSTER, "d"));
    renderer.pick = { x: 11, y: 10 };
    gesture("click", { x: PX.x + 7, y: PX.y }, PX); // a drag that ended over the monster
    gesture("contextmenu", { x: PX.x, y: PX.y + 7 }, PX);
    expect(els.get("overlay")!.innerHTML).toBe("");
    gesture("click", { x: PX.x + 6, y: PX.y }, PX); // six is still a click
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("l")]);
  });

  it("right click lists every verb for the target, and a row sends its verb and direction", async () => {
    draw(10, 9, glyph(MONSTER, "d")); // north
    renderer.pick = { x: 10, y: 9 };
    const e = gesture("contextmenu", PX);
    expect(e.preventDefault).toHaveBeenCalled();
    const overlay = els.get("overlay")!;
    expect(overlay.hidden).toBe(false);
    expect(overlay.innerHTML).toContain("Attack");
    expect(overlay.innerHTML).toContain("Chat");
    expect(overlay.innerHTML).toContain("Kick");
    // Kick is the third row.
    overlay.emit("click", { target: { closest: () => ({ dataset: { pi: "2" } }) } });
    expect(overlay.hidden).toBe(true);
    vi.useRealTimers();
    expect(await engineReads(3)).toEqual([ctrl("d"), key("k")]);
  });

  it("opens the stand-on menu for a click on the hero, either button, with the stairs underfoot", async () => {
    renderer.map.under = { ...renderer.map.at(HERO.x, HERO.y), ch: ">" };
    renderer.pick = HERO;
    gesture("click", PX);
    const overlay = els.get("overlay")!;
    expect(overlay.innerHTML).toContain("Pick up");
    expect(overlay.innerHTML).toContain("Go down stairs");
    overlay.emit("click", { target: { closest: () => ({ dataset: { pi: "2" } }) } });
    gesture("contextmenu", PX);
    expect(overlay.innerHTML).toContain("Look here");
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key(">")]);
  });

  it("swallows the click whose pointerdown closed the menu, and only that one", async () => {
    draw(11, 10, glyph(MONSTER, "d"));
    renderer.pick = { x: 11, y: 10 };
    gesture("contextmenu", PX);
    vi.runAllTimers(); // the menu's outside-click listener goes on a tick later
    expect(els.get("overlay")!.hidden).toBe(false);
    // "click elsewhere to cancel" — elsewhere being the monster's cell.
    doc.emit("pointerdown", { target: canvas });
    canvas.emit("pointerdown", { clientX: PX.x, clientY: PX.y });
    canvas.emit("click", { clientX: PX.x, clientY: PX.y });
    expect(els.get("overlay")!.hidden).toBe(true);
    gesture("click", PX); // a deliberate click afterwards still acts
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("l")]);
  });

  it("auto-opens the stand-on menu on an item-here message, and lets the next key through", async () => {
    view.handle({ name: "putstr", win: 1, attr: 0, text: "You see here a dagger." });
    const overlay = els.get("overlay")!;
    expect(overlay.hidden).toBe(false);
    expect(overlay.innerHTML).toContain("Pick up");
    doc.emit("keydown", { key: "j" }); // passthrough: closes, then walks
    expect(overlay.hidden).toBe(true);
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("j")]);
  });

  it("keeps a menu the player opened modal: a key does not leak past it", async () => {
    renderer.pick = HERO;
    gesture("click", PX);
    doc.emit("keydown", { key: "j" });
    expect(els.get("overlay")!.hidden).toBe(false);
    vi.useRealTimers();
    expect(await engineReads()).toEqual([]);
  });
});

describe("NetHack VectorView F2", () => {
  it("switches the camera, says so, and never hands F2 to the engine", async () => {
    const e = doc.emit("keydown", { key: "F2" });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(renderer.toggleMode).toHaveBeenCalledTimes(1);
    expect(els.get("messages")!.children.at(-1)!.textContent).toMatch(/^First-person view/);
    doc.emit("keydown", { key: "F2" });
    expect(els.get("messages")!.children.at(-1)!.textContent).toMatch(/^Orbital view/);
    doc.emit("keydown", { key: "F3" }); // not this view's key
    expect(renderer.toggleMode).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    expect(await engineReads()).toEqual([]);
  });

  it("still takes F2 from the browser while a text prompt owns the keyboard", () => {
    // The HUD steps aside for #linein and preventDefaults nothing then; F2 is
    // the view's own, and it must not fall through to the page.
    add("linein");
    void view.handle({ name: "getlin", query: "Call it:" });
    const e = doc.emit("keydown", { key: "F2" });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(renderer.toggleMode).toHaveBeenCalledTimes(1);
  });
});

describe("NetHack VectorView touch", () => {
  const touchIds = () => stage.children.map((c) => c.id).filter((id) => id.startsWith("touch"));

  it("builds none of the touch scheme unless installTouch is called", () => {
    // main.ts calls it only for ?touch; the view itself must never.
    expect(touchIds()).toEqual([]);
    expect(body.classes.size).toBe(0);
  });

  it("installTouch builds the pad and bar in the stage, driving this view's HUD and camera", async () => {
    const controls = view.installTouch();
    expect(touchIds().sort()).toEqual(["touchbar", "touchcam", "touchpad"]);
    expect(body.classes.has("vh-touch")).toBe(true);
    const pad = stage.children.find((c) => c.id === "touchpad")!;
    pad.children[4]!.emit("pointerdown"); // centre: face north, the renderer's own reset
    expect(renderer.resetFacing).toHaveBeenCalledTimes(1);
    pad.children[1]!.emit("pointerdown"); // top middle: forward, north at heading 0
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("k")]);
    controls.stop();
    expect(body.classes.has("vh-touch")).toBe(false);
  });
});

describe("NetHack extended commands", () => {
  const COMMANDS = [
    { name: "pray", desc: "pray to the gods" },
    { name: "pick", desc: "test-only: shares a prefix with pray" },
    { name: "quit", desc: "exit without saving" },
    { name: "quitall", desc: "test-only: quit is a prefix of it" },
  ];
  /** Open the # prompt and type a line into it. */
  async function extCmd(line: string, finish: "Enter" | "Escape" = "Enter") {
    const input = add("linein"); // getLine's <input>, as innerHTML would have made it
    const r = view.handle({ name: "get_ext_cmd", commands: COMMANDS }) as Promise<number>;
    expect(els.get("prompt")!.innerHTML).toContain("# (extended command)");
    input.value = line;
    input.onkeydown!({ key: finish, stopPropagation() {} });
    return r;
  }
  const lastMessage = () => els.get("messages")!.children.at(-1)?.textContent;

  it("answers an exact name with its index, even where it prefixes another", async () => {
    expect(await extCmd("quit")).toBe(2);
  });

  it("accepts a unique prefix", async () => {
    expect(await extCmd("pra")).toBe(0);
    expect(await extCmd("quita")).toBe(3);
  });

  it("cancels an ambiguous prefix and lists the candidates", async () => {
    expect(await extCmd("p")).toBe(-1);
    expect(lastMessage()).toBe("Ambiguous: pray, pick");
  });

  it("cancels an unknown name and says so", async () => {
    expect(await extCmd("dance")).toBe(-1);
    expect(lastMessage()).toBe("Unknown extended command: dance");
    expect(await extCmd("ray")).toBe(-1); // inside "pray", but not its start
    expect(lastMessage()).toBe("Unknown extended command: ray");
  });

  it("cancels on an empty line or Escape without a message", async () => {
    const before = els.get("messages")!.children.length;
    expect(await extCmd("")).toBe(-1);
    expect(await extCmd("quit", "Escape")).toBe(-1);
    expect(els.get("messages")!.children.length).toBe(before);
  });
});
