// Loadable keybindings (vect-hack-be3.5): a stored override merged over
// DEFAULT_BINDINGS. No editor UI to exercise here (declined 2026-07-29) — the
// acceptance criteria are all in this file instead: a stored override
// survives a reload and takes effect, a binding that shadows a NetHack
// command letter is refused, and clearing the override restores the
// defaults.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BINDINGS } from "../../src/modules/nethack/ui/moveKeys";
import {
  clearOverride, loadBindings, loadOverride, mergeBindings, parseOverride, saveOverride,
} from "../../src/modules/nethack/ui/keyBindings";

/** The "node" vitest environment has no browser localStorage, so this
 *  in-memory stand-in is swapped in as the global — the same way other
 *  suites in this project stub `document` rather than run under jsdom. */
class StubStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void { this.store.set(k, v); }
  removeItem(k: string): void { this.store.delete(k); }
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).localStorage = new StubStorage();
});

describe("parseOverride", () => {
  it("accepts a chord bound to a real action", () => {
    const { bindings, issues } = parseOverride({ "Alt+ArrowUp": "move-fwd" });
    expect(bindings).toEqual({ "Alt+ArrowUp": "move-fwd" });
    expect(issues).toEqual([]);
  });

  it("refuses an unknown action name", () => {
    const { bindings, issues } = parseOverride({ "Alt+w": "moonwalk" });
    expect(bindings).toEqual({});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.chord).toBe("Alt+w");
  });

  it("refuses a bare printable chord even with a valid action, since it would shadow a command letter", () => {
    // 'w' is NetHack's wield-weapon; DEFAULT_BINDINGS never binds a letter,
    // and neither should a loaded override.
    const { bindings, issues } = parseOverride({ "w": "move-fwd" });
    expect(bindings).toEqual({});
    expect(issues).toEqual([{ chord: "w", reason: expect.stringContaining("shadow") }]);
  });

  it("refuses a shifted bare letter the same way", () => {
    const { bindings, issues } = parseOverride({ "K": "run-fwd" });
    expect(bindings).toEqual({});
    expect(issues).toHaveLength(1);
  });

  it("refuses the same base letter whether held with Ctrl or Alt too, since those select a different live command rather than none (kick is Ctrl+d, chat is Alt+c)", () => {
    expect(parseOverride({ "Ctrl+d": "move-fwd" }).issues).toHaveLength(1);
    expect(parseOverride({ "Alt+c": "move-fwd" }).issues).toHaveLength(1);
  });

  it("leaves named-key chords alone, arrows and their Shift/Ctrl/Alt combinations", () => {
    const { bindings, issues } = parseOverride({
      "PageUp": "run-fwd", "Shift+ArrowLeft": "turn-left", "Ctrl+F2": "move-back",
    });
    expect(issues).toEqual([]);
    expect(Object.keys(bindings)).toHaveLength(3);
  });

  it("refuses a pointer-only action, which no key press could ever resolve", () => {
    // resolve() only answers the camera-relative actions; "attack" and its
    // kin need a target (resolveTarget), so a key bound to one would load
    // cleanly and then silently do nothing — the validator's whole job is
    // that nothing dead ever loads without a console report.
    const { bindings, issues } = parseOverride({ "Ctrl+F2": "attack" });
    expect(bindings).toEqual({});
    expect(issues).toEqual([{ chord: "Ctrl+F2", reason: expect.stringContaining("bindable") }]);
  });

  it("reports one entry's problem without dropping its sibling", () => {
    const { bindings, issues } = parseOverride({ "PageUp": "run-fwd", "w": "move-fwd" });
    expect(bindings).toEqual({ "PageUp": "run-fwd" });
    expect(issues).toHaveLength(1);
  });

  it("treats a non-object override as empty rather than throwing", () => {
    for (const raw of [null, "nope", 42, ["ArrowUp", "move-fwd"]]) {
      const { bindings, issues } = parseOverride(raw);
      expect(bindings).toEqual({});
      expect(issues).toHaveLength(1);
    }
  });

  it("treats an absent override as empty with nothing to report", () => {
    expect(parseOverride(undefined)).toEqual({ bindings: {}, issues: [] });
  });
});

describe("mergeBindings", () => {
  it("lets an override entry win over the default at the same chord", () => {
    const merged = mergeBindings({ "ArrowUp": "run-fwd" });
    expect(merged["ArrowUp"]).toBe("run-fwd");
  });

  it("passes every other default through untouched", () => {
    const merged = mergeBindings({ "ArrowUp": "run-fwd" });
    expect(merged["ArrowDown"]).toBe(DEFAULT_BINDINGS["ArrowDown"]);
    expect(merged["ArrowLeft"]).toBe(DEFAULT_BINDINGS["ArrowLeft"]);
    expect(merged["Shift+ArrowUp"]).toBe(DEFAULT_BINDINGS["Shift+ArrowUp"]);
  });

  it("adds a chord the defaults never bound at all", () => {
    const merged = mergeBindings({ "Alt+w": "move-fwd" });
    expect(merged["Alt+w"]).toBe("move-fwd");
    expect(merged["ArrowUp"]).toBe(DEFAULT_BINDINGS["ArrowUp"]); // untouched
  });

  it("with no override at all, matches DEFAULT_BINDINGS exactly", () => {
    expect(mergeBindings({})).toEqual(DEFAULT_BINDINGS);
  });
});

describe("loadBindings / saveOverride / clearOverride", () => {
  it("with nothing stored, loads exactly the defaults", () => {
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
  });

  it("a saved override survives a reload and takes effect over the default", () => {
    expect(saveOverride({ "Alt+ArrowUp": "move-fwd" })).toEqual([]);
    // A fresh call, as a reload would make: nothing carried over in memory.
    expect(loadBindings()).toEqual(mergeBindings({ "Alt+ArrowUp": "move-fwd" }));
  });

  it("refuses to persist an entry that would shadow a command letter", () => {
    const issues = saveOverride({ "w": "move-fwd" });
    expect(issues).toHaveLength(1);
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS); // never made it into storage
  });

  it("clearing the override restores the defaults on the next load", () => {
    saveOverride({ "Alt+ArrowUp": "move-fwd" });
    expect(loadBindings()).not.toEqual(DEFAULT_BINDINGS);
    clearOverride();
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
  });

  it("treats corrupt stored JSON as no override, not a crash", () => {
    localStorage.setItem("vect-hack/keybindings", "{not json");
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
    expect(loadOverride().issues).toHaveLength(1);
  });

  it("reports a refused entry to the console at load, since there is no editor UI to show it in", () => {
    saveOverride({ "Alt+ArrowUp": "move-fwd" });
    // Hand-edit storage past saveOverride's own check, the way a person
    // editing the blob by hand (the declined-UI path) could.
    localStorage.setItem("vect-hack/keybindings", JSON.stringify({ "w": "move-fwd" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("w");
    warn.mockRestore();
  });
});
