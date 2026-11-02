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

// document routes keydown to the handler these tests press through, and just
// records the rest so TextHud can register and dispose its outside-click
// listeners without throwing. Nothing here dispatches a pointerdown: the
// outside-click dismissal, and the `once` semantics its one-shot flag relies
// on, are action-menu-cancel.test.ts's subject, not this file's.
const docListeners = new Map<string, ((e: never) => void)[]>();
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: (t: string, fn: (e: never) => void) => {
    if (t === "keydown") { onKey = fn as typeof onKey; return; }
    docListeners.set(t, [...(docListeners.get(t) ?? []), fn]);
  },
  removeEventListener: (t: string, fn: (e: never) => void) => {
    const list = docListeners.get(t);
    if (list) docListeners.set(t, list.filter((l) => l !== fn));
  },
} as unknown as Document;

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

import type { ShimEvent } from "../../src/modules/nethack/protocol";

const press = (keyName: string) => onKey({ key: keyName, preventDefault() {} });

describe("pass-through stand-on menu", () => {
  let hud: InstanceType<typeof TextHud>;
  beforeEach(() => {
    els.clear();
    docListeners.clear();
    hud = new TextHud();
  });

  it("closes on any key and lets that key reach the game", async () => {
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    const pending = hud.handle({ name: "nhgetch" } as ShimEvent) as Promise<number>;
    press("j");
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(await pending).toBe("j".charCodeAt(0));
  });

  it("closes on Escape without leaking it to the game", async () => {
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    press("Escape");
    expect(els.get("overlay")!.hidden).toBe(true);
    const pending = hud.handle({ name: "nhgetch" } as ShimEvent) as Promise<number>;
    press("j"); // the queue must be empty of any ESC — the next key is this one
    expect(await pending).toBe("j".charCodeAt(0));
  });

  it("leaves the menu up for a bare modifier keydown, and still closes on the key it's paired with", async () => {
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    press("Shift"); // the Shift that starts a "<" arrives as its own keydown first
    expect(els.get("overlay")!.hidden).toBe(false);
    const pending = hud.handle({ name: "nhgetch" } as ShimEvent) as Promise<number>;
    press("j");
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(await pending).toBe("j".charCodeAt(0));
  });

  it("refuses to auto-open while a real prompt is blocking on an answer", async () => {
    // yn_function, not getlin: getlin's #linein is a real <input> the stub
    // DOM doesn't model (no .focus()), but any prompting counts the same way
    // for busyWithPrompt — this is the shape the sibling tests use to stage
    // one (see action-menu-cancel.test.ts).
    const answer = hud.handle({ name: "yn_function", query: "Really quit?", choices: "yn", def: "n".charCodeAt(0) } as ShimEvent) as Promise<number>;
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    expect(els.get("overlay")!.hidden).toBe(true);
    // Tear the prompt down cleanly so it doesn't leak into the next test.
    press("n");
    expect(await answer).toBe("n".charCodeAt(0));
  });

  it("still swallows keys behind a player-opened (modal) menu", async () => {
    hud.showActionMenu([{ label: "Kick", run: () => {} }]);
    press("j");
    expect(els.get("overlay")!.hidden).toBe(false);
    press("Escape");
    expect(els.get("overlay")!.hidden).toBe(true);
  });

  it("never replaces a menu that is already up", () => {
    let clicked = "";
    hud.showActionMenu([{ label: "Kick", run: () => { clicked = "kick"; } }]);
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    expect(els.get("overlay")!.innerHTML).toContain("Kick");
    expect(els.get("overlay")!.innerHTML).not.toContain("Pick up");
    void clicked;
  });

  it("refuses to auto-open over a live transient overlay, leaving it to its own timer", () => {
    // display_nhwindow with blocking=false: showOverlay's non-blocking path.
    // Nothing is parked on a promise here, so busyWithPrompt alone wouldn't
    // catch this — the passthrough guard has to check overlayOwner too.
    (hud as unknown as { showOverlay(html: string, blocking: boolean): unknown })
      .showOverlay("<div>Welcome to NetHack!</div>", false);
    const overlayHtml = els.get("overlay")!.innerHTML;
    expect(els.get("overlay")!.hidden).toBe(false);

    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    expect(els.get("overlay")!.innerHTML).toBe(overlayHtml); // untouched
  });

  it("reports every message through onMessage", () => {
    const seen: string[] = [];
    hud.onMessage = (t) => seen.push(t);
    hud.message("You see here a long sword.");
    expect(seen).toEqual(["You see here a long sword."]);
  });
});
