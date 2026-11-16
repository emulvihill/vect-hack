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
import { installStubDocument, type StubEl } from "./stub-dom";

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

// #overlay.contains() must tell a row from the map, and the view builds its
// own touch elements: an id nothing stood up answers null.
const dom = installStubDocument({ lookup: "null" });
// loadBindings() reads it while the view is constructed.
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { VectorView } = await import("../../../src/modules/nethack/ui/VectorView");

const add = (id: string, parent?: StubEl) => {
  const el = dom.el(id);
  el.id = id;
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
  const e = { clientX: at.x, clientY: at.y, preventDefault: vi.fn() };
  canvas.emit(type, e);
  return e;
}
const PX = { x: 200, y: 150 }; // screen point; the fake pick decides the cell

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  dom.reset();
  dom.body.classes.clear();
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
    expect(dom.el("overlay").innerHTML).toBe("");
    gesture("click", { x: PX.x + 6, y: PX.y }, PX); // six is still a click
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("l")]);
  });

  it("right click lists every verb for the target, and a row sends its verb and direction", async () => {
    draw(10, 9, glyph(MONSTER, "d")); // north
    renderer.pick = { x: 10, y: 9 };
    const e = gesture("contextmenu", PX);
    expect(e.preventDefault).toHaveBeenCalled();
    const overlay = dom.el("overlay");
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
    const overlay = dom.el("overlay");
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
    expect(dom.el("overlay").hidden).toBe(false);
    // "click elsewhere to cancel" — elsewhere being the monster's cell.
    dom.dispatch("pointerdown", { target: canvas });
    canvas.emit("pointerdown", { clientX: PX.x, clientY: PX.y });
    canvas.emit("click", { clientX: PX.x, clientY: PX.y });
    expect(dom.el("overlay").hidden).toBe(true);
    gesture("click", PX); // a deliberate click afterwards still acts
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("l")]);
  });

  it("auto-opens the stand-on menu on an item-here message, and lets the next key through", async () => {
    view.handle({ name: "putstr", win: 1, attr: 0, text: "You see here a dagger." });
    const overlay = dom.el("overlay");
    expect(overlay.hidden).toBe(false);
    expect(overlay.innerHTML).toContain("Pick up");
    dom.press("j"); // passthrough: closes, then walks
    expect(overlay.hidden).toBe(true);
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("j")]);
  });

  it("keeps a menu the player opened modal: a key does not leak past it", async () => {
    renderer.pick = HERO;
    gesture("click", PX);
    dom.press("j");
    expect(dom.el("overlay").hidden).toBe(false);
    vi.useRealTimers();
    expect(await engineReads()).toEqual([]);
  });
});

describe("NetHack VectorView F2", () => {
  it("switches the camera, says so, and never hands F2 to the engine", async () => {
    expect(dom.press("F2").defaultPrevented).toBe(true);
    expect(renderer.toggleMode).toHaveBeenCalledTimes(1);
    expect(dom.el("messages").children.at(-1)!.textContent).toMatch(/^First-person view/);
    dom.press("F2");
    expect(dom.el("messages").children.at(-1)!.textContent).toMatch(/^Orbital view/);
    dom.press("F3"); // not this view's key
    expect(renderer.toggleMode).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    expect(await engineReads()).toEqual([]);
  });

  it("still takes F2 from the browser while a text prompt owns the keyboard", () => {
    // The HUD steps aside for #linein and preventDefaults nothing then; F2 is
    // the view's own, and it must not fall through to the page.
    add("linein");
    void view.handle({ name: "getlin", query: "Call it:" });
    expect(dom.press("F2").defaultPrevented).toBe(true);
    expect(renderer.toggleMode).toHaveBeenCalledTimes(1);
  });
});

describe("NetHack VectorView touch", () => {
  const touchIds = () => stage.children.map((c) => c.id).filter((id) => id.startsWith("touch"));

  it("builds none of the touch scheme unless installTouch is called", () => {
    // main.ts calls it only for ?touch; the view itself must never.
    expect(touchIds()).toEqual([]);
    expect(dom.body.classes.size).toBe(0);
  });

  it("installTouch builds the pad and bar in the stage, driving this view's HUD and camera", async () => {
    const controls = view.installTouch();
    expect(touchIds().sort()).toEqual(["touchbar", "touchcam", "touchpad"]);
    expect(dom.body.classes.has("vh-touch")).toBe(true);
    const pad = stage.children.find((c) => c.id === "touchpad")!;
    pad.children[4]!.emit("pointerdown", { preventDefault() {} }); // centre: face north, the renderer's own reset
    expect(renderer.resetFacing).toHaveBeenCalledTimes(1);
    pad.children[1]!.emit("pointerdown", { preventDefault() {} }); // top middle: forward, north at heading 0
    vi.useRealTimers();
    expect(await engineReads(2)).toEqual([key("k")]);
    controls.stop();
    expect(dom.body.classes.has("vh-touch")).toBe(false);
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
    expect(dom.el("prompt").innerHTML).toContain("# (extended command)");
    input.value = line;
    input.onkeydown!({ key: finish, stopPropagation() {} });
    return r;
  }
  const lastMessage = () => dom.el("messages").children.at(-1)?.textContent;

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
    const before = dom.el("messages").children.length;
    expect(await extCmd("")).toBe(-1);
    expect(await extCmd("quit", "Escape")).toBe(-1);
    expect(dom.el("messages").children.length).toBe(before);
  });
});
