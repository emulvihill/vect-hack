// Cancelling the action menu by clicking elsewhere (vect-hack-9wt). The menu
// closes on the outside *pointerdown*, but the browser still delivers the
// paired *click* — and VectorView's canvas click handler would run
// primaryAction on whatever cell it landed on, so the documented "click
// elsewhere to cancel" gesture could attack a monster. TextHud therefore
// remembers that a pointerdown was spent dismissing the menu, and the click
// side asks-and-clears via consumeOutsideDismissal(). The flag is one-shot
// and scoped to that gesture: the next pointerdown clears it, so a stale
// dismissal can never swallow a later, deliberate click.
import { beforeEach, describe, expect, it } from "vitest";

/** Enough of an element for the message log, prompt line and overlay. */
class StubEl {
  textContent = "";
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  children: StubEl[] = [];
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { this.children.push(c); return c; }
  contains(n: unknown) { return n === this; }
  listeners = new Map<string, Set<(e: never) => void>>();
  addEventListener(t: string, fn: (e: never) => void) {
    const set = this.listeners.get(t) ?? new Set<(e: never) => void>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: (e: never) => void) { this.listeners.get(t)?.delete(fn); }
}

const els = new Map<string, StubEl>();
let onKey: (e: { key: string; ctrlKey?: boolean; preventDefault(): void }) => void;

// document routes by event type and honors `once`, since the dismissal flag
// clears itself with a once pointerdown listener registered mid-dismissal —
// which must NOT fire for the pointerdown being dispatched, matching the DOM
// rule that listeners added during dispatch wait for the next event.
type Entry = { fn: (e: never) => void; once: boolean };
const docListeners = new Map<string, Entry[]>();
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: (t: string, fn: (e: never) => void, opts?: boolean | { once?: boolean }) => {
    if (t === "keydown") { onKey = fn as typeof onKey; return; }
    const list = docListeners.get(t) ?? docListeners.set(t, []).get(t)!;
    list.push({ fn, once: typeof opts === "object" && !!opts.once });
  },
  removeEventListener: (t: string, fn: (e: never) => void) => {
    const list = docListeners.get(t);
    if (list) docListeners.set(t, list.filter((l) => l.fn !== fn));
  },
} as unknown as Document;

const pointerdown = (target: unknown) => {
  const list = [...(docListeners.get("pointerdown") ?? [])];
  docListeners.set("pointerdown", (docListeners.get("pointerdown") ?? []).filter((l) => !l.once));
  for (const l of list) l.fn({ target } as never);
};

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

const settle = () => new Promise((r) => setTimeout(r, 1)); // outside-click listener registers on a 0ms timer

describe("action menu outside-click dismissal", () => {
  let hud: InstanceType<typeof TextHud>;
  beforeEach(() => {
    els.clear();
    docListeners.clear();
    hud = new TextHud();
  });

  it("marks the gesture consumed exactly once when an outside pointerdown closes the menu", async () => {
    hud.showActionMenu([{ label: "kick", run: () => {} }]);
    await settle();
    pointerdown({}); // lands outside #overlay
    expect(els.get("overlay")!.hidden).toBe(true); // the menu did close
    expect(hud.consumeOutsideDismissal()).toBe(true); // the paired click must stand down
    expect(hud.consumeOutsideDismissal()).toBe(false); // one gesture, one veto
  });

  it("does not mark the gesture when Escape closes the menu", async () => {
    hud.showActionMenu([{ label: "kick", run: () => {} }]);
    await settle();
    onKey({ key: "Escape", preventDefault() {} });
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(hud.consumeOutsideDismissal()).toBe(false);
  });

  it("clears an unconsumed dismissal at the next pointerdown", async () => {
    hud.showActionMenu([{ label: "kick", run: () => {} }]);
    await settle();
    pointerdown({}); // dismissal whose paired click never reached the canvas
    pointerdown({}); // a fresh gesture
    expect(hud.consumeOutsideDismissal()).toBe(false);
  });
});
