// View teardown (vect-hack-a8r): every view binds keydown on `document`,
// which belongs to index.html and outlives it. Until dispose() existed the
// binding was an anonymous closure — un-removable by construction — so a
// second view meant every key was delivered twice, and the first view's
// parked nextKey stayed parked for the life of the page with the Backplane's
// dispatch awaiting it.
//
// A leak passes every test that does not look for it, so each Module gets
// three assertions and one of them is about the BUG: two views built without
// disposing the first must be shown taking the same key, or "the disposed one
// took nothing" would also pass on a build that never delivered anything.
//
// The DOM stub replays listeners rather than only recording them (the
// command-menu-ui.test.ts pattern): every assertion here is about what
// happens when a key is dispatched at the document both views are on.
import { beforeEach, describe, expect, it } from "vitest";

type Listener = (e: never) => void;

class StubEl {
  id = "";
  textContent = "";
  innerHTML = "";
  hidden = true;
  blurred = 0;
  children: StubEl[] = [];
  classList = { add() {}, remove() {} };
  dataset: Record<string, string> = {};
  listeners = new Map<string, Set<Listener>>();
  appendChild(c: StubEl) { this.children.push(c); return c; }
  blur() { this.blurred++; }
  remove() {}
  contains() { return true; }
  closest() { return null; }
  addEventListener(t: string, fn: Listener) {
    const set = this.listeners.get(t) ?? new Set<Listener>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn); }
  count(t: string) { return this.listeners.get(t)?.size ?? 0; }
}

const els = new Map<string, StubEl>();
const el = (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!;
const docListeners = new Map<string, Set<Listener>>();

(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => el(id),
  createElement: () => new StubEl(),
  addEventListener(t: string, fn: Listener) {
    const set = docListeners.get(t) ?? new Set<Listener>();
    docListeners.set(t, set).get(t)!.add(fn);
  },
  removeEventListener(t: string, fn: Listener) { docListeners.get(t)?.delete(fn); },
} as unknown as Document;

/** How many listeners of a type are on the document right now — the count a
 *  view that cannot unbind grows by one per construction. */
const bound = (type = "keydown") => docListeners.get(type)?.size ?? 0;

/** Dispatch one event at the document, to every listener registered for it,
 *  the way a real browser would. A copy of the set: a handler may unbind. */
const press = (key: string, extra: Record<string, unknown> = {}) => {
  const e = { key, preventDefault() {}, ...extra } as never;
  for (const fn of [...(docListeners.get("keydown") ?? [])]) fn(e);
};

/** Did the promise settle, or did the clock beat it? A test that simply
 *  awaits a never-settling promise HANGS the suite instead of failing it, so
 *  every waiter assertion here races a timer and asserts which one won. */
async function raceClock<T>(p: Promise<T>, ms = 50): Promise<{ won: "promise"; value: T } | { won: "timer" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<{ won: "timer" }>((r) => { timer = setTimeout(() => r({ won: "timer" }), ms); });
  const out = await Promise.race([p.then((value) => ({ won: "promise" as const, value })), clock]);
  clearTimeout(timer);
  return out;
}

// Imported after the stub: every constructor below reaches for #stage and
// binds keydown while the module is being evaluated by these lines.
const { TtyView: AngbandTty } = await import("../../src/modules/angband/ui/TtyView");
const { TtyView: LarnTty } = await import("../../src/modules/larn/ui/TtyView");
const { TtyView: MoriaTty } = await import("../../src/modules/moria/ui/TtyView");
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

beforeEach(() => {
  els.clear();
  docListeners.clear();
});

describe("Angband TtyView teardown", () => {
  it("delivers one key to BOTH views when neither is disposed — the leak this fixes", () => {
    const first = new AngbandTty();
    const second = new AngbandTty();
    expect(bound()).toBe(2);
    press("j");
    // One physical keypress, two engines fed. Without this assertion the
    // disposal test below would also pass on a view that never took a key.
    expect(first.nextKey(false, false)).toEqual({ code: 0x6a, mods: 0 });
    expect(second.nextKey(false, false)).toEqual({ code: 0x6a, mods: 0 });
  });

  it("takes nothing after dispose, and leaves the surviving view alone", () => {
    const first = new AngbandTty();
    const second = new AngbandTty();
    first.dispose();
    expect(bound()).toBe(1);
    press("j");
    expect(first.nextKey(false, false)).toBeNull();
    expect(second.nextKey(false, false)).toEqual({ code: 0x6a, mods: 0 });
  });

  it("settles a parked key wait rather than leaving the engine's dispatch awaiting it", async () => {
    const view = new AngbandTty();
    const parked = view.nextKey(true, true) as Promise<unknown>;
    expect(parked).toBeInstanceOf(Promise);
    view.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: null });
  });

  it("is idempotent: a second dispose unbinds nothing else", () => {
    const view = new AngbandTty();
    const other = new AngbandTty();
    view.dispose();
    view.dispose();
    expect(bound()).toBe(1);
    press("j");
    expect(other.nextKey(false, false)).toEqual({ code: 0x6a, mods: 0 });
  });
});

describe("Larn TtyView teardown", () => {
  it("delivers one key to BOTH views when neither is disposed — the leak this fixes", () => {
    const first = new LarnTty();
    const second = new LarnTty();
    expect(bound()).toBe(2);
    press("j");
    expect(first.nextKey(false, false)).not.toBeNull();
    expect(second.nextKey(false, false)).not.toBeNull();
  });

  it("takes nothing after dispose, and leaves the surviving view alone", () => {
    const first = new LarnTty();
    const second = new LarnTty();
    first.dispose();
    expect(bound()).toBe(1);
    press("j");
    expect(first.nextKey(false, false)).toBeNull();
    expect(second.nextKey(false, false)).not.toBeNull();
  });

  it("settles a parked key wait rather than leaving the engine's dispatch awaiting it", async () => {
    const view = new LarnTty();
    const parked = view.nextKey(true, true) as Promise<unknown>;
    expect(parked).toBeInstanceOf(Promise);
    view.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: null });
  });
});

describe("Moria TtyView teardown", () => {
  // This view already removed its listener; what it never did was release the
  // queue, so the parked wait outlived the listener that was its only feeder.
  it("delivers one key to BOTH views when neither is disposed — the leak this fixes", async () => {
    const first = new MoriaTty();
    const second = new MoriaTty();
    expect(bound()).toBe(2);
    const a = first.nextKey(true, "outer-command", "original");
    const b = second.nextKey(true, "outer-command", "original");
    press("j");
    await expect(a).resolves.toBe(0x6a);
    await expect(b).resolves.toBe(0x6a);
  });

  it("takes nothing after dispose, and leaves the surviving view alone", async () => {
    const first = new MoriaTty();
    const second = new MoriaTty();
    first.dispose();
    expect(bound()).toBe(1);
    press("j");
    expect(await first.nextKey(false, "poll", "original")).toBeNull();
    expect(await second.nextKey(false, "poll", "original")).toBe(0x6a);
  });

  it("settles a parked key wait rather than leaving the engine's dispatch awaiting it", async () => {
    const view = new MoriaTty();
    const parked = view.nextKey(true, "outer-command", "original");
    view.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: null });
  });
});

describe("NetHack TextHud teardown", () => {
  // The HUD is where NetHack's keydown and its KeyQueue live; VectorView and
  // DebugView each own one and hand their dispose on to it.
  it("delivers one key to BOTH huds when neither is disposed — the leak this fixes", async () => {
    const first = new TextHud();
    const second = new TextHud();
    expect(bound()).toBe(2);
    const a = first.handle({ name: "nhgetch" } as never) as Promise<number>;
    const b = second.handle({ name: "nhgetch" } as never) as Promise<number>;
    press("j");
    await expect(a).resolves.toBe(0x6a);
    await expect(b).resolves.toBe(0x6a);
  });

  it("unbinds all four of the listeners it put on page-owned nodes", () => {
    const hud = new TextHud();
    expect(bound()).toBe(1);
    expect(el("cmdbtn").count("click")).toBe(1);
    expect(el("prompt").count("click")).toBe(1);
    expect(el("overlay").count("click")).toBe(1);
    hud.dispose();
    expect(bound()).toBe(0);
    expect(el("cmdbtn").count("click")).toBe(0);
    expect(el("prompt").count("click")).toBe(0);
    expect(el("overlay").count("click")).toBe(0);
  });

  it("takes nothing after dispose, and leaves the surviving hud alone", async () => {
    const first = new TextHud();
    const second = new TextHud();
    const survivor = second.handle({ name: "nhgetch" } as never) as Promise<number>;
    first.dispose();
    expect(bound()).toBe(1);
    press("j");
    await expect(survivor).resolves.toBe(0x6a);
    // Nothing was buffered for the disposed hud either: cancel() empties it.
    const after = first.handle({ name: "nhgetch" } as never) as Promise<number>;
    expect(await raceClock(after)).toEqual({ won: "promise", value: 27 });
  });

  it("settles a parked read with ESC, not with the display-error throw", async () => {
    // readKey() throws on a null blocking read, and that throw is caught by
    // EngineSession's dispatch guard (vect-hack-1g5/c1w), which posts a
    // fallback reply AND tells the player a display error cancelled their
    // action. A deliberate teardown is not a display error, so the cancelled
    // queue answers ESC — the same value nethackFallback posts for a key
    // wait — and the guard keeps meaning what it says.
    const hud = new TextHud();
    const parked = hud.handle({ name: "nhgetch" } as never) as Promise<number>;
    hud.dispose();
    expect(await raceClock(parked)).toEqual({ won: "promise", value: 27 });
  });
});
