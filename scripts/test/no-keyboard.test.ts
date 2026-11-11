// The phone visitor's explanation (vect-hack-d72).
//
// The load-bearing test is the predicate. `(pointer: coarse)` on its own is
// the tempting one-liner and it is wrong: a coarse pointer that can still
// hover is a cursor, and this notice covers the whole page, so a false
// positive locks a visitor out of a game they could play. The hoverableCoarse
// row below is the one that fails if the `hover` half is ever dropped.
//
// Everything else here is about not lying to the visitor: the demo offered has
// to be one that exists, and the page the button opens has to be the game
// rather than this notice again.
import { describe, expect, it } from "vitest";
import {
  DISMISS_BUTTON_ID, DISMISS_LABEL, NOTICE_ID, NOTICE_OFFER_ID,
  NOTICE_TEXT_ID, NO_KEYBOARD_NOTICE, SELF_PLAY_FLAG, WATCH_BUTTON_ID,
  WATCH_DEMO_NOTICE, demoRunning, installNoKeyboardNotice, isTouchOnly,
  watchDemoFor, watchDemoLabel, watchDemoSearch,
  type NoticeDocument, type NoticeElement, type PointerEnvironment,
} from "../../src/ui/noKeyboard";

const phone: PointerEnvironment = { coarsePointer: true, hoverless: true };
/** Also every laptop with a touchscreen: the primary pointer there is still
 *  the trackpad, so it reports a fine pointer and real hover however many
 *  fingers the panel accepts. */
const desktop: PointerEnvironment = { coarsePointer: false, hoverless: false };
/** The row that separates this test from the tempting one-liner: a coarse
 *  primary pointer that can still hover — a console or TV browser's cursor, a
 *  pen-first Windows device. `(pointer: coarse)` alone calls this a phone. */
const hoverableCoarse: PointerEnvironment = { coarsePointer: true, hoverless: false };

class FakeElement implements NoticeElement {
  hidden: boolean | string = true;
  textContent: string | null = null;
  private handlers: (() => void)[] = [];
  addEventListener(_type: "click", handler: () => void) { this.handlers.push(handler); }
  click() { for (const handler of this.handlers) handler(); }
}

class FakeDom implements NoticeDocument {
  readonly els = new Map<string, FakeElement>();
  constructor(ids: string[]) {
    for (const id of ids) this.els.set(id, new FakeElement());
  }
  getElementById(id: string) { return this.els.get(id) ?? null; }
  el(id: string) { return this.els.get(id)!; }
}

function install(overrides: Partial<Parameters<typeof installNoKeyboardNotice>[0]> = {}) {
  const dom = new FakeDom([
    NOTICE_ID, NOTICE_TEXT_ID, NOTICE_OFFER_ID, WATCH_BUTTON_ID, DISMISS_BUTTON_ID,
  ]);
  const went: string[] = [];
  installNoKeyboardNotice({
    game: "nethack",
    search: "?game=nethack",
    env: phone,
    dom,
    navigate: (search) => went.push(search),
    ...overrides,
  });
  return { dom, went };
}

describe("isTouchOnly", () => {
  it("is true only for a coarse pointer that cannot hover", () => {
    expect(isTouchOnly(phone)).toBe(true);
    expect(isTouchOnly(desktop)).toBe(false);
    // The one that a `(pointer: coarse)` test alone would get wrong.
    expect(isTouchOnly(hoverableCoarse)).toBe(false);
    expect(isTouchOnly({ coarsePointer: false, hoverless: true })).toBe(false);
  });
});

describe("which demo is offered", () => {
  it("offers each Module its own self-player where main.ts wires one", () => {
    // These have to keep agreeing with src/main.ts: ?bot builds BotPlayer and
    // LarnBotPlayer, ?borg hands Angband to the engine's own borg.
    expect(watchDemoFor("nethack")).toEqual({ game: "nethack", flag: "bot" });
    expect(watchDemoFor("larn")).toEqual({ game: "larn", flag: "bot" });
    expect(watchDemoFor("angband")).toEqual({ game: "angband", flag: "borg" });
  });

  it("offers a Module with no self-player no demo at all, never another game's", () => {
    // Moria has neither flag. Offering NetHack's demo there read as the site
    // opening the wrong game (vect-hack-s77l will give Moria its own).
    expect(SELF_PLAY_FLAG.moria).toBeUndefined();
    expect(watchDemoFor("moria")).toBeNull();
  });

  it("keeps every other flag on the way to the demo", () => {
    const search = watchDemoSearch("?game=larn&gl&skin=ghost", watchDemoFor("larn")!);
    const params = new URLSearchParams(search);
    expect(params.get("game")).toBe("larn");
    expect(params.has("bot")).toBe(true);
    // ?gl and ?skin were the visitor's, or the link sender's, to keep.
    expect(params.has("gl")).toBe(true);
    expect(params.get("skin")).toBe("ghost");
  });

  it("sets Angband's own flag, not ?bot", () => {
    const params = new URLSearchParams(watchDemoSearch("?game=angband", watchDemoFor("angband")!));
    expect(params.get("game")).toBe("angband");
    expect(params.has("borg")).toBe(true);
    expect(params.has("bot")).toBe(false);
    expect(watchDemoLabel(watchDemoFor("angband")!)).toBe("Watch Angband play itself");
  });
});

describe("a touch-only visitor", () => {
  it("gets the explanation, the offer, and a button that starts the demo", () => {
    const { dom, went } = install();

    expect(dom.el(NOTICE_ID).hidden).toBe(false);
    expect(dom.el(NOTICE_TEXT_ID).textContent).toBe(NO_KEYBOARD_NOTICE);
    expect(dom.el(NOTICE_OFFER_ID).textContent).toBe(WATCH_DEMO_NOTICE);
    expect(dom.el(WATCH_BUTTON_ID).textContent).toBe("Watch NetHack play itself");

    expect(dom.el(NOTICE_OFFER_ID).hidden).toBe(false);
    expect(dom.el(WATCH_BUTTON_ID).hidden).toBe(false);

    dom.el(WATCH_BUTTON_ID).click();
    expect(went).toEqual(["?game=nethack&bot="]);
  });

  it("on Moria gets the explanation and the way through, but no offer and no button", () => {
    const { dom, went } = install({ game: "moria", search: "?game=moria" });
    expect(dom.el(NOTICE_ID).hidden).toBe(false);
    expect(dom.el(NOTICE_TEXT_ID).textContent).toBe(NO_KEYBOARD_NOTICE);
    expect(dom.el(NOTICE_OFFER_ID).hidden).toBe(true);
    expect(dom.el(WATCH_BUTTON_ID).hidden).toBe(true);
    expect(dom.el(WATCH_BUTTON_ID).textContent).toBeNull();
    expect(dom.el(DISMISS_BUTTON_ID).textContent).toBe(DISMISS_LABEL);
    dom.el(WATCH_BUTTON_ID).click();
    expect(went).toEqual([]);
  });

  it("does not explain over the demo it just started", () => {
    // The button is the dismissal: the page it opens must show the game.
    const { dom } = install({ search: "?game=nethack&bot" });
    expect(dom.el(NOTICE_ID).hidden).toBe(true);
    expect(demoRunning("nethack", "?game=nethack&bot")).toBe(true);
    expect(demoRunning("angband", "?game=angband&borg")).toBe(true);
    // Moria has no self-player, so nothing about its URL counts as a demo.
    expect(demoRunning("moria", "?game=moria&bot")).toBe(false);
  });

  it("offers a way through for a tablet that does have a keyboard", () => {
    const { dom } = install({ game: "larn", search: "?game=larn" });
    expect(dom.el(DISMISS_BUTTON_ID).textContent).toBe(DISMISS_LABEL);
    dom.el(DISMISS_BUTTON_ID).click();
    expect(dom.el(NOTICE_ID).hidden).toBe(true);
  });
});

describe("a desktop visitor", () => {
  it("sees nothing new whatsoever", () => {
    for (const env of [desktop, hoverableCoarse]) {
      const { dom, went } = install({ env });
      expect(dom.el(NOTICE_ID).hidden).toBe(true);
      expect(dom.el(NOTICE_TEXT_ID).textContent).toBeNull();
      expect(dom.el(WATCH_BUTTON_ID).textContent).toBeNull();
      expect(went).toEqual([]);
    }
  });

  it("sees nothing when the browser cannot answer the queries at all", () => {
    // No matchMedia: this is an added explanation, never a gate the game has
    // to pass to boot.
    const { dom } = install({ env: null });
    expect(dom.el(NOTICE_ID).hidden).toBe(true);
  });
});

describe("the wording", () => {
  it("says what is missing and what to do, without apologising for it", () => {
    expect(NO_KEYBOARD_NOTICE).toMatch(/keyboard/i);
    expect(NO_KEYBOARD_NOTICE).toMatch(/computer/i);
    expect(NO_KEYBOARD_NOTICE).not.toMatch(/sorry|unfortunately|error|unsupported/i);
    expect(WATCH_DEMO_NOTICE).toMatch(/no keys/i);
  });
});
