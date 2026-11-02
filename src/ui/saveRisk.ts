// The one place "this browser has not promised to keep your saved games"
// becomes something a player can see (vect-hack-h4q).
//
// requestPersistentStorage() asks for the origin-wide eviction exemption once
// per page and resolves to whether the browser gave it
// (src/backplane/persistentStorage.ts). Until now every answer went to
// console.warn and main.ts discarded the boolean, so the state reached nobody.
// It is not an exotic one either: Chrome declines the grant deterministically
// for an origin it has no engagement history with, which is every first visit.
// This is a permadeath game — a character is hours of play — and the F3/F4
// export is a real escape hatch that a player has no reason to use while they
// believe their saves are safe.
//
// Two marks, decided together and neither sufficient alone: a one-time
// sentence that explains, whose dismissal persists so a returning player is
// not nagged, and a permanent change to the Saves button that outlives the
// dismissal. Both are drawn only for an origin that really is unpersisted —
// a warning about something that cannot happen is noise the next real warning
// pays for.
//
// Its harder sibling arrived later (vect-hack-dem) and lives here too: the tab
// that cannot save AT ALL, right now. The two states are one banner and one
// button apart, they can be true at once, and only a file that can see both
// can decide which one the player is shown — so both live here, and the copy
// for both is here rather than in the worker that detects the second.
import { SAVE_BUTTON_ID } from "./saveMenu.ts";
import type { SessionOnlyCode } from "../backplane/persistFs.ts";

/** Element ids in index.html. All optional, like the save panel's: a view that
 *  removed the chrome loses the mark, not the game. */
export const RISK_NOTICE_ID = "storagenotice";
export const RISK_NOTICE_TEXT_ID = "storagenoticetext";
export const RISK_NOTICE_DISMISS_ID = "storagenoticedismiss";

/** The class index.html styles the at-risk Saves button with. */
export const SAVE_AT_RISK_CLASS = "atrisk";

/** And the class for the harder state. A second mark rather than a reuse of
 *  the first, because the two say different things — "keep a copy" against
 *  "there is nothing to keep" — and rather than a disabled button, because a
 *  button that does nothing and says nothing teaches the player nothing. */
export const SAVE_NO_SAVE_CLASS = "nosave";

/** Set once the player has read the sentence. View state, like the skin
 *  choice: it lives in localStorage rather than in a volume, because it is
 *  about this browser rather than about any one game's save. */
export const RISK_NOTICE_DISMISSED_KEY = "vect-hack.storage-notice-dismissed";

/**
 * One sentence, and it has to do two things at once: say what may happen in
 * words a player already owns — "delete", not the browser's own "evict" — and
 * name the concrete action that makes it survivable. "may" and "if it needs
 * the space" are load-bearing: for most visitors nothing will ever be deleted,
 * and a sentence that overstates this is one the next one is not believed for.
 */
export const SAVE_AT_RISK_NOTICE =
  "This browser may delete your saved games if it needs the space — the Saves "
  + "button, bottom left, downloads a copy you can keep.";

/**
 * One sentence per class of "this tab cannot save at all", and each one has to
 * carry a fact and an action (vect-hack-dem).
 *
 * The action here is the one that gets the player a tab that can STORE a game,
 * and it differs three ways. The action that saves the character they are
 * playing right now does not differ at all, so it is a fourth sentence shared
 * by all three (SESSION_ONLY_RESCUE) rather than three near-copies.
 *
 * `another-tab` is deliberately flat — no "risk", no "warning", no "may". The
 * other tab is playing the real game and this one is a scratch copy; that is
 * a thing that happened, not an alarm, and the action is a door the player can
 * open in five seconds. `browser-cannot` names Chrome and Firefox for the same
 * reason GPU_UNAVAILABLE_NOTICE does (src/ui/gpuSupport.ts): "unsupported" is
 * a dead end and a browser name is a next step.
 */
export const SESSION_ONLY_NOTICES: Record<SessionOnlyCode, string> = {
  "another-tab":
    "Your other tab owns this game's saved games, so nothing you do here will "
    + "be saved. Close the other tab and reload to play a game you can keep.",
  "browser-cannot":
    "This browser cannot store saved games, so this character will be gone "
    + "when you close the tab. Chrome or Firefox can store them.",
  "setup-failed":
    "Something went wrong setting up saved games, so this character will not "
    + "be saved. Reload the page to try again.",
};

/**
 * The half that is the same in all three states, and the reason this file
 * changed (vect-hack-47a).
 *
 * The three sentences above used to end there, and deliberately named no
 * action for the character on screen, because there was none: exportSave()
 * checked `persistent` before it touched a filesystem, so the Saves button
 * answered "there is nothing to export" in exactly these three states. It
 * does not any more — a tab with no volume packs the engine's own writable
 * paths — so the button is a real escape hatch here and the copy may finally
 * point at it.
 *
 * "save inside the game" is load-bearing and not a hedge. An export packs what
 * the engine has WRITTEN, and a session-only tab gets no autosave: the
 * checkpointer is only built for a tab that owns a volume. Until the player
 * uses the game's own save command there is nothing on disk to pack, and copy
 * that skipped that step would hand them an empty file and call it their
 * character.
 */
export const SESSION_ONLY_RESCUE =
  "You can still keep this character: save inside the game, then press Saves, "
  + "bottom left, for a copy you can load back later.";

/** The whole mapping, as a function, so a caller cannot index the record with
 *  something the wire made up. A code this build does not know is itself a
 *  thing that went wrong setting up saved games, which is what that sentence
 *  says — and a silent `undefined` in the banner would say nothing at all.
 *  The rescue is appended here rather than written into each sentence: there
 *  is one escape hatch, and three copies of it would drift. */
export function sessionOnlyNotice(code: SessionOnlyCode): string {
  const notice = SESSION_ONLY_NOTICES[code] ?? SESSION_ONLY_NOTICES["setup-failed"];
  return `${notice} ${SESSION_ONLY_RESCUE}`;
}

/** What the Saves button says it is for once this tab cannot store a game. It
 *  promises an export, because there is one now (vect-hack-47a) — and it says
 *  what that export is worth: a copy, not a saved game this browser is
 *  keeping. It says the one thing that is true of all three classes. */
export const SAVE_NO_SAVE_TITLE =
  "Save files — this tab cannot store your game, but it can still download a "
  + "copy you keep yourself";

/** The dismiss control's label: an acknowledgement, not a decision. */
export const RISK_NOTICE_DISMISS_LABEL = "Got it";

/** What the Saves button says it is for while the origin is unpersisted. The
 *  mark is a colour and a dot; this is the half a hover or a long press can
 *  read, and the only place the reason survives after the sentence is gone. */
export const SAVE_AT_RISK_TITLE =
  "Save files — this browser may delete your saved games, so keep a copy";

/** Just enough of an element to unhide, label, mark, and click. The tests run
 *  without a DOM, and this is the whole surface they would have to fake. */
export interface RiskElement {
  /** boolean out of this file, and string too on the way in: the DOM's own
   *  `hidden` carries the "until-found" values as well. */
  hidden: boolean | string;
  title?: string;
  textContent?: string | null;
  /** All three calls, because the button is where the precedence between the
   *  two states is recorded: the stronger mark replaces the weaker one, and
   *  the weaker call has to be able to see that it already lost. */
  classList?: {
    add(token: string): void;
    remove(token: string): void;
    contains(token: string): boolean;
  };
  addEventListener(type: "click", handler: () => void): void;
}

export interface RiskDocument {
  getElementById(id: string): RiskElement | null;
}

/** The two localStorage calls this needs. Structural so a test can supply a
 *  map, and so a browser that throws on storage access can supply nothing. */
export interface DismissalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SaveRiskUi {
  /** What requestPersistentStorage() resolved to. True means the browser has
   *  promised to keep this origin's storage, and nothing here is drawn. */
  persisted: boolean;
  dom?: RiskDocument | null;
  store?: DismissalStore | null;
}

/**
 * Draw the at-risk state, or nothing at all.
 *
 * Called from main.ts off the grant's `.then()` rather than an `await`: the
 * request is deliberately fired without boot waiting on it, because a
 * permission heuristic must never stand in front of an engine starting. That
 * means this can land after the views and the save menu exist, which is why it
 * reaches the button by id rather than by holding a reference to it.
 */
export function showSaveRisk(ui: SaveRiskUi): void {
  // The whole point of the boolean: a browser that granted the exemption has
  // nothing wrong with it, so it gets no banner and no marked button.
  if (ui.persisted) return;
  const dom = ui.dom === undefined ? defaultDocument() : ui.dom;
  if (!dom) return;
  // The two calls race — this one comes off the storage grant, the other off
  // the worker's mount — and this one always loses. "Your saves may be deleted
  // one day, keep a copy" is a smaller and a differently-actioned truth than
  // "nothing here is being saved, and that button will not help you", and
  // drawing the smaller one over the larger is the exact failure vect-hack-dem
  // exists to close.
  if (cannotSaveAtAll(dom)) return;
  markSaveButton(dom);
  showNotice(dom, ui.store === undefined ? defaultStore() : ui.store);
}

export interface SessionOnlySaveUi {
  /** Which of the three classes the worker's mount landed in. */
  code: SessionOnlyCode;
  dom?: RiskDocument | null;
  /** The store this path must never write through. It is taken rather than
   *  ignored because the two calls share one dismiss control, so this one has
   *  to hand the shared arming somewhere real — and because a test can only
   *  hold "nothing was persisted" against a store it can watch. */
  store?: DismissalStore | null;
}

/**
 * Draw the "this tab cannot save at all" state.
 *
 * Called from main.ts when the Backplane routes a `sessionOnly` message off
 * any Module's worker (src/backplane/session.ts). It reaches the chrome by id
 * for the same reason showSaveRisk does: it lands whenever the mount settles,
 * which is after the views and the save menu exist and may be before or after
 * the storage grant resolves.
 *
 * No dismissal is remembered. The at-risk sentence persists its dismissal
 * because it is a fact about this *browser* and will be just as true tomorrow;
 * this one is a fact about this *tab* — a closed second tab, a reload past a
 * failed setup — and a remembered dismissal would silently hide a different
 * situation on a later visit, which is the one thing worse than saying it
 * twice.
 */
export function showSessionOnlySaves(ui: SessionOnlySaveUi): void {
  const dom = ui.dom === undefined ? defaultDocument() : ui.dom;
  if (!dom) return;
  const button = dom.getElementById(SAVE_BUTTON_ID);
  if (button) {
    // The at-risk mark and its title have to GO, not sit underneath: both
    // states send the player to the same button and they are worth different
    // things there — "keep a copy, this browser may delete the original"
    // against "there is no original; the copy is all there will be".
    button.classList?.remove(SAVE_AT_RISK_CLASS);
    button.classList?.add(SAVE_NO_SAVE_CLASS);
    button.title = SAVE_NO_SAVE_TITLE;
  }
  const notice = dom.getElementById(RISK_NOTICE_ID);
  if (!notice) return;
  const text = dom.getElementById(RISK_NOTICE_TEXT_ID);
  // Unconditionally, over whatever the at-risk sentence put there, and shown
  // even if that sentence was dismissed a moment ago: this is not the same
  // sentence being repeated, it is a different and larger thing being said.
  if (text) text.textContent = sessionOnlyNotice(ui.code);
  armDismiss(dom, notice, text, ui.store === undefined ? defaultStore() : ui.store);
  notice.hidden = false;
}

/** Is the stronger warning already drawn? The page is the record — this file
 *  keeps no state of its own, so the two calls may land in either order and a
 *  test may drive them in either order. The button carries it when there is
 *  one; the banner's own text is the fallback for a view that removed the
 *  button but kept the notice. */
function cannotSaveAtAll(dom: RiskDocument): boolean {
  if (dom.getElementById(SAVE_BUTTON_ID)?.classList?.contains(SAVE_NO_SAVE_CLASS)) return true;
  const shown = dom.getElementById(RISK_NOTICE_TEXT_ID)?.textContent ?? null;
  // The rescue clause, which every session-only sentence ends with and no
  // other sentence contains. Matched on rather than compared whole because the
  // banner carries a composed sentence: an exact match against the three
  // halves in SESSION_ONLY_NOTICES would find none of them.
  return shown !== null && shown.includes(SESSION_ONLY_RESCUE);
}

/** The persistent half: it outlives the sentence being dismissed, and it is
 *  the only reminder a player who dismissed on their first visit ever sees. */
function markSaveButton(dom: RiskDocument): void {
  const button = dom.getElementById(SAVE_BUTTON_ID);
  if (!button) return;
  button.classList?.add(SAVE_AT_RISK_CLASS);
  button.title = SAVE_AT_RISK_TITLE;
}

/** The one-time half. A store that cannot be read is treated as a browser the
 *  player has not answered on yet: explaining twice is a smaller failure than
 *  never explaining at all. */
function showNotice(dom: RiskDocument, store: DismissalStore | null): void {
  const notice = dom.getElementById(RISK_NOTICE_ID);
  if (!notice || read(store) !== null) return;
  const text = dom.getElementById(RISK_NOTICE_TEXT_ID);
  if (text) text.textContent = SAVE_AT_RISK_NOTICE;
  armDismiss(dom, notice, text, store);
  notice.hidden = false;
}

/**
 * Wire the banner's one dismiss control, for whichever sentence is on it.
 *
 * Shared by both callers, and the sharing is the whole point: there is one
 * control, and after both have drawn it carries both handlers. So whether a
 * click is remembered cannot be decided by which call installed the handler —
 * it is decided from what the banner is SHOWING at the moment of the click.
 * Only the at-risk sentence is ever spent, because only it is a fact about
 * this browser that will still be true tomorrow. A click that dismissed the
 * session-only sentence must write nothing, or the at-risk sentence is burned
 * on a player who never read it, and that one never comes back.
 *
 * This is why showSessionOnlySaves takes a store it must never write through:
 * "this path persists nothing" is a claim about a real store or it is not a
 * claim at all (docs/DECISIONS.md, vect-hack-azf).
 */
function armDismiss(
  dom: RiskDocument,
  notice: RiskElement,
  text: RiskElement | null,
  store: DismissalStore | null,
): void {
  const dismiss = dom.getElementById(RISK_NOTICE_DISMISS_ID);
  if (!dismiss) return;
  dismiss.textContent = RISK_NOTICE_DISMISS_LABEL;
  dismiss.addEventListener("click", () => {
    notice.hidden = true;
    if (text?.textContent === SAVE_AT_RISK_NOTICE) write(store);
  });
}

function read(store: DismissalStore | null): string | null {
  try {
    return store?.getItem(RISK_NOTICE_DISMISSED_KEY) ?? null;
  } catch {
    return null; // private mode, or storage access denied outright
  }
}

function write(store: DismissalStore | null): void {
  try {
    store?.setItem(RISK_NOTICE_DISMISSED_KEY, "1");
  } catch { /* ditto: a nag is not worth a thrown boot */ }
}

function defaultDocument(): RiskDocument | null {
  return typeof document === "undefined" ? null : document;
}

function defaultStore(): DismissalStore | null {
  const g = globalThis as { localStorage?: DismissalStore };
  try {
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}
