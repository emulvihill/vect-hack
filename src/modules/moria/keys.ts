import type { MoriaInputContext, MoriaKeyMode } from "./protocol";

const NAMED: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 127,
  Delete: 127,
};

const ORIGINAL_DIRECTIONS: Record<string, string> = {
  ArrowDown: "2", ArrowLeft: "4", ArrowRight: "6", ArrowUp: "8",
  End: "1", PageDown: "3", Home: "7", PageUp: "9", Clear: "5",
};

const ROGUELIKE_DIRECTIONS: Record<string, string> = {
  ArrowDown: "j", ArrowLeft: "h", ArrowRight: "l", ArrowUp: "k",
  End: "b", PageDown: "n", Home: "y", PageUp: "u", Clear: ".",
};

const NUMPAD_DIRECTIONS: Record<string, string> = {
  Numpad1: "End", Numpad2: "ArrowDown", Numpad3: "PageDown",
  Numpad4: "ArrowLeft", Numpad5: "Clear", Numpad6: "ArrowRight",
  Numpad7: "Home", Numpad8: "ArrowUp", Numpad9: "PageUp",
};

export function mapKey(
  event: {
    key: string;
    code?: string;
    location?: number;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  },
  context: MoriaInputContext,
  mode: MoriaKeyMode,
): number | null {
  if (event.altKey || event.metaKey) return null;

  const named = Object.hasOwn(NAMED, event.key) ? NAMED[event.key] : undefined;
  if (named !== undefined) return named;

  if (context === "outer-command") {
    const table = mode === "roguelike" ? ROGUELIKE_DIRECTIONS : ORIGINAL_DIRECTIONS;
    // With NumLock on, KeyboardEvent.key is the same digit as the top row.
    // KeyboardEvent.code retains the physical keypad identity, so roguelike
    // movement can become hjkl/yubn without stealing literal count digits.
    const physical = event.location === 3 && event.code
      && Object.hasOwn(NUMPAD_DIRECTIONS, event.code)
      ? NUMPAD_DIRECTIONS[event.code]!
      : event.key;
    const direction = Object.hasOwn(table, physical) ? table[physical] : undefined;
    if (direction !== undefined) return direction.charCodeAt(0);
  }

  if ([...event.key].length !== 1) return null;
  const code = event.key.codePointAt(0)!;
  if (code > 0xff) return null;
  if (event.ctrlKey) return code >= 0x40 && code < 0x80 ? code & 0x1f : null;
  return (code >= 0x20 && code <= 0x7e) || code >= 0xa0 ? code : null;
}
