import { describe, expect, it } from "vitest";
import { mapKey } from "../../src/modules/moria/keys";

const key = (key: string, more: Record<string, unknown> = {}) => ({ key, ...more });

describe("Moria byte keys", () => {
  it("maps literal Latin-1, controls and named tty keys", () => {
    expect(mapKey(key("a"), "literal", "original")).toBe(0x61);
    expect(mapKey(key("é"), "literal", "original")).toBe(0xe9);
    expect(mapKey(key("@", { ctrlKey: true }), "literal", "original")).toBe(0);
    expect(mapKey(key("r", { ctrlKey: true }), "literal", "original")).toBe(18);
    expect(mapKey(key("Enter"), "literal", "original")).toBe(13);
    expect(mapKey(key("Escape"), "literal", "original")).toBe(27);
    expect(mapKey(key("Tab"), "literal", "original")).toBe(9);
    expect(mapKey(key("Backspace"), "literal", "original")).toBe(127);
    expect(mapKey(key("Delete"), "literal", "original")).toBe(127);
  });

  it("rejects browser chrome and non-byte input", () => {
    expect(mapKey(key("F2"), "outer-command", "original")).toBeNull();
    expect(mapKey(key("Shift"), "literal", "original")).toBeNull();
    expect(mapKey(key("𝔸"), "literal", "original")).toBeNull();
    expect(mapKey(key("x", { altKey: true }), "literal", "original")).toBeNull();
    expect(mapKey(key("x", { metaKey: true }), "literal", "original")).toBeNull();
  });

  it("maps compass keys only for outer commands in the live key mode", () => {
    expect(mapKey(key("ArrowUp"), "literal", "original")).toBeNull();
    expect(mapKey(key("ArrowUp"), "poll", "original")).toBeNull();
    expect(mapKey(key("ArrowUp"), "outer-command", "original")).toBe("8".charCodeAt(0));
    expect(mapKey(key("ArrowUp"), "outer-command", "roguelike")).toBe("k".charCodeAt(0));
    expect(mapKey(key("Home"), "outer-command", "original")).toBe("7".charCodeAt(0));
    expect(mapKey(key("PageDown"), "outer-command", "roguelike")).toBe("n".charCodeAt(0));
    expect(mapKey(key("Clear"), "outer-command", "original")).toBe("5".charCodeAt(0));
    expect(mapKey(key("Clear"), "outer-command", "roguelike")).toBe(".".charCodeAt(0));
  });

  it("distinguishes NumLock-on keypad movement from top-row count digits", () => {
    const numpad8 = key("8", { code: "Numpad8", location: 3 });
    expect(mapKey(numpad8, "outer-command", "original")).toBe("8".charCodeAt(0));
    expect(mapKey(numpad8, "outer-command", "roguelike")).toBe("k".charCodeAt(0));
    expect(mapKey(numpad8, "literal", "roguelike")).toBe("8".charCodeAt(0));
    expect(mapKey(key("8", { code: "Digit8", location: 0 }), "outer-command", "roguelike"))
      .toBe("8".charCodeAt(0));
  });

  it("accepts only printable unmodified Latin-1 bytes", () => {
    expect(mapKey(key("\u0001"), "literal", "original")).toBeNull();
    expect(mapKey(key("\u0085"), "literal", "original")).toBeNull();
    expect(mapKey(key(" "), "literal", "original")).toBe(32);
    expect(mapKey(key("\u00ff"), "literal", "original")).toBe(255);
  });
});
