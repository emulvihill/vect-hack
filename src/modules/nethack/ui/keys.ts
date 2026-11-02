// The one place a key code is written down. Everything else names a character
// and lets this module turn it into the number NetHack reads, so a comment is
// never the only thing keeping a literal correct.

/** The code NetHack sees for a single character. */
export const key = (ch: string): number => ch.charCodeAt(0);
/** The same character held with Ctrl, folded the way a tty folds it. */
export const ctrl = (ch: string): number => key(ch) & 0x1f;
/** The same character with NetHack's classic Meta fold (include/micro.h's
 *  `M(c) = 0x80 | c`) — the high bit an 8-bit tty sets for Alt/Meta. Chat's
 *  only compiled-in key is Meta-c (src/cmd.c), so this is how a click reaches
 *  it without a real Alt keypress. */
export const meta = (ch: string): number => key(ch) | 0x80;

export const ESC = 27, CR = 13;
export const SPACE = 32, BACKSPACE = 8;

/** NetHack's eight movement commands, clockwise from north (cmd.c). */
export const DIRECTIONS = ["k", "u", "l", "n", "j", "b", "h", "y"] as const;

import { chord as sharedChord } from "../../../ui/gaze";

// Compatibility adapter: NetHack historically ignored the browser's Meta
// flag during binding lookup. Keep that behavior while sharing the serializer
// used for every modifier NetHack actually names.
export function chord(e: KeyboardEvent): string {
  return sharedChord({
    key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey,
    metaKey: false, shiftKey: e.shiftKey,
  });
}

/**
 * True when a chord's base key is a single printable character — the shape
 * chord() gives an unmodified letter, and the shape every fold in this file
 * turns into a live NetHack command byte: `key()` for a bare press,
 * `ctrl()` for Ctrl (kick is Ctrl+d), `meta()` for Alt (chat's only
 * compiled-in key is Alt+c). Ctrl and Alt don't clear the collision the way
 * an earlier version of this function assumed — they select a different
 * command, not "no command" — so the base alone decides, regardless of
 * which of those modifiers rode along. Shift never adds a prefix to a
 * printable key (chord()'s "Shift+" only ever decorates a named key like
 * ArrowUp), so "K" already hits this test the same way "k" does — no
 * separate case needed. A binding on a chord shaped like this would not add
 * a key, it would steal one out from under the engine — a saved override
 * (vect-hack-be3.5) has to be checked against this before it loads.
 */
export function shadowsCommand(chordStr: string): boolean {
  const base = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(.+)$/.exec(chordStr)?.[1];
  return base !== undefined && base.length === 1;
}
