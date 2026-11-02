// Browser KeyboardEvent -> LarnKey. Larn reads single ASCII bytes via
// ttgetch() (io.c:170); every input is one byte — no termcap arrow
// sequences (spike §7). Movement is hjkl/yubn with uppercase = run
// (parse() at main.c:668, movement cases main.c:675-720). ESC is 27
// (KC_ESCAPE in ./protocol.ts).
//
// SPECIAL codes:
//   Arrows -> hjkl walk bytes, so the modernized arrow keys sit alongside
//     the raw hjkl the engine already switches on. Shift+arrow folds to the
//     uppercase byte — run, exactly what Shift+h produces — so the two
//     spellings of "run west" cannot drift apart (parse() switches on the
//     byte; mods is informational).
//   Escape -> 27 (KC_ESCAPE), the ASCII ESC byte.
//   Enter -> 0x0a (LF): help.c:109 loops `while (ttgetch() != '\n');` and
//     help.c:57-59 gates the help index on '\n' or '\33'. Larn reads LF,
//     not CR.
//   Backspace -> 0x08, Tab -> 0x09: no in-engine consumer (Larn edits no
//     input strings — getpassword() at global.c:758 reads a fixed run with
//     no backspace handling), but the ASCII bytes are the natural map for
//     a future prompt.
//
// Ctrl+letter is folded tty-style (KTRL: code & 0x1f). Function keys are
// deliberately unmapped — house rule: they are view chrome and never
// reach a game engine.
import type { LarnKey } from "./protocol.ts";
import { KC_ESCAPE, KC_MOD_SHIFT } from "./protocol.ts";

export { KC_MOD_SHIFT };

const SPECIAL: Record<string, number> = {
  ArrowDown: 0x6a,   // 'j' — south
  ArrowLeft: 0x68,   // 'h' — west
  ArrowRight: 0x6c,  // 'l' — east
  ArrowUp: 0x6b,     // 'k' — north
  Escape: KC_ESCAPE, // 27
  Enter: 0x0a,       // '\n' — help.c:109
  Backspace: 0x08,
  Tab: 0x09,
};

export function mapKey(
  e: { key: string; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean },
): LarnKey | null {
  // Meta and Alt belong to the browser: mapping Cmd+C would both eat the
  // copy and type "c" at the game. Same call as the function keys, which
  // are chrome.
  if (e.metaKey || e.altKey) return null;
  // Own-property only: "toString" is a KeyboardEvent.key nobody presses,
  // but a prototype hit would send Object.prototype's method to the engine
  // as a code (vect-hack-avm).
  let special = Object.hasOwn(SPECIAL, e.key) ? SPECIAL[e.key] : undefined;
  if (special !== undefined) {
    // Shift+arrow = run: fold to the uppercase movement byte, the same code
    // Shift+h would send. Only the four hjkl arrow bytes fold; Escape/Enter/
    // Backspace/Tab have no case.
    if (e.shiftKey && special >= 0x61 && special <= 0x7a) special -= 0x20;
    return { code: special, mods: e.shiftKey ? KC_MOD_SHIFT : 0 };
  }
  if ([...e.key].length !== 1) return null; // Shift, Control, F-keys, ...
  let code = e.key.codePointAt(0)!;
  if (e.ctrlKey) {
    if (code >= 0x40 && code < 0x80) code &= 0x1f; // KTRL fold
    else return null; // ctrl+digit etc. — browser shortcut space, don't guess
  }
  // Printable: uppercase letters already carry the run bit in the byte
  // (spike §7); mods carries shift so the worker can branch on it.
  return { code, mods: e.shiftKey ? KC_MOD_SHIFT : 0 };
}

/** Larn's vi-style movement encoding, clockwise from north. Run is the
 *  uppercase byte (subtract 0x20) with the shift mod; walk is the
 *  lowercase byte with no mod. Matches parse() at main.c:675-720. */
export function movementKey(compassIndex: number, run: boolean): LarnKey {
  const letters = ["k", "u", "l", "n", "j", "b", "h", "y"];
  const lower = letters[compassIndex]!.charCodeAt(0);
  return {
    code: run ? lower - 0x20 : lower,
    mods: run ? KC_MOD_SHIFT : 0,
  };
}