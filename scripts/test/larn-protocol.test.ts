import { describe, expect, it } from "vitest";
import { KC_ESCAPE } from "../../src/modules/larn/protocol";

describe("larn protocol constants", () => {
  it("pins the ESCAPE keycode used as the cancel fallback", () => {
    // Spike §7: Larn reads ASCII ESC (27) as a single byte — no termcap
    // arrow sequences like Angband's 0xe000 keycode_t.
    expect(KC_ESCAPE).toBe(27);
  });
});