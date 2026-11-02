// TtyView's side of the Backplane input path. The queue mechanism is proven
// on its own (key-queue.test.ts); what is left is the wiring, where the two
// plausible mistakes are silent: nextKey hard-coding a blocking wait (the
// engine polls wait=false from its TERM_XTRA_FLUSH drain and would hang on a
// promise), and onKey pushing into a queue the engine does not pull from.
// Plus the Backplane notice, which must reach the player as a message line
// rather than the console (vect-hack-1g5).
import { beforeEach, describe, expect, it } from "vitest";

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
const { TtyView } = await import("../../src/modules/angband/ui/TtyView");

const press = (key: string) => onKeydown!({ key, preventDefault() {} });

describe("TtyView input wiring", () => {
  beforeEach(() => els.clear());

  it("passes wait through to the queue instead of always waiting", () => {
    // A hard-coded next(true) would answer this poll with a promise, and the
    // drain in main-wasm.c would never finish a lap.
    expect(new TtyView().nextKey(false, true)).toBeNull();
  });

  it("pushes only mapped keys into the queue the engine pulls from", () => {
    const view = new TtyView();
    press("Shift"); // mapKey returns null: nothing to queue
    press("j");
    expect(view.nextKey(false, false)).toEqual({ code: 0x6a, mods: 0 });
  });

  it("feeds a parked blocking wait from the same queue", async () => {
    const view = new TtyView();
    const pending = view.nextKey(true, true);
    expect(pending).toBeInstanceOf(Promise);
    press("Escape");
    await expect(pending).resolves.toEqual({ code: 0xe000, mods: 0 });
  });

  it("renders a Backplane notice as a message line", () => {
    new TtyView().onNotice("Angband exited — reload to restart.");
    expect(els.get("messages")!.children.map((c) => c.textContent))
      .toEqual(["Angband exited — reload to restart."]);
  });
});
