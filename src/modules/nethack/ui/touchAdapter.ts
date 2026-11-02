// NetHack's touch adapter (vect-hack-21k): the six answers the shared touch
// layer refuses to guess at, and nothing else. Everything structural — the
// pad's grid, the routing rules, the bar's shape, the DOM — is in
// src/ui/touch/, so the port to Angband, Larn and Moria is this file again
// with their own encodings and their own verbs.
//
// The bar is a curated subset, stated rather than implied. The long tail
// lives behind "More", which opens the command menu that already exists
// (commandMenu.ts, vect-hack-be3.7) — a second menu of the same commands
// would be the thing most certain to drift.
import type { DungeonRenderer } from "../../../render/DungeonRenderer";
import { TouchControls, type TouchHost } from "../../../ui/touch/TouchControls";
import type { TouchBarItem } from "../../../ui/touch/scheme";
import type { TextHud } from "./TextHud";
import { DIRECTIONS, key } from "./keys";

/**
 * The action bar, left to right. Six verbs and the tail.
 *
 * Every letter is the compiled-in default from external/NetHack's src/cmd.c,
 * the same rule commandMenu.ts follows, and every glyph is that letter — the
 * bar teaches the keyboard game rather than hiding it.
 *
 * Labels are one short word each: at 390px a slot is 55px wide and a
 * two-word caption ("Pick up") wraps out of its own button. The glyph is what
 * a thumb aims at; the word underneath is only a reminder.
 *
 * Why these six. `s` and `.` are the two commands that pass a turn on purpose,
 * and searching is how a corridor stops being a dead end. `,` is the only way
 * to pick anything up, and the pointer cannot arrange it (be3.2 declined
 * click-to-move, so the hero has to already be standing on the loot). `i` is
 * the one command a player reaches for without a reason. `>` is the game:
 * without it a touch player can walk around level one forever.
 *
 * `o` is the interesting one, and it is here because the pad changed what is
 * possible. Open ends in NetHack's getdir(), and commandMenu.ts deliberately
 * carries no directional verb — "a menu with no target has no answer for it".
 * A thumb pad IS an answer for it: TextHud's sendKeys grants a compass
 * direction the same narrow exception a prompt grants a remapped arrow, so
 * `o` followed by a pad tap is exactly the two keystrokes a keyboard player
 * sends by hand. Doors are the single most common thing between a new
 * character and the rest of the level, which is why open earns the slot and
 * close, kick, chat and untrap do not.
 *
 * Not on the bar, deliberately: attack (walking into a monster is the attack,
 * so the pad already carries it), and `<` (a level a player can leave upward
 * is a level they arrived on downward, so the need is rarer than the width).
 */
export const NETHACK_TOUCH_BAR: readonly TouchBarItem[] = [
  { glyph: "s", label: "Search", kind: "command", codes: [key("s")] },
  { glyph: ",", label: "Pick", kind: "command", codes: [key(",")] },
  { glyph: "o", label: "Open", kind: "command", codes: [key("o")] },
  { glyph: ".", label: "Rest", kind: "command", codes: [key(".")] },
  { glyph: "i", label: "Items", kind: "command", codes: [key("i")] },
  { glyph: ">", label: "Down", kind: "command", codes: [key(">")] },
  { glyph: "☰", label: "More", kind: "more" },
];

/** NetHack's encoding of a compass eighth — the same table and the same index
 *  the keyboard's gaze path resolves through (moveKeys.ts's resolve). */
export function nethackDirectionKey(direction: number): number {
  return key(DIRECTIONS[direction]!);
}

/** Build the host the shared layer asks for. Exported apart from install()
 *  so a test can drive every seam without a stage or a renderer. */
export function nethackTouchHost(
  hud: TextHud, renderer: DungeonRenderer, stage: HTMLElement,
): TouchHost {
  return {
    stage,
    camera: renderer,
    bar: NETHACK_TOUCH_BAR,
    pending: () => hud.pendingInput,
    directionKey: nethackDirectionKey,
    send: (codes, answersDirection) => hud.sendKeys([...codes], answersDirection),
    openMore: () => hud.showCommandMenu(),
    finishLine: (accept) => hud.finishLineInput(accept),
    note: (text) => hud.message(text),
  };
}

/** Install the touch scheme over a live NetHack vector view. */
export function installNethackTouch(
  hud: TextHud, renderer: DungeonRenderer, stage: HTMLElement,
): TouchControls {
  return new TouchControls(nethackTouchHost(hud, renderer, stage));
}
