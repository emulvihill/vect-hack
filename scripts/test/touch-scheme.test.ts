// The touch scheme's pure decisions (vect-hack-21k). Every assertion here is
// a CHOICE that could have gone the other way, so each one was watched failing
// on the wrong choice before it was believed (AGENTS.md).
import { describe, expect, it } from "vitest";
import {
  PAD_GRID, PAD_LABEL, PAD_TITLE, barIsWellFormed, barMode, routeCommand,
  routePad, touchRequested, TOUCH_FLAG, type PendingInput,
} from "../../src/ui/touch/scheme";
import { resolve } from "../../src/ui/gaze";

const SHAPES: PendingInput[] = ["none", "direction", "yesno", "menu", "line"];

describe("the thumb pad's grid", () => {
  it("is the eight screen-relative moves around one piece of camera chrome", () => {
    expect(PAD_GRID).toEqual([
      "move-fwd-left", "move-fwd", "move-fwd-right",
      "move-left", "reset-facing", "move-right",
      "move-back-left", "move-back", "move-back-right",
    ]);
    expect(PAD_LABEL).toHaveLength(9);
    expect(PAD_TITLE).toHaveLength(9);
  });

  it("resolves through the shared gaze layer, and the grid is laid out the way it reads", () => {
    // North-up camera: the top-middle key is north (compass 0) and the row
    // below it is west/east. A grid transposed or mirrored fails here — this
    // is the assertion that the 3x3 order is the one a thumb expects.
    const dir = (i: number) => {
      const r = resolve(PAD_GRID[i]!, 0);
      return r?.kind === "key" ? r.direction : null;
    };
    expect([dir(0), dir(1), dir(2)]).toEqual([7, 0, 1]);
    expect([dir(3), dir(4), dir(5)]).toEqual([6, null, 2]);
    expect([dir(6), dir(7), dir(8)]).toEqual([5, 4, 3]);
  });

  it("follows the camera, so the pad is screen-relative in both modes", () => {
    // Camera swung a quarter turn (yaw -PI/2 faces east): the top key steps
    // east. Nothing in the pad knows about camera MODE — a first-person
    // camera resolves identically, because a finger turns the view by
    // dragging and a pad that changed meaning under the thumb would be worse.
    const r = resolve(PAD_GRID[1]!, -Math.PI / 2);
    expect(r).toEqual({ kind: "key", direction: 2, run: false });
  });

  it("never asks for a run: one tap is one step, one turn", () => {
    for (const action of PAD_GRID) {
      const r = resolve(action, 0);
      if (r?.kind === "key") expect(r.run).toBe(false);
    }
  });
});

describe("routing a tap against what the engine is waiting for", () => {
  it("sends a step only at command level and an answer only at a direction prompt", () => {
    expect(routePad("move-fwd", "none")).toBe("step");
    expect(routePad("move-fwd", "direction")).toBe("answer");
    for (const shape of ["yesno", "menu", "line"] as const) {
      expect(routePad("move-fwd", shape)).toBe("refuse");
    }
  });

  it("keeps the pad centre chrome whatever the engine is waiting for", () => {
    // The hard constraint: camera controls never reach a native core. A
    // centre that became "refuse" under a prompt would be harmless; one that
    // became "step" or "answer" would send a key the player never asked for.
    for (const shape of SHAPES) expect(routePad("reset-facing", shape)).toBe("chrome");
  });

  it("refuses every bar verb at every prompt, a direction prompt included", () => {
    expect(routeCommand("none")).toBe("send");
    for (const shape of ["direction", "yesno", "menu", "line"] as const) {
      expect(routeCommand(shape)).toBe("refuse");
    }
  });

  it("dims the bar rather than hiding it, and swaps it only for a line prompt", () => {
    expect(barMode("none")).toBe("commands");
    expect(barMode("line")).toBe("line");
    for (const shape of ["direction", "yesno", "menu"] as const) {
      expect(barMode(shape)).toBe("locked");
    }
  });
});

describe("the bar's shape and the flag", () => {
  it("insists a command slot carries keys and a 'more' slot carries none", () => {
    expect(barIsWellFormed([{ glyph: "s", label: "Search", kind: "command", codes: [115] }])).toBe(true);
    expect(barIsWellFormed([{ glyph: "☰", label: "More", kind: "more" }])).toBe(true);
    expect(barIsWellFormed([{ glyph: "x", label: "Dud", kind: "command", codes: [] }])).toBe(false);
    expect(barIsWellFormed([{ glyph: "x", label: "Dud", kind: "command" }])).toBe(false);
    expect(barIsWellFormed([{ glyph: "☰", label: "More", kind: "more", codes: [115] }])).toBe(false);
  });

  it("reads the flag out of a search string, bare or valued, and nothing else", () => {
    expect(TOUCH_FLAG).toBe("touch");
    expect(touchRequested("?game=nethack&touch")).toBe(true);
    expect(touchRequested("?touch=1")).toBe(true);
    expect(touchRequested("?game=nethack")).toBe(false);
    expect(touchRequested("")).toBe(false);
  });
});
