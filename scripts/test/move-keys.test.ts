// Gaze-relative movement (vect-hack-be3). The sign of the yaw-to-compass
// mapping is the part most likely to be wrong and the part a comment cannot
// prove, so it is asserted against the camera's own convention: yaw 0 is
// north and positive yaw turns left, so -PI/2 must be east.
import { describe, expect, it } from "vitest";
import { TURN_STEP } from "../../src/render/DungeonCamera";
import { DIRECTIONS, ctrl, key, meta } from "../../src/modules/nethack/ui/keys";
import { ACTIONS, DEFAULT_BINDINGS, ORBITAL_BINDINGS, compass, dirTo, resolve, resolveTarget } from "../../src/modules/nethack/ui/moveKeys";

const code = (r: ReturnType<typeof resolve>) =>
  r && r.kind === "key" ? String.fromCharCode(r.code) : r;

describe("compass", () => {
  it("puts yaw 0 at north", () => {
    expect(compass(0)).toBe(0);
    expect(DIRECTIONS[compass(0)]).toBe("k");
  });

  it("turns left for positive yaw", () => {
    expect(DIRECTIONS[compass(Math.PI / 2)]).toBe("h");   // west
    expect(DIRECTIONS[compass(-Math.PI / 2)]).toBe("l");  // east
    expect(DIRECTIONS[compass(-Math.PI / 4)]).toBe("u");  // north-east
    expect(DIRECTIONS[compass(Math.PI)]).toBe("j");       // south
  });

  it("wraps past a full turn in both directions", () => {
    expect(compass(2 * Math.PI)).toBe(0);
    expect(compass(-2 * Math.PI)).toBe(0);
    expect(DIRECTIONS[compass(-Math.PI / 2 - 4 * Math.PI)]).toBe("l");
    expect(DIRECTIONS[compass(3 * Math.PI)]).toBe("j");
  });

  it("snaps a look between two directions to the nearer one", () => {
    expect(DIRECTIONS[compass(-Math.PI / 8 - 0.01)]).toBe("u"); // just past halfway
    expect(DIRECTIONS[compass(-Math.PI / 8 + 0.01)]).toBe("k"); // just short of it
  });
});

describe("resolve", () => {
  it("walks the direction the camera is looking", () => {
    expect(code(resolve("move-fwd", 0))).toBe("k");
    expect(code(resolve("move-fwd", -Math.PI / 2))).toBe("l");
    expect(code(resolve("move-fwd", Math.PI / 2))).toBe("h");
  });

  it("steps to the opposite cell for back, at every heading", () => {
    for (let i = 0; i < 8; i++) {
      const yaw = -i * TURN_STEP;
      expect(code(resolve("move-back", yaw))).toBe(DIRECTIONS[(i + 4) & 7]);
    }
  });

  it("takes the perpendiculars for the unbound strafes", () => {
    expect(code(resolve("move-left", 0))).toBe("h");
    expect(code(resolve("move-right", 0))).toBe("l");
  });

  it("runs with the uppercase of the same direction", () => {
    for (let i = 0; i < 8; i++) {
      const yaw = -i * TURN_STEP;
      expect(code(resolve("run-fwd", yaw))).toBe(DIRECTIONS[i]!.toUpperCase());
      expect(code(resolve("run-back", yaw))).toBe(DIRECTIONS[(i + 4) & 7]!.toUpperCase());
    }
  });

  it("runs sideways and diagonally too, rotated like the walks (vect-hack-029)", () => {
    for (let i = 0; i < 8; i++) {
      const yaw = -i * TURN_STEP;
      expect(code(resolve("run-fwd-right", yaw))).toBe(DIRECTIONS[(i + 1) & 7]!.toUpperCase());
      expect(code(resolve("run-right", yaw))).toBe(DIRECTIONS[(i + 2) & 7]!.toUpperCase());
      expect(code(resolve("run-back-right", yaw))).toBe(DIRECTIONS[(i + 3) & 7]!.toUpperCase());
      expect(code(resolve("run-back-left", yaw))).toBe(DIRECTIONS[(i + 5) & 7]!.toUpperCase());
      expect(code(resolve("run-left", yaw))).toBe(DIRECTIONS[(i + 6) & 7]!.toUpperCase());
      expect(code(resolve("run-fwd-left", yaw))).toBe(DIRECTIONS[(i + 7) & 7]!.toUpperCase());
    }
  });

  it("turns without producing a key, so no game time passes", () => {
    expect(resolve("turn-left", 0)).toEqual({ kind: "turn", delta: TURN_STEP });
    expect(resolve("turn-right", 0)).toEqual({ kind: "turn", delta: -TURN_STEP });
  });

  it("returns null for an unbound key so KEYMAP still sees it", () => {
    expect(resolve(undefined, 0)).toBeNull();
  });

  it("does not read a pointer/menu action as a movement", () => {
    // Regression guard: before resolve() spelled out its movement cases, any
    // action not in {turn-left, turn-right, undefined} fell into the
    // move-left branch by accident — attack would have walked west.
    expect(resolve("attack", 0)).toBeNull();
    expect(resolve("open", 0)).toBeNull();
    expect(resolve("kick", 0)).toBeNull();
    expect(resolve("chat", 0)).toBeNull();
    expect(resolve("apply", 0)).toBeNull();
  });
});

describe("dirTo", () => {
  it("names each of the eight neighbours, matching DIRECTIONS' own order", () => {
    const deltas: [number, number][] = [
      [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
    ];
    deltas.forEach(([dx, dy], i) => {
      expect(DIRECTIONS[dirTo(dx, dy)!]).toBe(DIRECTIONS[i]);
    });
  });

  it("is null for the hero's own cell and for anything not adjacent", () => {
    expect(dirTo(0, 0)).toBeNull();
    expect(dirTo(2, 0)).toBeNull();
    expect(dirTo(-2, -2)).toBeNull();
    expect(dirTo(0, 5)).toBeNull();
  });
});

describe("resolveTarget", () => {
  it("attacks with the plain direction key, NetHack's classic move-into-attack", () => {
    expect(resolveTarget("attack", dirTo(0, -1))).toEqual({ kind: "key", code: key("k") });
    expect(resolveTarget("attack", dirTo(1, 1))).toEqual({ kind: "key", code: key("n") });
  });

  it("has no direction to attack without a target to attack toward", () => {
    expect(resolveTarget("attack", null)).toBeNull();
  });

  it("opens and kicks with the compiled-in verb, then the direction (cmd.c)", () => {
    expect(resolveTarget("open", dirTo(1, 0))).toEqual({ kind: "keys", codes: [key("o"), key("l")] });
    expect(resolveTarget("kick", dirTo(-1, 0))).toEqual({ kind: "keys", codes: [ctrl("d"), key("h")] });
  });

  it("chats with NetHack's only bound key for it, Meta-c", () => {
    expect(resolveTarget("chat", dirTo(0, 1))).toEqual({ kind: "keys", codes: [meta("c"), key("j")] });
  });

  it("needs a direction for open, kick and chat — they all end in getdir()", () => {
    expect(resolveTarget("open", null)).toBeNull();
    expect(resolveTarget("kick", null)).toBeNull();
    expect(resolveTarget("chat", null)).toBeNull();
  });

  it("applies without a direction: the item choice comes first, from the engine", () => {
    expect(resolveTarget("apply", null)).toEqual({ kind: "key", code: key("a") });
    expect(resolveTarget("apply", dirTo(1, 0))).toEqual({ kind: "key", code: key("a") });
  });

  it("has nothing to resolve for a camera-relative action", () => {
    expect(resolveTarget("move-fwd", dirTo(0, -1))).toBeNull();
  });

  it("closes with 'c' and untraps with Meta-u, then the direction (cmd.c)", () => {
    expect(resolveTarget("close", dirTo(0, 1))).toEqual({ kind: "keys", codes: [key("c"), key("j")] });
    expect(resolveTarget("untrap", dirTo(-1, -1))).toEqual({ kind: "keys", codes: [meta("u"), key("y")] });
  });

  it("needs a direction for close and untrap — both end in getdir()", () => {
    expect(resolveTarget("close", null)).toBeNull();
    expect(resolveTarget("untrap", null)).toBeNull();
  });

  it("searches without a direction: 's' sweeps every neighbour at once", () => {
    expect(resolveTarget("search", null)).toEqual({ kind: "key", code: key("s") });
    expect(resolveTarget("search", dirTo(1, 0))).toEqual({ kind: "key", code: key("s") });
  });
});

describe("diagonal moves", () => {
  it("walks the four diagonals relative to the gaze at north", () => {
    expect(code(resolve("move-fwd-left", 0))).toBe("y");
    expect(code(resolve("move-fwd-right", 0))).toBe("u");
    expect(code(resolve("move-back-left", 0))).toBe("b");
    expect(code(resolve("move-back-right", 0))).toBe("n");
  });

  it("rotates with the heading, at every eighth", () => {
    for (let i = 0; i < 8; i++) {
      const yaw = -i * TURN_STEP;
      expect(code(resolve("move-fwd-right", yaw))).toBe(DIRECTIONS[(i + 1) & 7]);
      expect(code(resolve("move-back-right", yaw))).toBe(DIRECTIONS[(i + 3) & 7]);
      expect(code(resolve("move-back-left", yaw))).toBe(DIRECTIONS[(i + 5) & 7]);
      expect(code(resolve("move-fwd-left", yaw))).toBe(DIRECTIONS[(i + 7) & 7]);
    }
  });

  it("snaps an off-lattice orbital azimuth like any other heading", () => {
    // The orbital camera's drag leaves the azimuth between eighths; compass()
    // rounds to the nearest, including past accumulated full turns.
    expect(code(resolve("move-fwd", -Math.PI / 2 + 0.05))).toBe("l");
    expect(code(resolve("move-fwd-left", Math.PI + 4 * Math.PI))).toBe("n"); // facing south: fwd-left is SE
  });
});

describe("reset-facing", () => {
  it("resets without producing a key, at any heading", () => {
    expect(resolve("reset-facing", 0)).toEqual({ kind: "reset" });
    expect(resolve("reset-facing", 1.234)).toEqual({ kind: "reset" });
  });
});

describe("orbital bindings", () => {
  it("moves on all eight keys and never turns — the pointer owns orbital turning", () => {
    expect(ORBITAL_BINDINGS["ArrowUp"]).toBe("move-fwd");
    expect(ORBITAL_BINDINGS["ArrowDown"]).toBe("move-back");
    expect(ORBITAL_BINDINGS["ArrowLeft"]).toBe("move-left");
    expect(ORBITAL_BINDINGS["ArrowRight"]).toBe("move-right");
    expect(ORBITAL_BINDINGS["Home"]).toBe("move-fwd-left");
    expect(ORBITAL_BINDINGS["PageUp"]).toBe("move-fwd-right");
    expect(ORBITAL_BINDINGS["End"]).toBe("move-back-left");
    expect(ORBITAL_BINDINGS["PageDown"]).toBe("move-back-right");
    expect(ORBITAL_BINDINGS["Shift+ArrowUp"]).toBe("run-fwd");
    expect(ORBITAL_BINDINGS["Shift+ArrowDown"]).toBe("run-back");
    for (const a of Object.values(ORBITAL_BINDINGS)) expect(a).not.toMatch(/^turn-/);
  });

  it("shift runs in the translated direction — never the absolute one (vect-hack-029)", () => {
    // Every shifted direction key must be bound, or chord() falls through to
    // KEYMAP's shift-blind absolute lookup and Shift+Home walks a different
    // cell than Home once the camera is rotated.
    expect(ORBITAL_BINDINGS["Shift+ArrowLeft"]).toBe("run-left");
    expect(ORBITAL_BINDINGS["Shift+ArrowRight"]).toBe("run-right");
    for (const table of [ORBITAL_BINDINGS, DEFAULT_BINDINGS]) {
      expect(table["Shift+Home"]).toBe("run-fwd-left");
      expect(table["Shift+PageUp"]).toBe("run-fwd-right");
      expect(table["Shift+End"]).toBe("run-back-left");
      expect(table["Shift+PageDown"]).toBe("run-back-right");
    }
    // First person has no sideways arrow to run: shift rides along on the turn.
    expect(DEFAULT_BINDINGS["Shift+ArrowLeft"]).toBe("turn-left");
    expect(DEFAULT_BINDINGS["Shift+ArrowRight"]).toBe("turn-right");
    // The guarantee itself: no direction key's shifted chord is left unbound.
    for (const table of [ORBITAL_BINDINGS, DEFAULT_BINDINGS])
      for (const k of Object.keys(table))
        if (!k.startsWith("Shift+") && k !== "Clear")
          expect(table[`Shift+${k}`]).toBeDefined();
  });

  it("resets facing on Clear, the NumLock-off keypad 5", () => {
    expect(ORBITAL_BINDINGS["Clear"]).toBe("reset-facing");
    expect(DEFAULT_BINDINGS["Clear"]).toBe("reset-facing");
  });

  it("binds the numpad-cluster diagonals in first person too", () => {
    expect(DEFAULT_BINDINGS["Home"]).toBe("move-fwd-left");
    expect(DEFAULT_BINDINGS["PageUp"]).toBe("move-fwd-right");
    expect(DEFAULT_BINDINGS["End"]).toBe("move-back-left");
    expect(DEFAULT_BINDINGS["PageDown"]).toBe("move-back-right");
  });

  it("binds no letters and no digits, in either table", () => {
    // Letters are live NetHack commands; digits are count prefixes (the
    // NumLock-on keypad types them). Both must fall through untouched.
    for (const table of [ORBITAL_BINDINGS, DEFAULT_BINDINGS])
      for (const k of Object.keys(table))
        expect(k).toMatch(/^(Shift\+)?[A-Z][A-Za-z]+$/);
  });

  it("names only actions that exist", () => {
    for (const a of Object.values(ORBITAL_BINDINGS)) expect(ACTIONS).toContain(a);
  });
});

describe("ACTIONS", () => {
  it("names every action once, with every bound value among them", () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
    for (const action of Object.values(DEFAULT_BINDINGS)) expect(ACTIONS).toContain(action);
    for (const action of Object.values(ORBITAL_BINDINGS)) expect(ACTIONS).toContain(action);
  });
});

describe("default bindings", () => {
  it("binds the four arrows and the two runs", () => {
    expect(DEFAULT_BINDINGS["ArrowUp"]).toBe("move-fwd");
    expect(DEFAULT_BINDINGS["ArrowDown"]).toBe("move-back");
    expect(DEFAULT_BINDINGS["ArrowLeft"]).toBe("turn-left");
    expect(DEFAULT_BINDINGS["ArrowRight"]).toBe("turn-right");
    expect(DEFAULT_BINDINGS["Shift+ArrowUp"]).toBe("run-fwd");
    expect(DEFAULT_BINDINGS["Shift+ArrowDown"]).toBe("run-back");
  });

  it("leaves the letters alone", () => {
    for (const ch of ["w", "a", "s", "d"]) expect(DEFAULT_BINDINGS[ch]).toBeUndefined();
    expect(key("s")).toBe(115); // still search, straight through KEYMAP's fallthrough
  });
});
