// #overlay has two independent owners (vect-hack-be3 review): a real
// NetHack window (showOverlay/runMenu, driven off the engine's own awaited
// promises) and the pointer's action menu (showActionMenu, opened any time a
// right click lands). Nothing else keeps the two from stomping on each
// other — an engine window taking over must close a live action menu out
// (not just draw over it, or `onKey` still routes every key but Escape to
// the dead action menu), and a stale action-menu teardown (an outside click
// queued before an engine window took over) must not blank what replaced it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemData } from "../../src/modules/nethack/protocol";

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
  listeners = new Map<string, Set<(e: never) => void>>();
  addEventListener(t: string, fn: (e: never) => void) {
    const set = this.listeners.get(t) ?? new Set<(e: never) => void>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: (e: never) => void) { this.listeners.get(t)?.delete(fn); }
  emit(t: string, e: unknown) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e as never); }
}

const els = new Map<string, StubEl>();
let onKey: (e: { key: string; ctrlKey?: boolean; preventDefault(): void }) => void;

// Routes by event type, unlike the single-slot stand-ins in the sibling test
// files — showActionMenu registers a "pointerdown" listener on `document`
// alongside TextHud's own "keydown" one, and a stub that just remembers
// whichever handler registered last would let the former clobber `press()`.
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: (t: string, fn: (e: never) => void) => {
    if (t === "keydown") onKey = fn as typeof onKey;
  },
  removeEventListener: () => {},
} as unknown as Document;

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

const press = (key: string) => onKey({ key, preventDefault() {} });

/** Keydowns whose own key is a modifier — every name a keyboard can send on
 *  its own, not just the four TextHud used to name (vect-hack-ca5). */
const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "CapsLock",
  "AltGraph", "NumLock", "ScrollLock", "Fn"];

const item = (identifier: number, text: string, over: Partial<MenuItemData> = {}): MenuItemData =>
  ({ identifier, accelerator: "", groupAccel: "", attr: 0, color: 7, text, itemflags: 0, glyph: null, ...over });

describe("#overlay ownership arbitration", () => {
  let hud: InstanceType<typeof TextHud>;
  const WIN = 1;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  /** Everything still sitting in the key queue: a keystroke an overlay should
   *  have consumed shows up here as a live command byte instead. */
  const queued = () => {
    const keys = (hud as unknown as { keys: { next(wait: boolean): number | null } }).keys;
    const out: number[] = [];
    for (let k = keys.next(false); k !== null; k = keys.next(false)) out.push(k);
    return out;
  };

  /** Wires start_menu, one add_menu per item and end_menu, then opens it
   *  with select_menu — same shape as menu.test.ts's helper. */
  function openMenu(items: MenuItemData[], how: number, prompt = "") {
    hud.handle({ name: "start_menu", win: WIN, mbehavior: 0 } as never);
    for (const it of items) hud.handle({ name: "add_menu", win: WIN, item: it } as never);
    hud.handle({ name: "end_menu", win: WIN, prompt } as never);
    return hud.handle({ name: "select_menu", win: WIN, how } as never) as Promise<unknown>;
  }

  it("a real menu opening while the action menu is up closes the action menu, so keys reach the menu instead of being swallowed", async () => {
    hud.showActionMenu([{ label: "Attack", run: () => {} }]);
    expect((hud as unknown as { actionMenu: unknown }).actionMenu).not.toBeNull();

    const answer = openMenu([item(101, "a dagger")], 1); // PICK_ONE
    // onKey's `if (this.actionMenu) { ...; return; }` branch would otherwise
    // swallow every key but Escape here, and the engine's own prompt would
    // never see an answer.
    expect((hud as unknown as { actionMenu: unknown }).actionMenu).toBeNull();
    press("a"); // sole item, so runMenu assigns it "a"
    expect(await answer).toEqual({ picks: [{ identifier: 101, count: -1, itemflags: 0 }] });
  });

  it("a stale action-menu close (an outside click queued before a real menu took over) does not blank the menu that replaced it", async () => {
    hud.showActionMenu([{ label: "Attack", run: () => {} }]);
    const stale = (hud as unknown as { actionMenu: { close: () => void } }).actionMenu!.close;
    const overlay = els.get("overlay")!;
    expect(overlay.hidden).toBe(false);
    const actionMenuHtml = overlay.innerHTML;
    expect(actionMenuHtml).not.toBe("");

    const answer = openMenu([item(101, "a dagger")], 1);
    const menuHtml = overlay.innerHTML;
    expect(menuHtml).not.toBe(actionMenuHtml); // the real menu redrew #overlay

    stale(); // the outside-click handler firing late, after losing the floor

    expect(overlay.hidden).toBe(false); // not blanked out from under the menu
    expect(overlay.innerHTML).toBe(menuHtml); // still exactly what runMenu drew
    press("a");
    expect(await answer).toEqual({ picks: [{ identifier: 101, count: -1, itemflags: 0 }] });
  });

  it("a click on a blocking overlay dismisses it — the pointer's 'press any key'", async () => {
    // Half the command menu (help, discoveries, the dungeon overview) ends in
    // a blocking text window; without this, every one of them dead-ends a
    // pointer-only player at a keyboard-only wait.
    const done = (hud as unknown as { showOverlay(html: string, blocking: boolean): Promise<unknown> })
      .showOverlay("<div>Weapons are wielded with w.</div>", true);
    const overlay = els.get("overlay")!;
    expect(overlay.hidden).toBe(false);
    expect(overlay.innerHTML).toContain("click, or press any key");
    overlay.emit("click", {});
    expect(await done).toBeUndefined();
    expect(overlay.hidden).toBe(true);
  });

  it("a bare modifier keydown is not the 'any key' a blocking overlay waits for", async () => {
    // vect-hack-ca5: typing a capital over a blocking window sends the Shift
    // as its own keydown first. Dismissing on it hides the window the player
    // is still reading and hands the letter it belongs to straight to the
    // command loop.
    const done = (hud as unknown as { showOverlay(html: string, blocking: boolean): Promise<unknown> })
      .showOverlay("<div>Weapons are wielded with w.</div>", true);
    const overlay = els.get("overlay")!;
    for (const mod of MODIFIERS) press(mod);
    expect(overlay.hidden).toBe(false); // still up
    press("Z");
    expect(await done).toBeUndefined();
    expect(overlay.hidden).toBe(true);
    expect(queued()).toEqual([]); // the Z was the dismissal, not a spellcast
  });

  it("that dismiss listener stands down while a real menu owns #overlay", async () => {
    // runMenu parks its answer on the same overlayDone slot a blocking
    // overlay uses; a stray click on menu padding must not resolve it with
    // "dismissed" out from under the engine's select_menu.
    const answer = openMenu([item(101, "a dagger")], 1); // PICK_ONE
    const overlay = els.get("overlay")!;
    overlay.emit("click", { target: { closest: () => null } }); // hits no row
    expect(overlay.hidden).toBe(false); // still the menu's
    press("a");
    expect(await answer).toEqual({ picks: [{ identifier: 101, count: -1, itemflags: 0 }] });
  });

  it("a transient overlay's auto-hide timer does not wipe an action menu opened during its window", () => {
    vi.useFakeTimers();
    try {
      // display_nhwindow with blocking=false: showOverlay's own 1500ms
      // self-dismiss timer starts here.
      (hud as unknown as { showOverlay(html: string, blocking: boolean): unknown })
        .showOverlay("<div>Welcome to NetHack!</div>", false);
      const overlay = els.get("overlay")!;
      expect(overlay.hidden).toBe(false);

      hud.showActionMenu([{ label: "Kick door", run: () => {} }]);
      const actionMenuHtml = overlay.innerHTML;
      expect(actionMenuHtml).not.toBe("");

      vi.advanceTimersByTime(1500); // the transient overlay's timer fires here

      // The action menu opened after the transient overlay claimed #overlay,
      // so its timer's stale token check must skip the blank.
      expect(overlay.hidden).toBe(false);
      expect(overlay.innerHTML).toBe(actionMenuHtml);
    } finally {
      vi.useRealTimers();
    }
  });
});
