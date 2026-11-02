// Browser KeyboardEvent -> LarnKey. Larn reads single ASCII bytes via
// ttgetch() (io.c:170); movement is hjkl/yubn with uppercase = run
// (parse() main.c:668, movement cases main.c:675-720; spike §7). ESC is 27
// (protocol.ts KC_ESCAPE). Enter is LF (0x0a): help.c:109 loops on '\n' and
// help.c:57-59 gates the help index on '\n' or '\33'. Backspace (0x08) and
// Tab (0x09) have no in-engine consumer — Larn edits no input strings —
// but are mapped to their ASCII bytes so a future prompt can read them.
import { describe, expect, it } from "vitest";
import {
  KC_MOD_SHIFT, mapKey, movementKey,
} from "../../src/modules/larn/keys";
import { KC_ESCAPE } from "../../src/modules/larn/protocol";

describe("mapKey", () => {
  it("maps printable characters to their code point", () => {
    expect(mapKey({ key: "a" })).toEqual({ code: 0x61, mods: 0 });
    expect(mapKey({ key: "*" })).toEqual({ code: 0x2a, mods: 0 });
    expect(mapKey({ key: "?" })).toEqual({ code: 0x3f, mods: 0 });
  });

  it("maps uppercase letters to the uppercase byte with the shift/run mod", () => {
    // Spike §7: uppercase = run. A real browser sets key="H" AND shiftKey
    // together for Shift+h; the byte already carries the case, mods carries
    // shift so the worker can treat it as a run.
    expect(mapKey({ key: "H", shiftKey: true })).toEqual({ code: 0x48, mods: KC_MOD_SHIFT });
    expect(mapKey({ key: "h" })).toEqual({ code: 0x68, mods: 0 });
  });

  it("maps arrows to hjkl walk bytes (modernized controls alongside raw hjkl)", () => {
    expect(mapKey({ key: "ArrowDown" })).toEqual({ code: 0x6a, mods: 0 }); // 'j'
    expect(mapKey({ key: "ArrowLeft" })).toEqual({ code: 0x68, mods: 0 });  // 'h'
    expect(mapKey({ key: "ArrowRight" })).toEqual({ code: 0x6c, mods: 0 }); // 'l'
    expect(mapKey({ key: "ArrowUp" })).toEqual({ code: 0x6b, mods: 0 });   // 'k'
  });

  it("maps Escape to the ASCII ESC byte pinned in protocol.ts", () => {
    expect(mapKey({ key: "Escape" })).toEqual({ code: KC_ESCAPE, mods: 0 });
    expect(KC_ESCAPE).toBe(27);
  });

  it("maps Enter to LF (help.c:109 consumes '\n') and backspace/tab to their ASCII bytes", () => {
    expect(mapKey({ key: "Enter" })).toEqual({ code: 0x0a, mods: 0 });
    expect(mapKey({ key: "Backspace" })).toEqual({ code: 0x08, mods: 0 });
    expect(mapKey({ key: "Tab" })).toEqual({ code: 0x09, mods: 0 });
  });

  it("folds shift+arrow to the uppercase run byte, matching Shift+letter", () => {
    // Two spellings of "run north" must send the same code: parse() switches
    // on the byte, so 'k'+shift-mod would WALK while 'K' runs.
    expect(mapKey({ key: "ArrowUp", shiftKey: true })).toEqual({
      code: 0x4b, mods: KC_MOD_SHIFT, // 'K'
    });
    expect(mapKey({ key: "ArrowLeft", shiftKey: true })).toEqual({
      code: 0x48, mods: KC_MOD_SHIFT, // 'H'
    });
    expect(mapKey({ key: "K", shiftKey: true })).toEqual(
      mapKey({ key: "ArrowUp", shiftKey: true }),
    );
    // Caseless specials keep their byte; shift stays informational.
    expect(mapKey({ key: "Escape", shiftKey: true })).toEqual({
      code: 27, mods: KC_MOD_SHIFT,
    });
    expect(mapKey({ key: "Enter", shiftKey: true })).toEqual({
      code: 0x0a, mods: KC_MOD_SHIFT,
    });
  });

  it("folds ctrl+letter tty-style (KTRL: code & 0x1f)", () => {
    expect(mapKey({ key: "d", ctrlKey: true })).toEqual({ code: 0x04, mods: 0 });
    expect(mapKey({ key: "F", ctrlKey: true })).toEqual({ code: 0x06, mods: 0 });
  });

  it("leaves meta and alt combos to the browser", () => {
    expect(mapKey({ key: "c", metaKey: true })).toBeNull();
    expect(mapKey({ key: "v", metaKey: true })).toBeNull();
    expect(mapKey({ key: "a", metaKey: true })).toBeNull();
    expect(mapKey({ key: "d", altKey: true })).toBeNull();
    expect(mapKey({ key: "ArrowLeft", metaKey: true })).toBeNull();
    expect(mapKey({ key: "c" })).toEqual({ code: 0x63, mods: 0 }); // unmodified still maps
  });

  it("drops what it cannot map", () => {
    expect(mapKey({ key: "Shift" })).toBeNull();
    expect(mapKey({ key: "Control" })).toBeNull();
    expect(mapKey({ key: "F5" })).toBeNull();       // function keys are view chrome
    expect(mapKey({ key: "1", ctrlKey: true })).toBeNull(); // browser shortcut space
  });

  it("never resolves a key name through the prototype chain (vect-hack-avm)", () => {
    // Without an own-property guard, SPECIAL["toString"] is a function and
    // mapKey would emit { code: <function>, mods: 0 } to the engine.
    expect(mapKey({ key: "toString" })).toBeNull();
    expect(mapKey({ key: "constructor" })).toBeNull();
    expect(mapKey({ key: "hasOwnProperty" })).toBeNull();
  });
});

describe("movementKey", () => {
  it("emits hjkl/yubn lowercase for each gaze direction (no keypad mod)", () => {
    // Clockwise from north: N=k, NE=u, E=l, SE=n, S=j, SW=b, W=h, NW=y
    expect(Array.from({ length: 8 }, (_, i) => movementKey(i, false))).toEqual(
      [..."kulnjbhy"].map((ch) => ({ code: ch.charCodeAt(0), mods: 0 })),
    );
  });

  it("emits the uppercase byte with KC_MOD_SHIFT for run", () => {
    // Run = uppercase (subtract 0x20 from the lowercase byte) + shift mod.
    expect(movementKey(0, true)).toEqual({ code: 0x4b, mods: KC_MOD_SHIFT }); // 'K'
    expect(movementKey(2, true)).toEqual({ code: 0x4c, mods: KC_MOD_SHIFT }); // 'L'
    expect(movementKey(4, true)).toEqual({ code: 0x4a, mods: KC_MOD_SHIFT }); // 'J'
    expect(movementKey(7, true)).toEqual({ code: 0x59, mods: KC_MOD_SHIFT }); // 'Y'
  });

  it("matches the parse() direction codes (main.c:675-720)", () => {
    // Spot-check: movementKey(3, false) is SE = 'n' (0x6e), movementKey(5, false)
    // is SW = 'b' (0x62) — the same letters parse() switches on.
    expect(movementKey(3, false)).toEqual({ code: 0x6e, mods: 0 });
    expect(movementKey(5, false)).toEqual({ code: 0x62, mods: 0 });
  });
});