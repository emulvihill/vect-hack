import { describe, expect, it, vi } from "vitest";
import { FIRST_PERSON_BINDINGS, ORBITAL_BINDINGS, gazeKey } from "../../src/ui/gazeControls";

const press = (key: string, shiftKey = false) =>
  ({ key, shiftKey, ctrlKey: false, altKey: false, metaKey: false });

function camera(mode: "orbital" | "first" = "orbital", heading = 0) {
  return { mode, heading, turn: vi.fn(), resetFacing: vi.fn() };
}

describe("gazeControls (the shared per-Module binding tables + resolver)", () => {
  it("binds every direction key in both tables and turns only in first person", () => {
    for (const table of [FIRST_PERSON_BINDINGS, ORBITAL_BINDINGS]) {
      for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "PageUp", "End", "PageDown", "Clear"]) {
        expect(table[key]).toBeDefined();
      }
    }
    expect(FIRST_PERSON_BINDINGS["ArrowLeft"]).toBe("turn-left");
    expect(ORBITAL_BINDINGS["ArrowLeft"]).toBe("move-left");
    // Shift rides along on a first-person turn (vect-hack-029): an unbound
    // shifted chord would fall through to a Module's shift-blind lookup.
    expect(FIRST_PERSON_BINDINGS["Shift+ArrowRight"]).toBe("turn-right");
    expect(ORBITAL_BINDINGS["Shift+ArrowRight"]).toBe("run-right");
  });

  it("resolves a move against the camera heading without choosing a key encoding", () => {
    const cam = camera("orbital", -Math.PI / 2); // facing East
    expect(gazeKey(press("ArrowUp"), cam)).toEqual({ kind: "move", direction: 2, run: false });
    expect(gazeKey(press("ArrowUp", true), cam)).toEqual({ kind: "move", direction: 2, run: true });
    expect(cam.turn).not.toHaveBeenCalled();
  });

  it("applies a first-person turn and reset to the camera and reports them handled", () => {
    const cam = camera("first");
    expect(gazeKey(press("ArrowLeft"), cam)).toEqual({ kind: "camera" });
    expect(cam.turn).toHaveBeenCalledWith(Math.PI / 4);
    expect(gazeKey(press("Clear"), cam)).toEqual({ kind: "camera" });
    expect(cam.resetFacing).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unbound chord and applies no camera action", () => {
    const cam = camera("first");
    expect(gazeKey(press("a"), cam)).toBeNull();
    expect(gazeKey({ key: "ArrowUp", shiftKey: false, ctrlKey: true, altKey: false, metaKey: false }, cam)).toBeNull();
    expect(cam.turn).not.toHaveBeenCalled();
    expect(cam.resetFacing).not.toHaveBeenCalled();
  });
});
