// The Look HUD's wiring (spec 2026-08-18). The DOM stub records listeners and
// replays them, the same shape command-menu-ui.test.ts uses: every assertion
// here is about what happens when a listener fires.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: never) => void;

class StubEl {
  id = "";
  hidden = true;
  textContent = "";
  style: Record<string, string> = {};
  removed = 0;
  children: StubEl[] = [];
  listeners = new Map<string, Set<Listener>>();
  appendChild(c: StubEl) { this.children.push(c); return c; }
  remove() { this.removed++; }
  addEventListener(t: string, fn: Listener) {
    const set = this.listeners.get(t) ?? new Set<Listener>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn); }
  emit(t: string, e: unknown = {}) {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e as never);
  }
}

(globalThis as Record<string, unknown>).document = {
  createElement: () => new StubEl(),
} as unknown as Document;

const { LookHud, LOOK_DEBOUNCE_MS, LOOK_HINT, LOOK_HINT_MS, LOOK_TAP_MS, lookLabel } =
  await import("../../src/ui/hud/Look");

/** A renderer stand-in: whatever cell the test says is under the pointer. */
function fakeRenderer() {
  return {
    cell: null as { x: number; y: number } | null,
    highlights: [] as ({ x: number; y: number } | null)[],
    pickCell() { return this.cell; },
    setHighlight(c: { x: number; y: number } | null) { this.highlights.push(c); },
  };
}

let canvas: StubEl, stage: StubEl, renderer: ReturnType<typeof fakeRenderer>;
let hud: InstanceType<typeof LookHud>;
let asked: { x: number; y: number }[];
/** One deferred answer per describe call, settled by the test. */
let answers: ((text: string | null) => void)[];

const label = () => (stage.children[0] as StubEl);
const move = (x = 10, y = 20) => canvas.emit("pointermove", { clientX: x, clientY: y });
const settle = () => Promise.resolve().then(() => {}).then(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  canvas = new StubEl();
  stage = new StubEl();
  renderer = fakeRenderer();
  asked = [];
  answers = [];
  hud = new LookHud(canvas as never, stage as never, renderer);
  hud.describe = (x, y) => {
    asked.push({ x, y });
    return new Promise<string | null>((resolve) => answers.push(resolve));
  };
});
afterEach(() => vi.useRealTimers());

describe("pointing at a cell", () => {
  it("rings the cell at once and asks only after the debounce", () => {
    renderer.cell = { x: 3, y: 4 };
    move();
    expect(renderer.highlights.at(-1)).toEqual({ x: 3, y: 4 });
    expect(asked).toHaveLength(0);
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    expect(asked).toEqual([{ x: 3, y: 4 }]);
  });

  it("shows the engine's phrase with only the first letter changed", async () => {
    renderer.cell = { x: 3, y: 4 };
    move();
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[0]!("jackal (unhurt, asleep)");
    await settle();
    expect(label().hidden).toBe(false);
    expect(label().textContent).toBe("Jackal (unhurt, asleep)");
  });

  it("does not ask twice for the cell it is already on", () => {
    renderer.cell = { x: 3, y: 4 };
    move(10, 20);
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    move(11, 21);
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    expect(asked).toEqual([{ x: 3, y: 4 }]);
  });

  it("lets a newer cell win over a slower older reply", async () => {
    renderer.cell = { x: 1, y: 1 };
    move();
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    renderer.cell = { x: 2, y: 2 };
    move();
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[1]!("orange potion");
    answers[0]!("wall");            // the stale one, arriving last
    await settle();
    expect(label().textContent).toBe("Orange potion");
  });

  /** A tap (see the "tap and click" block below) re-asks for the same cell —
   *  used here to drive a second describe() call without moving off the ring
   *  a test wants to keep. */
  const tap = (x: number, y: number) =>
    canvas.emit("click", { clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });

  it("hides the label when the engine has nothing to say, keeping the ring", async () => {
    renderer.cell = { x: 3, y: 4 };
    move();
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[0]!("jackal (unhurt, asleep)");
    await settle();
    expect(label().hidden).toBe(false); // the label really was up before this...

    tap(10, 20); // ...and this is what takes it down.
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[1]!(null);
    await settle();
    expect(label().hidden).toBe(true);
    expect(renderer.highlights.at(-1)).toEqual({ x: 3, y: 4 });
  });

  it("clears ring and label when the describe fails", async () => {
    renderer.cell = { x: 3, y: 4 };
    move();
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[0]!("jackal (unhurt, asleep)");
    await settle();
    expect(label().hidden).toBe(false); // the label really was up before this...

    hud.describe = () => Promise.reject(new Error("engine died"));
    tap(10, 20); // ...and this is what clears it.
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    await settle();
    expect(label().hidden).toBe(true);
    expect(renderer.highlights.at(-1)).toBeNull();
  });

  it("clears ring and label when the pointer leaves the canvas", async () => {
    renderer.cell = { x: 3, y: 4 };
    move();
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[0]!("jackal (unhurt, asleep)");
    await settle();
    expect(label().hidden).toBe(false); // the label really was up before this...

    canvas.emit("pointerleave"); // ...and this is what takes it down.
    expect(label().hidden).toBe(true);
    expect(renderer.highlights.at(-1)).toBeNull();
  });

  it("names an empty pick as nothing at all", () => {
    renderer.cell = null;
    move();
    expect(renderer.highlights.at(-1)).toBeNull();
    expect(asked).toHaveLength(0);
  });
});

describe("tap and click", () => {
  it("names the tapped cell without swallowing the event", async () => {
    let defaulted = false;
    renderer.cell = { x: 6, y: 7 };
    canvas.emit("click", {
      clientX: 5, clientY: 5,
      // A tap must not stop NetHack's click verbs or the right-click menu.
      preventDefault: () => { defaulted = true; },
      stopPropagation: () => { defaulted = true; },
    });
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[0]!("orange potion");
    await settle();
    expect(label().textContent).toBe("Orange potion");
    expect(defaulted).toBe(false);
  });

  it("re-asks even for the cell already under the pointer", () => {
    renderer.cell = { x: 3, y: 4 };
    move(10, 20);
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    expect(asked).toEqual([{ x: 3, y: 4 }]);

    // A hover would skip this — see "does not ask twice" above — but a tap
    // has no earlier hover to have already asked from.
    canvas.emit("click", {
      clientX: 10, clientY: 20,
      preventDefault: () => {}, stopPropagation: () => {},
    });
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    expect(asked).toEqual([{ x: 3, y: 4 }, { x: 3, y: 4 }]);
  });

  it("auto-clears a tap's label after LOOK_TAP_MS", async () => {
    renderer.cell = { x: 6, y: 7 };
    canvas.emit("click", {
      clientX: 5, clientY: 5,
      preventDefault: () => {}, stopPropagation: () => {},
    });
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[0]!("orange potion");
    await settle();
    expect(label().hidden).toBe(false);

    vi.advanceTimersByTime(LOOK_TAP_MS);
    expect(label().hidden).toBe(true);
    expect(renderer.highlights.at(-1)).toBeNull();
  });
});

describe("discoverability", () => {
  it("offers the hint at the pointer that just arrived, and only the first time", () => {
    canvas.emit("pointerenter", { clientX: 42, clientY: 99 });
    expect(label().textContent).toBe(LOOK_HINT);
    // Pins the fix for the hint rendering at the default fixed-position origin
    // instead of beside the pointer that triggered it: 14px is LABEL_OFFSET.
    expect(label().style.left).toBe("56px");
    expect(label().style.top).toBe("113px");
    hud.clear();
    canvas.emit("pointerenter", { clientX: 1, clientY: 1 });
    expect(label().hidden).toBe(true);
  });

  it("auto-hides the hint after LOOK_HINT_MS", () => {
    canvas.emit("pointerenter", { clientX: 1, clientY: 1 });
    expect(label().hidden).toBe(false);
    vi.advanceTimersByTime(LOOK_HINT_MS);
    expect(label().hidden).toBe(true);
  });

  // The regression the test above cannot see: every browser fires a
  // pointermove alongside the pointerenter, and while hint and question
  // shared one timer slot that move cancelled the hint's hide. The hint then
  // outlived its window and — with no engine answer to replace it — sat there
  // until pointerleave, which is exactly what the browser gate would have read
  // as a Module naming things when it named nothing.
  it("keeps the hint for its full window across the pointermove beside it, then drops it", () => {
    renderer.cell = { x: 3, y: 4 };
    canvas.emit("pointerenter", { clientX: 1, clientY: 1 });
    move(1, 1);
    expect(label().textContent).toBe(LOOK_HINT);

    // The question fires and is still in flight; the hint is still the label.
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    expect(asked).toEqual([{ x: 3, y: 4 }]);
    expect(label().hidden).toBe(false);
    expect(label().textContent).toBe(LOOK_HINT);

    vi.advanceTimersByTime(LOOK_HINT_MS - LOOK_DEBOUNCE_MS - 1);
    expect(label().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(label().hidden).toBe(true);
  });

  it("lets an engine answer replace the hint, and the hint's timer leaves it alone", async () => {
    renderer.cell = { x: 3, y: 4 };
    canvas.emit("pointerenter", { clientX: 1, clientY: 1 });
    move(1, 1);
    vi.advanceTimersByTime(LOOK_DEBOUNCE_MS);
    answers[0]!("stairs down");
    await settle();
    expect(label().textContent).toBe("Stairs down");

    // The hint's own hide comes due here and must not take the answer with it.
    vi.advanceTimersByTime(LOOK_HINT_MS);
    expect(label().hidden).toBe(false);
    expect(label().textContent).toBe("Stairs down");
  });
});

describe("dispose", () => {
  it("unregisters its listeners and removes its element", () => {
    const el = label();
    hud.dispose();
    expect(el.removed).toBe(1);

    // Every constructor listener is gone: a pointermove after dispose rings
    // nothing and asks nothing.
    renderer.cell = { x: 3, y: 4 };
    move();
    expect(renderer.highlights).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });
});

// The browser gate must tell the hint apart from an engine's answer, and
// browser-check.mjs is plain .mjs — it cannot import this TypeScript module,
// so it carries a copy of the string. Guard the copy: a reworded hint that
// left the gate behind would quietly restore the hole the gate was widened to
// close, and nothing else would notice until a Module shipped unwired.
describe("the browser gate's copy of LOOK_HINT", () => {
  it("still matches the hint this module exports", async () => {
    const { readFile } = await import("node:fs/promises");
    const gate = await readFile(new URL("../dev/browser-check.mjs", import.meta.url), "utf8");
    expect(gate).toContain(`const LOOK_HINT = ${JSON.stringify(LOOK_HINT)};`);
  });
});

describe("lookLabel", () => {
  it("capitalizes the first letter and rewrites nothing else", () => {
    expect(lookLabel("dwarvish mattock")).toBe("Dwarvish mattock");
    expect(lookLabel("a scroll labeled ZELGO MER")).toBe("A scroll labeled ZELGO MER");
    expect(lookLabel("")).toBe("");
  });
});
