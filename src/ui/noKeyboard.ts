// What a phone or tablet visitor gets instead of an inert canvas
// (vect-hack-d72).
//
// Input here is keyboard-only — a roguelike needs dozens of distinct keys, and
// there is no touch control scheme yet (that is vect-hack-21k, a project of
// its own). Camera drag and point-to-look already work on touch, so the page
// is not dead; it just cannot take a turn. Until today it said none of that,
// and a shared link opened on a phone read as broken software.
//
// So: explain, and offer the one thing that genuinely needs no keys — the
// self-playing demo. ?bot hands NetHack and Larn to their bot players and
// ?borg hands Angband to its own built-in borg (src/main.ts is where all
// three are wired, and SELF_PLAY_FLAG below has to keep agreeing with it).
// A Module with no self-player (Moria, until vect-hack-s77l) gets the
// explanation and no offer: sending its visitor to another game's demo read
// as the site opening the wrong game.
//
// The detection is the part worth being careful about. `(pointer: coarse)`
// alone is not evidence of no keyboard: a touchscreen laptop matches it while
// sitting in front of a keyboard, and locking that visitor out would be a
// worse bug than the one this closes. Its primary pointer is still a mouse, so
// it reports `pointer: fine` and `hover: hover`; a phone reports neither. Both
// queries together is the test, and the decision is a pure function of their
// two answers so it can be pinned without a browser.

import { touchRequested } from "./touch/scheme";

/** The two media queries the decision is made from, already answered. */
export interface PointerEnvironment {
  /** `(pointer: coarse)` — the primary pointer is a fingertip, not a cursor. */
  coarsePointer: boolean;
  /** `(hover: none)` — the primary pointer cannot hover over a thing without
   *  committing to it. This is the half that excludes the touchscreen laptop. */
  hoverless: boolean;
}

/** True for a device whose only pointer is a finger, which in practice is a
 *  device with no keyboard. Deliberately not a user-agent sniff: what matters
 *  is the input the visitor has, not the name of the browser they have it in. */
export function isTouchOnly(env: PointerEnvironment): boolean {
  return env.coarsePointer && env.hoverless;
}

/** Which URL flag hands a Module to something that plays it without keys.
 *  Read off src/main.ts, the only place these are wired: ?bot builds
 *  BotPlayer for NetHack and LarnBotPlayer for Larn, ?borg hands Angband to
 *  the engine's own borg. Moria is absent because it has neither, and a demo
 *  that does not exist must never be offered — watchDemoFor answers null and
 *  the notice shows no button. */
export const SELF_PLAY_FLAG: Record<string, "bot" | "borg" | undefined> = {
  nethack: "bot",
  angband: "borg",
  larn: "bot",
};

/** How each Module is spelled to a player. */
export const GAME_LABELS: Record<string, string | undefined> = {
  nethack: "NetHack",
  angband: "Angband",
  larn: "Larn",
  moria: "Moria",
};

export interface WatchDemo {
  game: string;
  flag: "bot" | "borg";
}

/** The demo to offer someone currently pointed at `game`: its own, or none.
 *  Never another Module's — a visitor who picked Moria and was handed NetHack
 *  saw the wrong game open, not a demo. */
export function watchDemoFor(game: string): WatchDemo | null {
  const flag = SELF_PLAY_FLAG[game];
  return flag ? { game, flag } : null;
}

/** Whether this page is already the demo. Asked so that pressing the button
 *  is what dismisses the explanation: the page it lands on must not re-explain
 *  over the game it just started. */
export function demoRunning(game: string, search: string): boolean {
  const flag = SELF_PLAY_FLAG[game];
  return flag !== undefined && new URLSearchParams(search).has(flag);
}

/** The search string the demo button navigates to: this URL with the game and
 *  the self-play flag set, and every other flag (?gl, ?skin, ?view) kept —
 *  whoever sent the link may have meant them. The flag is set with an empty
 *  value, which main.ts reads exactly as a bare ?bot / ?borg does. */
export function watchDemoSearch(search: string, demo: WatchDemo): string {
  const params = new URLSearchParams(search);
  params.set("game", demo.game);
  params.set(demo.flag, "");
  return `?${params}`;
}

/**
 * The message. It says what is wrong, why, and what to do about it, and it
 * does not apologise: a keyboard game on a phone is a missing feature, not a
 * failure. "yet" is deliberate — touch support is a filed project, not a
 * decision against phones.
 */
export const NO_KEYBOARD_NOTICE =
  "VectHack is played with a keyboard, and there is no touch control scheme "
  + "yet, so a phone or tablet cannot take a turn. Open this page on a "
  + "computer to play.";

/** The second line: the offer. Camera drag genuinely works on touch, so this
 *  gives a watching visitor something of their own to do. */
export const WATCH_DEMO_NOTICE =
  "The game can play itself, though — no keys needed. Drag to spin the camera "
  + "while you watch.";

/** The button. Names the Module the demo plays. */
export function watchDemoLabel(demo: WatchDemo): string {
  return `Watch ${GAME_LABELS[demo.game] ?? demo.game} play itself`;
}

/** The escape hatch, and the reason it exists: an iPad with a keyboard case
 *  matches every query a bare iPad does. Rare, but being locked out of a game
 *  you can actually play is the one outcome worse than not being told why. */
export const DISMISS_LABEL = "I have a keyboard — let me play";

/** Element ids in index.html. */
export const NOTICE_ID = "nokeyboard";
export const NOTICE_TEXT_ID = "nokeyboardtext";
export const NOTICE_OFFER_ID = "nokeyboardoffer";
export const WATCH_BUTTON_ID = "nokeyboardwatch";
export const DISMISS_BUTTON_ID = "nokeyboarddismiss";

/** The same minimal element the rest of the shared chrome fakes in its tests. */
export interface NoticeElement {
  hidden: boolean | string;
  textContent?: string | null;
  addEventListener(type: "click", handler: () => void): void;
}

export interface NoticeDocument {
  getElementById(id: string): NoticeElement | null;
}

export interface NoKeyboardUi {
  /** The Module this page is playing — main.ts's explicit ?game, never a default. */
  game: string;
  /** `location.search`. */
  search: string;
  env?: PointerEnvironment | null;
  dom?: NoticeDocument | null;
  /** Given a search string, go there. */
  navigate?: (search: string) => void;
}

/**
 * Show the explanation, or leave the page exactly as it was.
 *
 * A visitor with a fine pointer or a hoverable one reaches the second line of
 * this function and nothing else: on a desktop this file changes nothing, and
 * that is the constraint it is built around.
 */
export function installNoKeyboardNotice(ui: NoKeyboardUi): void {
  const env = ui.env === undefined ? browserPointerEnvironment() : ui.env;
  if (!env || !isTouchOnly(env)) return;
  // ?touch builds the thumb pad and the action bar (vect-hack-21k), so this
  // page's whole premise — "a phone cannot take a turn" — is false on it.
  // Checked before the demo case below and for the same reason: an
  // explanation drawn over a game that works is worse than no explanation.
  if (touchRequested(ui.search)) return;
  // Already watching: the button worked, and the page it opened must show the
  // game rather than the reason the game cannot be played.
  if (demoRunning(ui.game, ui.search)) return;
  const dom = ui.dom === undefined ? defaultDocument() : ui.dom;
  const notice = dom?.getElementById(NOTICE_ID);
  if (!dom || !notice) return;

  const demo = watchDemoFor(ui.game);
  const text = dom.getElementById(NOTICE_TEXT_ID);
  if (text) text.textContent = NO_KEYBOARD_NOTICE;
  // No self-player: the offer and its button stay out of the page entirely.
  const offer = dom.getElementById(NOTICE_OFFER_ID);
  if (offer) {
    offer.hidden = !demo;
    if (demo) offer.textContent = WATCH_DEMO_NOTICE;
  }
  const watch = dom.getElementById(WATCH_BUTTON_ID);
  if (watch) {
    watch.hidden = !demo;
    if (demo) {
      watch.textContent = watchDemoLabel(demo);
      const go = ui.navigate ?? browserNavigate;
      watch.addEventListener("click", () => go(watchDemoSearch(ui.search, demo)));
    }
  }
  const dismiss = dom.getElementById(DISMISS_BUTTON_ID);
  if (dismiss) {
    dismiss.textContent = DISMISS_LABEL;
    // Not remembered anywhere: the visitor who needs it is holding the
    // keyboard, and the visitor who does not should get the explanation again
    // rather than a game that ignores them.
    dismiss.addEventListener("click", () => { notice.hidden = true; });
  }
  notice.hidden = false;
}

/** The queries, asked of the real browser. A browser with no matchMedia at all
 *  answers nothing, and nothing is shown: this is an added explanation, never
 *  a gate something has to pass to reach the game. */
export function browserPointerEnvironment(): PointerEnvironment | null {
  const g = globalThis as { matchMedia?: (query: string) => { matches: boolean } };
  if (typeof g.matchMedia !== "function") return null;
  return {
    coarsePointer: g.matchMedia("(pointer: coarse)").matches,
    hoverless: g.matchMedia("(hover: none)").matches,
  };
}

function browserNavigate(search: string): void {
  location.assign(`${location.pathname}${search}${location.hash}`);
}

function defaultDocument(): NoticeDocument | null {
  return typeof document === "undefined" ? null : document;
}
