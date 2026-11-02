// Browser KeyboardEvent -> Angband keycode_t (external/angband/src/
// ui-event.h:140-175). Ctrl+letter is folded tty-style (KTRL: code & 0x1f);
// named Shift keys carry Angband's native modifier bit. Function keys are
// deliberately unmapped — house rule: they are view chrome and never reach a
// game engine.
import type { AngbandKey } from "./protocol";

export const KC_MOD_SHIFT = 0x02;
export const KC_MOD_KEYPAD = 0x10;

const SPECIAL: Record<string, number> = {
  ArrowDown: 0x80, ArrowLeft: 0x81, ArrowRight: 0x82, ArrowUp: 0x83,
  Home: 0x94, PageUp: 0x95, End: 0x96, PageDown: 0x97, Insert: 0x98,
  Enter: 0x9c, Tab: 0x9d, Delete: 0x9e, Backspace: 0x9f,
  Escape: 0xe000,
};

export function mapKey(
  e: { key: string; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean },
): AngbandKey | null {
  // Meta and Alt belong to the browser: mapping Cmd+C would both eat the copy
  // and type "c" (version) at the game. Angband can take Alt as meta in some
  // front ends, but the spike has no KC_MOD_META to carry it — same call as
  // the function keys, which are chrome. Phase 3 may map the modifier instead.
  if (e.metaKey || e.altKey) return null;
  // Own-property only: "toString" is a KeyboardEvent.key nobody presses, but a
  // prototype hit would send Object.prototype's method to the engine as a code.
  const special = Object.hasOwn(SPECIAL, e.key) ? SPECIAL[e.key] : undefined;
  if (special !== undefined) return { code: special, mods: e.shiftKey ? KC_MOD_SHIFT : 0 };
  if ([...e.key].length !== 1) return null; // Shift, Control, F-keys, ...
  let code = e.key.codePointAt(0)!;
  if (e.ctrlKey) {
    if (code >= 0x40 && code < 0x80) code &= 0x1f; // KTRL fold
    else return null; // ctrl+digit etc. — browser shortcut space, don't guess
  }
  return { code, mods: 0 };
}

/** Angband's native keypad direction encoding, clockwise from north.
 *  hitInference decodes this same table back into a delta, so encode and
 *  decode cannot drift apart. */
export const KEYPAD_DIGITS: readonly string[] = ["8", "9", "6", "3", "2", "1", "4", "7"];

export function movementKey(compassIndex: number, run: boolean): AngbandKey {
  return {
    code: KEYPAD_DIGITS[compassIndex]!.charCodeAt(0),
    mods: KC_MOD_KEYPAD | (run ? KC_MOD_SHIFT : 0),
  };
}
