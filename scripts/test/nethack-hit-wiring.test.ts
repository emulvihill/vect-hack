// The NetHack view's hit-flash wiring (spec 2026-08-06): TextHud's two new
// seams — every code the engine reads, and "is this the message window" —
// and VectorView spending them on inferNethackHit. The inference itself is
// pinned in nethack-hit-inference.test.ts; what is at stake here is
// freshness. A pulse on the wrong cell is worse than no pulse, and the last
// direction key is the only thing that says which cell "You hit the newt!"
// is about — so a key that answers a prompt, a key that isn't a direction,
// and a new level all have to drop it.
//
// Which is why every keystroke here is driven through a real read (`step`,
// `read`) rather than just pressed: the key queue buffers, and it is the
// reader taking a code out — not the push putting it in — that knows whether
// it was a command or an answer typed ahead of the prompt it belongs to.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CellGrid } from "../../src/backplane/cell";

const seam = vi.hoisted(() => ({ renderers: [] as FakeRenderer[] }));

class FakeRenderer {
  map: CellGrid;
  onFrame: ((heading: number) => void) | null = null;
  backend = "webgpu";
  mode: "orbital" | "first" = "orbital";
  heading = 0;
  start = vi.fn(async () => {});
  syncHero = vi.fn();
  recentre = vi.fn();
  hitFlash = vi.fn();
  toggleMode = vi.fn(() => this.mode);
  constructor(_canvas: HTMLCanvasElement, map: CellGrid) {
    this.map = map;
    seam.renderers.push(this);
  }
}

class FakeRadar {
  draw = vi.fn();
  invalidate = vi.fn();
  constructor(_parent: unknown) {}
}

vi.mock("../../src/render/DungeonRenderer", () => ({ DungeonRenderer: FakeRenderer }));
vi.mock("../../src/ui/hud/Radar", () => ({ Radar: FakeRadar }));

/** Enough of an element for the message log, the prompt line and the canvas. */
class StubEl {
  textContent = "";
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  parentElement: StubEl | null = null;
  children: StubEl[] = [];
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { c.parentElement = this; this.children.push(c); return c; }
  addEventListener() {}
  removeEventListener() {}
  blur() {}
  focus() {}
}

const els = new Map<string, StubEl>();
let keydown: Array<(e: { key: string; preventDefault(): void }) => void> = [];

(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: (type: string, fn: (e: { key: string; preventDefault(): void }) => void) => {
    if (type === "keydown") keydown.push(fn);
  },
} as unknown as Document;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

// Imported after the stubs: both look their elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");
const { VectorView } = await import("../../src/modules/nethack/ui/VectorView");
const { key } = await import("../../src/modules/nethack/ui/keys");

/** The two window types this file cares about, as onReady is handed them. */
const WT = { NHW_MESSAGE: 1, NHW_MAP: 2, NHW_TEXT: 3 };

const press = (k: string) => {
  for (const fn of [...keydown]) fn({ key: k, preventDefault() {} });
};

beforeEach(() => {
  els.clear();
  keydown = [];
  seam.renderers.length = 0;
});

/** The engine asking for one key — a queued code is consumed nowhere else. */
const read = (hud: InstanceType<typeof TextHud>) =>
  hud.handle({ name: "nhgetch" }) as Promise<number>;

describe("TextHud hit-flash seams", () => {
  it("onKeyFed sees every code the engine reads, from keys and sendKeys", async () => {
    const hud = new TextHud();
    const fed: number[] = [];
    hud.onKeyFed = (code) => fed.push(code);
    hud.sendKeys([key("l")]);
    press("j");
    expect(fed).toEqual([]); // still buffered: nothing has been read yet
    await read(hud);
    await read(hud);
    expect(fed).toEqual([key("l"), key("j")]);
  });

  it("marks a prompt's answer as not command-level", async () => {
    const hud = new TextHud();
    const fed: Array<[number, boolean]> = [];
    hud.onKeyFed = (code, command) => fed.push([code, command]);
    // getdir(): empty choices, so the first key typed is the answer.
    const answer = hud.handle(
      { name: "yn_function", query: "In what direction?", choices: "", def: 0 },
    ) as Promise<number>;
    press("l");
    await expect(answer).resolves.toBe(key("l"));
    expect(fed).toEqual([[key("l"), false]]);
    press("l");
    await read(hud);
    expect(fed[1]).toEqual([key("l"), true]); // the prompt is gone: a step again
  });

  it("stamps a typed-ahead answer by the reader that takes it, not the queue", async () => {
    const hud = new TextHud();
    const fed: Array<[number, boolean]> = [];
    hud.onKeyFed = (code, command) => fed.push([code, command]);
    // The player answers the shopkeeper confirmation before its yn_function
    // has dispatched — the queue buffers, so at push time nothing is
    // prompting. Read at push time, "y" is a command key, and nethackKeyDir
    // reads it as northwest.
    press("y");
    const answer = hud.handle({
      name: "yn_function", query: "Really attack the shopkeeper?",
      choices: "yn", def: key("n"),
    }) as Promise<number>;
    await expect(answer).resolves.toBe(key("y"));
    expect(fed).toEqual([[key("y"), false]]);
  });

  it("isMessage answers true exactly for the message window", () => {
    const hud = new TextHud();
    hud.onReady({ WIN_TYPE: WT });
    const message = hud.handle({ name: "create_nhwindow", wintype: WT.NHW_MESSAGE }) as number;
    const map = hud.handle({ name: "create_nhwindow", wintype: WT.NHW_MAP }) as number;
    expect(hud.isMessage(message)).toBe(true);
    expect(hud.isMessage(map)).toBe(false);
    expect(hud.isMessage(99)).toBe(false); // no such window
  });
});

describe("VectorView hit flash", () => {
  /** A canvas inside a stage, since the view hangs the radar off its parent. */
  const canvas = () => {
    const el = new StubEl();
    new StubEl().appendChild(el);
    return el as unknown as HTMLCanvasElement;
  };
  const boot = () => {
    const view = new VectorView(canvas());
    const renderer = seam.renderers[0]!;
    view.onReady({ WIN_TYPE: WT });
    const message = view.handle({ name: "create_nhwindow", wintype: WT.NHW_MESSAGE }) as number;
    const map = view.handle({ name: "create_nhwindow", wintype: WT.NHW_MAP }) as number;
    const text = view.handle({ name: "create_nhwindow", wintype: WT.NHW_TEXT }) as number;
    renderer.map.hero = { x: 10, y: 5 };
    return { view, renderer, message, map, text };
  };
  const say = (win: number, text: string) =>
    ({ name: "putstr", win, attr: 0, text }) as const;
  /** One command-loop keystroke, the way the engine takes it: a pending
   *  nhgetch, a key typed, and the engine reading it back out of the queue. */
  const step = async (view: InstanceType<typeof VectorView>, k: string) => {
    const pending = view.handle({ name: "nhgetch" }) as Promise<number>;
    press(k);
    await pending;
  };

  it("pulses the cell the last direction key stepped into, and still logs the line", async () => {
    const { view, renderer, message } = boot();
    await step(view, "l");
    view.handle(say(message, "You hit the newt!"));
    expect(renderer.hitFlash).toHaveBeenCalledWith(11, 5);
    expect(els.get("messages")!.children.map((c) => c.textContent)).toEqual(["You hit the newt!"]);
  });

  it("pulses the hero's own cell when a monster lands one", () => {
    const { view, renderer, message } = boot();
    view.handle(say(message, "The newt bites!"));
    expect(renderer.hitFlash).toHaveBeenCalledWith(10, 5);
  });

  it("drops the aim on a non-direction key", async () => {
    const { view, renderer, message } = boot();
    await step(view, "l");
    await step(view, "i"); // inventory: whatever happens next, it isn't a step east
    view.handle(say(message, "You hit the newt!"));
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });

  it("drops the aim on a direction that answered a prompt", async () => {
    const { view, renderer, message } = boot();
    const answer = view.handle(
      { name: "yn_function", query: "In what direction?", choices: "", def: 0 },
    ) as Promise<number>;
    press("l");
    await answer;
    view.handle(say(message, "You hit the newt!"));
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });

  it("drops the aim on a direction typed ahead of the prompt it answers", async () => {
    const { view, renderer, message } = boot();
    await step(view, "l"); // the attack itself, east
    // "Really attack the shopkeeper?" — answered before the yn_function has
    // dispatched. A `y` counted as a command would aim northwest.
    press("y");
    await (view.handle({
      name: "yn_function", query: "Really attack the shopkeeper?",
      choices: "yn", def: key("n"),
    }) as Promise<number>);
    view.handle(say(message, "You hit the shopkeeper!"));
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });

  it("drops the aim when the map is cleared for a new level", async () => {
    const { view, renderer, message, map } = boot();
    await step(view, "l");
    view.handle({ name: "clear_nhwindow", win: map });
    // The new level's first hero glyph, put back by hand: clear() nulls the
    // hero, and a null hero infers nothing all by itself — without this the
    // assertion below could not fail.
    renderer.map.hero = { x: 10, y: 5 };
    view.handle(say(message, "You hit the newt!"));
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });

  it("reads combat text only out of the message window", async () => {
    const { view, renderer, text } = boot();
    await step(view, "l"); // a real aim, so the window is what decides below
    view.handle(say(text, "You hit the newt!")); // a text dump, not the message line
    expect(renderer.hitFlash).not.toHaveBeenCalled();
  });
});
