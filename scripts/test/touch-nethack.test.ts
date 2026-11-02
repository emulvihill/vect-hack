// The touch layer wired to the real thing (vect-hack-21k): NetHack's adapter
// answering the shared layer's six seams, and TextHud's three new ones driven
// against real engine prompts.
//
// The DOM stub is the command-menu-ui.test.ts one grown enough to build
// elements as well as record listeners — TouchControls creates its own pad and
// bar rather than unhiding markup, so a write-only stub could not see them.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { key } from "../../src/modules/nethack/ui/keys";
import { barIsWellFormed, PAD_GRID, type PendingInput } from "../../src/ui/touch/scheme";

type Listener = (e: never) => void;

class StubEl {
  id = "";
  type = "";
  title = "";
  tabIndex = 0;
  className = "";
  value = "";
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  focused = 0;
  removed = 0;
  onkeydown: Listener | null = null;
  children: StubEl[] = [];
  classes = new Set<string>();
  listeners = new Map<string, Set<Listener>>();
  #text = "";
  get textContent() { return this.#text; }
  set textContent(v: string) { this.#text = v; this.innerHTML = v; this.children = []; }
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  get classList() {
    const s = this.classes;
    return {
      add: (c: string) => void s.add(c),
      remove: (c: string) => void s.delete(c),
      toggle: (c: string, on: boolean) => void (on ? s.add(c) : s.delete(c)),
      contains: (c: string) => s.has(c),
    };
  }
  appendChild(c: StubEl) { this.children.push(c); return c; }
  append(...cs: StubEl[]) { this.children.push(...cs); }
  remove() { this.removed++; }
  blur() {}
  focus() { this.focused++; }
  contains() { return true; }
  querySelector() { return null; }
  addEventListener(t: string, fn: Listener) {
    const set = this.listeners.get(t) ?? new Set<Listener>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn); }
  emit(t: string, e: unknown = {}) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e as never); }
}

const els = new Map<string, StubEl>();
const el = (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!;
const body = new StubEl();

(globalThis as Record<string, unknown>).document = {
  body,
  getElementById: (id: string) => els.get(id) ?? null,
  createElement: () => new StubEl(),
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as Document;

const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");
const { TouchControls } = await import("../../src/ui/touch/TouchControls");
const { NETHACK_TOUCH_BAR, nethackDirectionKey, nethackTouchHost } =
  await import("../../src/modules/nethack/ui/touchAdapter");

/** TextHud reaches these by id in its constructor, so they must pre-exist —
 *  getElementById here returns null for anything not stood up on purpose,
 *  which is what lets the getlin test control whether #linein is there. */
const HUD_IDS = ["messages", "status", "overlay", "prompt", "cmdbtn"];

describe("NetHack's touch adapter", () => {
  it("puts six verbs and the tail on the bar, each spelled with its own NetHack key", () => {
    // The set, and the reason the glyph is the key: the bar teaches the
    // keyboard game rather than hiding it. Every letter is cmd.c's own.
    expect(NETHACK_TOUCH_BAR.map((i) => [i.label, i.glyph])).toEqual([
      ["Search", "s"], ["Pick", ","], ["Open", "o"],
      ["Rest", "."], ["Items", "i"], ["Down", ">"], ["More", "☰"],
    ]);
    expect(NETHACK_TOUCH_BAR.map((i) => i.codes?.[0])).toEqual([
      key("s"), key(","), key("o"), key("."), key("i"), key(">"), undefined,
    ]);
    expect(barIsWellFormed(NETHACK_TOUCH_BAR)).toBe(true);
  });

  it("encodes a compass eighth as NetHack's own direction letter", () => {
    // Clockwise from north (cmd.c). A rotated table walks the hero the wrong
    // way and nothing else in the port would notice.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(nethackDirectionKey))
      .toEqual(["k", "u", "l", "n", "j", "b", "h", "y"].map(key));
  });
});

describe("the touch layer over a live TextHud", () => {
  let hud: InstanceType<typeof TextHud>;
  let controls: InstanceType<typeof TouchControls>;
  let camera: { mode: "orbital" | "first"; heading: number; turn: ReturnType<typeof vi.fn>;
                resetFacing: ReturnType<typeof vi.fn>; toggleMode: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    els.clear();
    body.classes.clear();
    for (const id of HUD_IDS) el(id);
    hud = new TextHud();
    camera = {
      mode: "orbital", heading: 0, turn: vi.fn(), resetFacing: vi.fn(),
      toggleMode: vi.fn(() => "first" as const),
    };
    controls = new TouchControls(nethackTouchHost(hud, camera as never, el("stage") as unknown as HTMLElement));
  });

  afterEach(() => controls.stop());

  const pad = () => el("stage").children.find((c) => c.id === "touchpad")!;
  const bar = () => el("stage").children.find((c) => c.id === "touchbar")!;
  const cam = () => el("stage").children.find((c) => c.id === "touchcam")!;
  const tapPad = (i: number) => pad().children[i]!.emit("pointerdown", { preventDefault() {} });
  const tapBar = (i: number) => bar().children[i]!.emit("click");
  /** Every code the engine actually reads, in order. */
  const fed: number[] = [];
  beforeEach(() => { fed.length = 0; hud.onKeyFed = (c) => void fed.push(c); });
  /** Make the engine read one key, and say what it got. */
  const read = () => hud.handle({ name: "nhgetch" }) as unknown as Promise<number>;

  it("builds a pad, a bar and the camera button inside the stage, and marks the body", () => {
    expect(pad().children).toHaveLength(PAD_GRID.length);
    expect(bar().children).toHaveLength(NETHACK_TOUCH_BAR.length);
    expect(cam().textContent).toBe("◰ 3rd");
    expect(body.classes.has("vh-touch")).toBe(true);
    controls.stop();
    expect(body.classes.has("vh-touch")).toBe(false);
  });

  it("steps: the pad's top-middle key feeds north, the row below it west and east", async () => {
    const pending = read();
    tapPad(1);
    expect(await pending).toBe(key("k"));
    tapPad(3); tapPad(5);
    expect(await read()).toBe(key("h"));
    expect(await read()).toBe(key("l"));
  });

  it("follows the camera: the same key steps east once the bearing has swung", async () => {
    camera.heading = -Math.PI / 2;
    const pending = read();
    tapPad(1);
    expect(await pending).toBe(key("l"));
  });

  it("answers a direction prompt with the pad, which is what puts Open on the bar", async () => {
    // Open is 'o' then a direction. The command menu carries no directional
    // verb because it has no answer for getdir(); this is the answer.
    const opened = hud.handle({ name: "yn_function", query: "In what direction?", choices: "", def: 0 }) as unknown as Promise<number>;
    expect(hud.pendingInput).toBe("direction");
    tapPad(7); // down the screen
    expect(await opened).toBe(key("j"));
  });

  it("refuses a bar verb while the engine is asking which way", async () => {
    const opened = hud.handle({ name: "yn_function", query: "In what direction?", choices: "", def: 0 }) as unknown as Promise<number>;
    tapBar(0); // Search: 's' here would be a step south, not a search
    tapBar(4); // Items
    // Nothing was fed, so the prompt is still open; the pad then settles it.
    tapPad(1);
    expect(await opened).toBe(key("k"));
    expect(fed).toEqual([key("k")]);
  });

  it("refuses the pad at a yes/no prompt, where the chips are the answer", async () => {
    const asked = hud.handle({ name: "yn_function", query: "Really quit?", choices: "yn", def: key("n") }) as unknown as Promise<number>;
    expect(hud.pendingInput).toBe("yesno");
    tapPad(1); tapBar(0);
    expect(fed).toEqual([]);
    // The chip that already exists is what answers it (vect-hack-be3.7).
    el("prompt").emit("click", { target: { closest: () => ({ dataset: { yn: "n" } }) } });
    expect(await asked).toBe(key("n"));
  });

  it("keeps the pad centre and the camera button off the wire entirely", async () => {
    tapPad(4);
    expect(camera.resetFacing).toHaveBeenCalledTimes(1);
    cam().emit("click");
    expect(camera.toggleMode).toHaveBeenCalledTimes(1);
    expect(cam().textContent).toBe("◱ 1st");
    // ... and again while the engine is blocked on a question, where a stray
    // key would answer something the player never chose.
    void hud.handle({ name: "yn_function", query: "Really quit?", choices: "yn", def: key("n") });
    tapPad(4);
    cam().emit("click");
    expect(camera.resetFacing).toHaveBeenCalledTimes(2);
    expect(fed).toEqual([]);
  });

  it("sends a bar verb at command level", async () => {
    const pending = read();
    tapBar(0);
    expect(await pending).toBe(key("s"));
    tapBar(5);
    expect(await read()).toBe(key(">"));
  });

  it("opens the Module's own command menu from the tail, rather than a second one", () => {
    tapBar(6);
    expect(el("overlay").hidden).toBe(false);
    expect(el("overlay").innerHTML).toContain("data-pi=");
    expect(el("overlay").innerHTML).toContain("Items...");
  });

  it("swaps the bar for Done/Cancel while a line prompt is up, and finishes it", async () => {
    el("linein"); // getLine reaches for its <input> by id; the stub needs it first
    const line = hud.handle({ name: "getlin", query: "Who are you?" }) as unknown as Promise<string | null>;
    el("linein").value = "Valkyrie";
    expect(hud.pendingInput).toBe("line");
    controls.pump();
    expect(bar().children.map((b) => b.title)).toEqual(["Done", "Cancel"]);
    tapBar(0);
    expect(await line).toBe("Valkyrie");
    controls.pump();
    expect(bar().children).toHaveLength(NETHACK_TOUCH_BAR.length);
  });

  it("cancels a line prompt the way Escape does", async () => {
    el("linein");
    const line = hud.handle({ name: "getlin", query: "Who are you?" }) as unknown as Promise<string | null>;
    el("linein").value = "ignored";
    controls.pump();
    tapBar(1);
    expect(await line).toBeNull();
  });

  it("locks the bar visibly while a prompt is up", () => {
    void hud.handle({ name: "yn_function", query: "Really quit?", choices: "yn", def: key("n") });
    controls.pump();
    expect(bar().classes.has("locked")).toBe(true);
  });
});

describe("TextHud's direction exception, asked directly", () => {
  // routePad already refuses outside a direction prompt, so the touch layer
  // never exercises the second half of this gate. It is asked here anyway:
  // the flag is part of a public seam three more adapters are going to use,
  // and "the caller happens never to lie" is not a property of the seam.
  let hud: InstanceType<typeof TextHud>;
  beforeEach(() => {
    els.clear();
    for (const id of HUD_IDS) el(id);
    hud = new TextHud();
  });

  it("takes a direction only at getdir(), never at a yes/no wearing the same flag", async () => {
    const asked = hud.handle({ name: "yn_function", query: "Really attack the shopkeeper?", choices: "yn", def: key("n") }) as unknown as Promise<number>;
    hud.sendKeys([key("y")], true); // a 'y' is a direction letter's neighbour; the flag is a lie
    hud.sendKeys([key("j")], true);
    // Nothing got through, so the question is still open and the chip settles it.
    el("prompt").emit("click", { target: { closest: () => ({ dataset: { yn: "n" } }) } });
    expect(await asked).toBe(key("n"));
  });

  it("takes it at getdir(), which is the whole point of the exception", async () => {
    const asked = hud.handle({ name: "yn_function", query: "In what direction?", choices: "", def: 0 }) as unknown as Promise<number>;
    hud.sendKeys([key("j")], true);
    expect(await asked).toBe(key("j"));
  });

  it("still refuses an unflagged key at getdir()", async () => {
    const asked = hud.handle({ name: "yn_function", query: "In what direction?", choices: "", def: 0 }) as unknown as Promise<number>;
    hud.sendKeys([key("s")]);
    hud.sendKeys([key("h")], true);
    expect(await asked).toBe(key("h"));
  });
});

describe("TextHud's pendingInput", () => {
  it("names the most specific shape when several are true at once", async () => {
    els.clear();
    for (const id of HUD_IDS) el(id);
    const hud = new TextHud();
    const shapes: PendingInput[] = [];
    expect(hud.pendingInput).toBe("none");
    void hud.handle({ name: "yn_function", query: "In what direction?", choices: "", def: 0 });
    shapes.push(hud.pendingInput);
    el("linein");
    void hud.handle({ name: "getlin", query: "Who are you?" });
    shapes.push(hud.pendingInput);
    // A direction prompt is also a `prompting`; a line input is up while it
    // still is. Least specific first would report "yesno" for both.
    expect(shapes).toEqual(["direction", "line"]);
  });
});
