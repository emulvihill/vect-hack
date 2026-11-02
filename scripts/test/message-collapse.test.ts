// vect-hack-5rt: farlook autodescribe, the "Count: N" echo, and a repeated
// "It's a wall." each used to append a fresh #messages line per repetition —
// tty overwrites its one message line instead. NetHack marks the first two as
// ATR_NOHISTORY (doc/window.txt: "avoid putting message into recall history";
// src/getpos.c:652 and src/cmd.c:5106), which reaches putstr's attr already —
// TextHud.message() just wasn't reading it. This pins the resulting
// replace/collapse rules in isolation; see the header on message() itself for
// why they're shaped this way.
//
// A verbatim repeat of a *real* message (two combat rounds both landing
// "You hit it!") collapses too, but as a "(xN)" counter rather than a bare
// overwrite — each repeat is a distinct event, so the fix that stopped the
// spam must not also silently drop one from history. clear_nhwindow resets
// the collapse state, since a stale lastLine would otherwise let a window
// clear drive the next message's collapse decision — and, once cnt > 9,
// NetHack clears WIN_MESSAGE before every "Count: N" (src/cmd.c:5106), so a
// reset that only nulled lastLine without removing its element left one
// stale line behind per digit. Real messages are left in the DOM across a
// clear; only a transient line's element comes out with it.
import { beforeEach, describe, expect, it } from "vitest";

/** Enough of an element for the message log. */
class StubEl {
  textContent = "";
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  children: StubEl[] = [];
  parent: StubEl | null = null;
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { c.parent = this; this.children.push(c); return c; }
  // clear_nhwindow removes a transient line by calling .remove() on the
  // element itself (Element.prototype.remove), not through the parent.
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  addEventListener() {}
  removeEventListener() {}
  blur() {}
}

const els = new Map<string, StubEl>();

(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: () => {},
} as unknown as Document;

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

// The subset of js_constants_init()'s WIN_TYPE/ATTR groups this file needs
// (src/modules/nethack/ui/TextHud.ts's onReady(), sys/libnh/libnhmain.c).
const WIN_TYPE = { NHW_MESSAGE: 1 };
const ATTR = { ATR_NONE: 0, ATR_NOHISTORY: 32 };

const messages = () => els.get("messages")!.children.map((c) => c.textContent);

describe("message() collapse/replace", () => {
  let hud: InstanceType<typeof TextHud>;
  let win: number;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
    hud.onReady({ WIN_TYPE, ATTR });
    win = hud.handle({ name: "create_nhwindow", wintype: WIN_TYPE.NHW_MESSAGE }) as number;
  });

  const putstr = (text: string, attr = ATTR.ATR_NONE) =>
    hud.handle({ name: "putstr", win, attr, text });

  it("appends distinct plain messages as separate history lines", () => {
    putstr("You hit the jackal.");
    putstr("The jackal misses you.");
    expect(messages()).toEqual(["You hit the jackal.", "The jackal misses you."]);
  });

  it("collapses a repeated identical message onto one line with a running count", () => {
    putstr("It's a wall.");
    putstr("It's a wall.");
    putstr("It's a wall.");
    expect(messages()).toEqual(["It's a wall. (x3)"]);
  });

  it("increments the count in place rather than dropping a repeated real event", () => {
    putstr("You hit it!");
    expect(messages()).toEqual(["You hit it!"]);
    putstr("You hit it!");
    expect(messages()).toEqual(["You hit it! (x2)"]);
    putstr("You hit it!");
    expect(messages()).toEqual(["You hit it! (x3)"]);
  });

  it("compares against the base text, not the rendered '(xN)' suffix", () => {
    putstr("You hit it!");
    putstr("You hit it!"); // now showing "You hit it! (x2)"
    // If the next repeat compared against the rendered text ("You hit it!
    // (x2)") instead of the base text NetHack actually sent, this would fail
    // to match and start a new line instead of continuing the count.
    putstr("You hit it!");
    expect(messages()).toEqual(["You hit it! (x3)"]);
  });

  it("does not collapse a repeat separated by a different message", () => {
    putstr("It's a wall.");
    putstr("You are hungry.");
    putstr("It's a wall.");
    expect(messages()).toEqual(["It's a wall.", "You are hungry.", "It's a wall."]);
  });

  it("replaces rather than appends across a run of farlook autodescribe steps", () => {
    putstr("floor of a room.", ATTR.ATR_NOHISTORY);
    putstr("a wall.", ATTR.ATR_NOHISTORY);
    putstr("an altar.", ATTR.ATR_NOHISTORY);
    expect(messages()).toEqual(["an altar."]);
  });

  it("replaces rather than appends across a Count: prefix run", () => {
    putstr("Count: 1", ATTR.ATR_NOHISTORY);
    putstr("Count: 12", ATTR.ATR_NOHISTORY);
    putstr("Count: 123", ATTR.ATR_NOHISTORY);
    expect(messages()).toEqual(["Count: 123"]);
  });

  it("starts its own line rather than clobbering the preceding real message", () => {
    putstr("You hit the wall.");
    putstr("Count: 1", ATTR.ATR_NOHISTORY);
    expect(messages()).toEqual(["You hit the wall.", "Count: 1"]);
  });

  it("lets a real message following a transient streak overwrite it, not stack under it", () => {
    putstr("Count: 1", ATTR.ATR_NOHISTORY);
    putstr("Count: 12", ATTR.ATR_NOHISTORY);
    putstr("You find a trap!");
    expect(messages()).toEqual(["You find a trap!"]);
  });

  it("resets the collapse state on clear_nhwindow, so a stale lastLine can't merge across it", () => {
    putstr("It's a wall.");
    hud.handle({ name: "clear_nhwindow", win });
    putstr("It's a wall.");
    expect(messages()).toEqual(["It's a wall.", "It's a wall."]);
  });

  it("collapses a Count: prefix run across the clear_nhwindow NetHack sends between digits", () => {
    // src/cmd.c:5106: once cnt > 9, NetHack clears WIN_MESSAGE before every
    // subsequent "Count: N" — the real sequence interleaves a clear per
    // digit, unlike the back-to-back putstrs the earlier run simulates. A
    // clear that merely nulled lastLine without removing its element would
    // leave the previous digit's line behind, appending one line per digit.
    putstr("Count: 1", ATTR.ATR_NOHISTORY);
    hud.handle({ name: "clear_nhwindow", win });
    putstr("Count: 12", ATTR.ATR_NOHISTORY);
    hud.handle({ name: "clear_nhwindow", win });
    putstr("Count: 123", ATTR.ATR_NOHISTORY);
    expect(messages()).toEqual(["Count: 123"]);
  });

  it("does not remove a non-transient last line on clear_nhwindow", () => {
    putstr("You hit the wall.");
    hud.handle({ name: "clear_nhwindow", win });
    expect(messages()).toEqual(["You hit the wall."]);
  });
});
