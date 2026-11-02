// Browser KeyboardEvent -> Angband keycode_t. The constants are pinned to
// external/angband/src/ui-event.h:140-175 (ARROW_* 0x80-0x83, KC_ENTER 0x9c,
// ESCAPE 0xE000). Ctrl+letter is folded tty-style (KTRL); productized movement
// uses Angband's native Shift and keypad modifier bits.
import { describe, expect, it } from "vitest";
import {
  KC_MOD_KEYPAD, KC_MOD_SHIFT, mapKey, movementKey,
} from "../../src/modules/angband/keys";

describe("mapKey", () => {
  it("maps printable characters to their code point", () => {
    expect(mapKey({ key: "a" })).toEqual({ code: 0x61, mods: 0 });
    expect(mapKey({ key: "*" })).toEqual({ code: 0x2a, mods: 0 });
    expect(mapKey({ key: "?" })).toEqual({ code: 0x3f, mods: 0 });
  });

  it("maps specials to ui-event.h codes", () => {
    expect(mapKey({ key: "Escape" })).toEqual({ code: 0xe000, mods: 0 });
    expect(mapKey({ key: "Enter" })).toEqual({ code: 0x9c, mods: 0 });
    expect(mapKey({ key: "ArrowDown" })).toEqual({ code: 0x80, mods: 0 });
    expect(mapKey({ key: "ArrowLeft" })).toEqual({ code: 0x81, mods: 0 });
    expect(mapKey({ key: "ArrowRight" })).toEqual({ code: 0x82, mods: 0 });
    expect(mapKey({ key: "ArrowUp" })).toEqual({ code: 0x83, mods: 0 });
    expect(mapKey({ key: "Backspace" })).toEqual({ code: 0x9f, mods: 0 });
    expect(mapKey({ key: "Tab" })).toEqual({ code: 0x9d, mods: 0 });
  });

  it("folds ctrl+letter tty-style", () => {
    expect(mapKey({ key: "d", ctrlKey: true })).toEqual({ code: 0x04, mods: 0 });
    expect(mapKey({ key: "F", ctrlKey: true })).toEqual({ code: 0x06, mods: 0 });
  });

  it("uses Angband's native Shift and keypad modifier bits", () => {
    expect(KC_MOD_SHIFT).toBe(0x02);
    expect(KC_MOD_KEYPAD).toBe(0x10);
    expect(mapKey({ key: "ArrowUp", shiftKey: true })).toEqual({ code: 0x83, mods: KC_MOD_SHIFT });
    // Printable shift is already represented by KeyboardEvent.key.
    expect(mapKey({ key: "A", shiftKey: true })).toEqual({ code: 0x41, mods: 0 });
  });

  it("emits native keypad digits for each gaze direction", () => {
    expect(Array.from({ length: 8 }, (_, i) => movementKey(i, false))).toEqual(
      [..."89632147"].map((digit) => ({ code: digit.charCodeAt(0), mods: KC_MOD_KEYPAD })),
    );
    expect(movementKey(3, true)).toEqual({
      code: "3".charCodeAt(0), mods: KC_MOD_KEYPAD | KC_MOD_SHIFT,
    });
  });

  it("leaves meta and alt combos to the browser", () => {
    // Cmd+C/V/A must stay copy/paste/select-all: mapping them would both eat
    // the shortcut and type "version"/"aim a wand" into the game.
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
