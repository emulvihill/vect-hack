// The one place a key code is written down. The chord serializer is the format
// a future saved keybinding config has to agree with, so its rules are pinned
// here rather than left to whatever the lookup happened to do.
import { describe, expect, it } from "vitest";
import { BACKSPACE, CR, DIRECTIONS, ESC, SPACE, chord, ctrl, key, meta, shadowsCommand } from "../../src/modules/nethack/ui/keys";

/** Enough of a KeyboardEvent for chord(); the rest is never read. */
const ev = (k: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("key codes", () => {
  it("names the characters NetHack expects", () => {
    expect(key("k")).toBe(107);
    expect(key("h")).toBe(104);
    expect(ESC).toBe(27);
    expect(CR).toBe(13);
    expect(SPACE).toBe(32);
    expect(BACKSPACE).toBe(8);
  });

  it("folds control characters the way the tty does", () => {
    expect(ctrl("d")).toBe(4);
    expect(ctrl("a")).toBe(1);
  });

  it("folds meta characters the way NetHack's M() macro does (include/micro.h)", () => {
    expect(meta("c")).toBe(227); // chat's only compiled-in key (src/cmd.c)
    expect(meta("5")).toBe(0xb5);
  });

  it("orders the eight directions clockwise from north", () => {
    expect([...DIRECTIONS]).toEqual(["k", "u", "l", "n", "j", "b", "h", "y"]);
  });
});

describe("chord", () => {
  it("passes a bare key through", () => {
    expect(chord(ev("ArrowUp"))).toBe("ArrowUp");
  });

  it("prefixes modifiers in a fixed order", () => {
    expect(chord(ev("ArrowUp", { shiftKey: true }))).toBe("Shift+ArrowUp");
    expect(chord(ev("ArrowUp", { ctrlKey: true, altKey: true, shiftKey: true })))
      .toBe("Ctrl+Alt+Shift+ArrowUp");
  });

  it("does not double-encode shift on a printable key", () => {
    // The browser already reports the shifted character, so "Shift+K" and "K"
    // would be two names for one keystroke. Only named keys take the prefix.
    expect(chord(ev("K", { shiftKey: true }))).toBe("K");
    expect(chord(ev("d", { ctrlKey: true }))).toBe("Ctrl+d");
  });

  it("preserves NetHack's existing treatment of the browser meta modifier", () => {
    expect(chord({ ...ev("ArrowUp"), metaKey: true })).toBe("ArrowUp");
  });
});

describe("shadowsCommand", () => {
  it("flags a bare letter, exactly the shape a NetHack command letter takes", () => {
    expect(shadowsCommand("w")).toBe(true);
    expect(shadowsCommand("K")).toBe(true); // the shifted form is just as bare
    expect(shadowsCommand("$")).toBe(true);
    expect(shadowsCommand("5")).toBe(true);
  });

  it("still flags the same base letter once Ctrl or Alt is added — those chords select a different live command, not no command", () => {
    expect(shadowsCommand("Ctrl+w")).toBe(true);
    expect(shadowsCommand("Alt+w")).toBe(true);
    expect(shadowsCommand("Ctrl+Alt+w")).toBe(true);
    expect(shadowsCommand("Ctrl+d")).toBe(true); // kick
    expect(shadowsCommand("Alt+c")).toBe(true); // chat, meta("c")
  });

  it("never flags a named key, with or without modifiers, since it has no bare-letter meaning", () => {
    expect(shadowsCommand("ArrowUp")).toBe(false);
    expect(shadowsCommand("Shift+ArrowUp")).toBe(false);
    expect(shadowsCommand("F2")).toBe(false);
    expect(shadowsCommand("Ctrl+F2")).toBe(false);
  });
});
