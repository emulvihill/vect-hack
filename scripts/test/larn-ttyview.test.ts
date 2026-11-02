// The Larn TtyView: input wiring (the two silent mistakes — a hard-coded
// blocking wait, and a queue the engine does not pull from), the Backplane
// notice as a message line (vect-hack-1g5), and the burst-coalesced redraw
// actually painting the grid — including the wipe erase, which is the event
// Larn's shim decodes from CL_LINE/CL_DOWN.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LarnEvent } from "../../src/modules/larn/protocol";
import { KC_ESCAPE } from "../../src/modules/larn/protocol";

/** Enough of an element for the stage, the map pre and the message list. */
class StubEl {
  id = "";
  textContent = "";
  innerHTML = "";
  children: StubEl[] = [];
  classList = { add() {} };
  appendChild(c: StubEl) { this.children.push(c); return c; }
}

const els = new Map<string, StubEl>();
let onKeydown: ((e: unknown) => void) | null = null;
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: (type: string, fn: (e: unknown) => void) => {
    if (type === "keydown") onKeydown = fn;
  },
} as unknown as Document;

// Imported after the stubs: the constructor grabs #stage and binds keydown.
const { TtyView } = await import("../../src/modules/larn/ui/TtyView");

const press = (key: string, shiftKey = false) =>
  onKeydown!({ key, shiftKey, preventDefault() {} });
const $map = () => els.get("stage")!.children[0]!;

describe("TtyView input wiring", () => {
  beforeEach(() => els.clear());

  it("passes wait through to the queue instead of always waiting", () => {
    // A hard-coded next(true) would answer a poll with a promise the engine
    // cannot consume synchronously.
    expect(new TtyView().nextKey(false, false)).toBeNull();
  });

  it("pushes only mapped keys into the queue the engine pulls from", () => {
    const view = new TtyView();
    press("Shift"); // mapKey returns null: nothing to queue
    press("j");
    expect(view.nextKey(false, false)).toEqual({ code: 0x6a, mods: 0 });
  });

  it("feeds a parked blocking wait from the same queue", async () => {
    const view = new TtyView();
    const pending = view.nextKey(true, false);
    expect(pending).toBeInstanceOf(Promise);
    press("Escape");
    await expect(pending).resolves.toEqual({ code: KC_ESCAPE, mods: 0 });
  });

  it("renders a Backplane notice as a message line", () => {
    new TtyView().onNotice("Larn exited — reload to restart.");
    expect(els.get("messages")!.children.map((c) => c.textContent))
      .toEqual(["Larn exited — reload to restart."]);
  });
});

describe("TtyView rendering", () => {
  beforeEach(() => {
    els.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ev = (e: LarnEvent) => e;

  it("paints text runs, the cursor cell, and wipe erasure after a burst", () => {
    const view = new TtyView();
    view.handle(ev({ name: "text", x: 0, y: 0, rgb: 0xcccccc, text: "Welcome to larn" }));
    // Cursor on its own row: a cursor inside the run would (correctly) split
    // the span and the contains-assertion below is about the run, not spans.
    view.handle(ev({ name: "curs", x: 0, y: 5 }));
    view.handle(ev({ name: "flush" }));
    vi.advanceTimersByTime(40); // the frame fallback timer fires the render
    expect($map().innerHTML).toContain("Welcome to larn");
    expect($map().innerHTML).toContain("cursor");

    // wipe must actually erase — the shim emits it for CL_LINE/CL_DOWN, and
    // a no-op here would leave a shorter message wearing the old one's tail.
    view.handle(ev({ name: "wipe", x: 7, y: 0, n: 73 }));
    vi.advanceTimersByTime(40);
    expect($map().innerHTML).toContain("Welcome");
    expect($map().innerHTML).not.toContain("Welcome to larn");
  });

  it("coalesces a burst behind one render gate", () => {
    const view = new TtyView();
    for (let x = 0; x < 40; x++)
      view.handle(ev({ name: "text", x, y: 3, rgb: 0xffffff, text: "#" }));
    // Nothing painted per event — the gate holds until the frame/timer race.
    expect($map().innerHTML).toBe("");
    vi.advanceTimersByTime(40);
    expect($map().innerHTML).toContain("########");
  });
});
