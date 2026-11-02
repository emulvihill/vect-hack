import { describe, expect, it } from "vitest";
import { STEP, STEP_OF, chord, compass, dirTo, resolve } from "../../src/ui/gaze";

const ev = (key: string, mods: Partial<Pick<KeyboardEvent,
  "ctrlKey" | "shiftKey" | "altKey" | "metaKey">> = {}) => ({
  key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods,
});

describe("shared gaze arithmetic", () => {
  it("numbers all eight headings clockwise from north", () => {
    for (let i = 0; i < 8; i++) expect(compass(-i * STEP)).toBe(i);
  });

  it("rounds a free camera heading to the nearest compass eighth", () => {
    expect(compass(-STEP / 2 + 0.01)).toBe(0);
    expect(compass(-STEP / 2 - 0.01)).toBe(1);
    expect(compass(2 * Math.PI)).toBe(0);
  });

  it("maps exactly the eight adjacent cell deltas", () => {
    expect(STEP_OF).toEqual([
      [0, -1], [1, -1], [1, 0], [1, 1],
      [0, 1], [-1, 1], [-1, 0], [-1, -1],
    ]);
    STEP_OF.forEach(([dx, dy], index) => expect(dirTo(dx, dy)).toBe(index));
    expect(dirTo(0, 0)).toBeNull();
    expect(dirTo(2, 0)).toBeNull();
  });

  it("resolves movement to a compass index without choosing a game key", () => {
    expect(resolve("move-fwd", -2 * STEP)).toEqual({ kind: "key", direction: 2, run: false });
    expect(resolve("move-back-left", 0)).toEqual({ kind: "key", direction: 5, run: false });
    expect(resolve("run-fwd-right", -STEP)).toEqual({ kind: "key", direction: 2, run: true });
  });

  it("resolves camera-only turn and reset actions without a game key", () => {
    expect(resolve("turn-left", 0)).toEqual({ kind: "turn", delta: STEP });
    expect(resolve("turn-right", 0)).toEqual({ kind: "turn", delta: -STEP });
    expect(resolve("reset-facing", 1.25)).toEqual({ kind: "reset" });
    expect(resolve(undefined, 0)).toBeNull();
  });

  it("serializes browser modifier chords in one stable order", () => {
    expect(chord(ev("ArrowUp"))).toBe("ArrowUp");
    expect(chord(ev("ArrowUp", { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })))
      .toBe("Ctrl+Alt+Meta+Shift+ArrowUp");
    expect(chord(ev("K", { shiftKey: true }))).toBe("K");
  });
});
