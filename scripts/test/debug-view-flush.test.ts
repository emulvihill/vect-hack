// DebugView redraw scheduling (vect-hack-r05). Redraws coalesce with a
// microtask — rAF stalls in hidden panes, which is why the microtask exists
// (see scheduleFlush's doc comment) — so a rAF loop on top of it is pure
// liability: a tail requestAnimationFrame(() => this.flush()) makes every
// flush entry spawn one more perpetual per-frame callback, and DebugView is
// the shipped no-GPU fallback, so a long tty session accumulates thousands.
// The view must never touch requestAnimationFrame at all.
import { beforeEach, describe, expect, it } from "vitest";

/** Enough of an element for the HUD chrome, the stage and the map pre. */
class StubEl {
  id = "";
  textContent = "";
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  children: StubEl[] = [];
  classList = { add() {} };
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { this.children.push(c); return c; }
  addEventListener() {}
  removeEventListener() {}
}

const els = new Map<string, StubEl>();
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as Document;

let rafCalls = 0;
(globalThis as Record<string, unknown>).requestAnimationFrame = () => {
  rafCalls++;
  return rafCalls;
};

// Imported after the stubs: the constructor grabs #stage and builds the HUD.
const { DebugView } = await import("../../src/modules/nethack/ui/DebugView");

const glyph = (view: InstanceType<typeof DebugView>, x: number, y: number, ch: string) =>
  view.handle({ name: "print_glyph", win: 3, x, y, cell: { ch, color: 7 } } as never);

describe("DebugView redraw scheduling", () => {
  beforeEach(() => {
    els.clear();
    rafCalls = 0;
  });

  it("redraws a dirty map on a microtask", async () => {
    const view = new DebugView();
    glyph(view, 4, 2, "@");
    await Promise.resolve(); // the queued flush runs before this resumes
    const $map = els.get("stage")!.children[0]!; // the created <pre id="map">
    expect($map.innerHTML).toContain("@");
  });

  it("never schedules an animation frame, even across many dirty periods", async () => {
    const view = new DebugView();
    for (let turn = 0; turn < 5; turn++) {
      glyph(view, turn, 1, String(turn));
      await Promise.resolve();
    }
    expect(rafCalls).toBe(0);
  });
});
