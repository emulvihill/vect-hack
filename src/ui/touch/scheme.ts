// The touch scheme's pure half (vect-hack-21k): every decision a tap forces,
// with no DOM and no game in it. The DOM layer (TouchControls.ts) and each
// Module's adapter both read these, so a rule is stated once and pinned once.
//
// Two things it deliberately does NOT decide: what a compass direction is
// spelled as (each Module's own encoding — NetHack's letter, Angband's keypad
// digit, Moria's source-owned byte) and which verbs a Module puts on its bar.
// Those are the adapter's, which is what makes the port to the other three
// mechanical rather than a rewrite.
import type { GazeAction } from "../gaze";

/**
 * The thumb pad, row-major from the top-left of a 3x3 grid, expressed as gaze
 * actions — the same vocabulary the keyboard's arrow tables speak, so a tap
 * and an arrow reach the engine down one path rather than two (the bead's
 * first decision: "do not write a second direction path").
 *
 * The pad is screen-relative in both camera modes, exactly like
 * ORBITAL_BINDINGS: up is up the screen whether the camera is orbiting or in
 * first person. There is no touch analogue of the first-person table's
 * arrows-turn rule because a finger already turns the camera by dragging it,
 * and a pad whose meaning changed under the thumb would be worse than one
 * that does not.
 *
 * The centre is `reset-facing` — the same thing keypad 5 (Clear) does. It is
 * view chrome: it swings the camera to north-up, answers no engine request
 * and costs no game time. Rest-a-turn, the other thing a centre could be, is
 * a real NetHack command and lives on the bar with the other verbs.
 */
export const PAD_GRID: readonly GazeAction[] = [
  "move-fwd-left", "move-fwd", "move-fwd-right",
  "move-left", "reset-facing", "move-right",
  "move-back-left", "move-back", "move-back-right",
];

/** What each pad key shows, in the same row-major order. */
export const PAD_LABEL: readonly string[] = [
  "↖", "↑", "↗",
  "←", "N", "→",
  "↙", "↓", "↘",
];

/** Screen-reader / long-press names, same order. */
export const PAD_TITLE: readonly string[] = [
  "Step up-left", "Step up", "Step up-right",
  "Step left", "Face north", "Step right",
  "Step down-left", "Step down", "Step down-right",
];

/**
 * What the engine is blocked on right now. Four prompt shapes plus "nothing",
 * because a touch UI that treats them as one breaks three of them:
 *  - `direction`  getdir()'s "In what direction?" — the pad answers it.
 *  - `yesno`      a yn_function with a fixed choice set — the yn chips
 *                 already answer it (vect-hack-be3.7) and the bar must not
 *                 compete with them.
 *  - `menu`       a full menu or a blocking text window — its own rows and
 *                 its own "press any key" are already clickable.
 *  - `line`       getlin()/askname() — an <input> the platform's own soft
 *                 keyboard fills; what it lacks is a way to say "done".
 */
export type PendingInput = "none" | "direction" | "yesno" | "menu" | "line";

/** What a pad tap does. `chrome` never reaches a native core — the hard rule
 *  that F2 and the camera controls live under, kept here for the pad centre. */
export type PadRoute = "step" | "answer" | "chrome" | "refuse";

/**
 * Route one pad tap.
 *
 * `answer` is a separate outcome from `step` and not a convenience: the same
 * compass direction means "walk there" to the command loop and "that way" to
 * a getdir() prompt, and the two travel through different gates — the second
 * is the one narrow exception a prompt grants (TextHud's `remap` doc comment,
 * and the same exception `sendKeys` grants a direction). A caller that could
 * not tell them apart would have to guess which gate to ask for.
 */
export function routePad(action: GazeAction, pending: PendingInput): PadRoute {
  if (action === "reset-facing" || action === "turn-left" || action === "turn-right") return "chrome";
  if (pending === "none") return "step";
  if (pending === "direction") return "answer";
  return "refuse";
}

/** What a bar tap does. A verb is a command, and a command belongs to the
 *  command loop: every prompt shape refuses it, including a direction prompt
 *  — sending `s` at "In what direction?" is how a search becomes a step
 *  south. */
export function routeCommand(pending: PendingInput): "send" | "refuse" {
  return pending === "none" ? "send" : "refuse";
}

/** What the bar shows. `locked` is drawn dimmed rather than hidden: the bar
 *  is the player's map of what the game can do, and a bar that vanishes every
 *  time the game asks a question reads as the UI breaking. */
export type BarMode = "commands" | "line" | "locked";

export function barMode(pending: PendingInput): BarMode {
  if (pending === "none") return "commands";
  if (pending === "line") return "line";
  return "locked";
}

/**
 * One slot on the action bar. `codes` is the Module's own encoding, already
 * resolved — the shared layer never learns what a letter means.
 *
 * There is no `kind: "camera"`: everything on the bar reaches the engine, and
 * everything that does not (the pad centre, the first-person toggle) is
 * somewhere else. That split is the constraint made structural rather than
 * remembered.
 */
export interface TouchBarItem {
  /** The glyph a thumb aims at. Deliberately the Module's own command key
   *  where there is one, so the bar teaches the keyboard game. */
  glyph: string;
  label: string;
  kind: "command" | "more";
  /** Required for `command`, absent for `more`. */
  codes?: readonly number[];
}

/** True when every bar slot is answerable — a `command` with keys to send or
 *  a `more` with none. Pinned by a test so an adapter cannot ship a slot that
 *  does nothing. */
export function barIsWellFormed(bar: readonly TouchBarItem[]): boolean {
  return bar.every((item) => item.kind === "more"
    ? item.codes === undefined
    : (item.codes?.length ?? 0) > 0);
}

/** The two buttons the bar swaps in while a line prompt is up, as bar slots
 *  so they draw exactly like a verb does. They carry no codes: neither is a
 *  key, and finishing a line goes through the Module's own getlin seam. */
export const LINE_ACCEPT: { glyph: string; label: string } = { glyph: "⏎", label: "Done" };
export const LINE_CANCEL: { glyph: string; label: string } = { glyph: "✕", label: "Cancel" };

/** The URL flag the whole layer is behind. Named here rather than spelled in
 *  main.ts and again in noKeyboard.ts: the two have to agree, because a page
 *  playing by touch must not also be told that touch cannot play. */
export const TOUCH_FLAG = "touch";

/** Whether a page's `location.search` asked for the touch scheme. */
export function touchRequested(search: string): boolean {
  return new URLSearchParams(search).has(TOUCH_FLAG);
}

/** Element ids, so the tests and the browser gate name them once. */
export const PAD_ID = "touchpad";
export const BAR_ID = "touchbar";
export const CAMERA_ID = "touchcam";
/** On <body> for the whole time the touch scheme is installed; every touch
 *  rule in index.html hangs off it, so a page without the flag is untouched. */
export const TOUCH_BODY_CLASS = "vh-touch";
