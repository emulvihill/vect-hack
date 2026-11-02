// The save-durability warning (vect-hack-h4q). Two things are worth pinning
// here and they pull in opposite directions: the at-risk state has to reach
// the screen at all, which it never did before, and the granted state has to
// reach nothing at all — a browser that promised to keep the origin's storage
// must not be told it might delete a character.
//
// The wording is checked as copy, not as an exact string. It is player-facing
// and Eric owns it; what a test can honestly hold is that it names the action
// (the Saves button) and does not fall back into browser jargon.
//
// The second half of this file is the harder state (vect-hack-dem): a tab that
// cannot save AT ALL. Three things are pinned there that the copy alone cannot
// carry — that each of the three codes gets its own sentence, that none of
// those sentences leaks the exception text the code was derived from, and that
// this state beats the at-risk one on the single banner and the single button.
import { describe, expect, it } from "vitest";
import { SAVE_BUTTON_ID } from "../../src/ui/saveMenu";
import {
  mountVolume, type LockManagerLike, type SessionOnlyReason,
} from "../../src/backplane/persistFs";
import { VOLUMES } from "../../src/backplane/volumes";
import {
  RISK_NOTICE_DISMISSED_KEY, RISK_NOTICE_DISMISS_ID, RISK_NOTICE_ID,
  RISK_NOTICE_TEXT_ID, SAVE_AT_RISK_CLASS, SAVE_AT_RISK_NOTICE, SAVE_AT_RISK_TITLE,
  SAVE_NO_SAVE_CLASS, SAVE_NO_SAVE_TITLE, SESSION_ONLY_NOTICES, SESSION_ONLY_RESCUE,
  sessionOnlyNotice,
  showSaveRisk, showSessionOnlySaves,
  type DismissalStore, type RiskDocument, type RiskElement,
} from "../../src/ui/saveRisk";

class FakeElement implements RiskElement {
  hidden: boolean | string = true;
  title = "";
  textContent: string | null = null;
  readonly classes = new Set<string>();
  readonly classList = {
    add: (token: string) => { this.classes.add(token); },
    remove: (token: string) => { this.classes.delete(token); },
    contains: (token: string) => this.classes.has(token),
  };
  private handlers: (() => void)[] = [];
  addEventListener(_type: "click", handler: () => void) { this.handlers.push(handler); }
  click() { for (const handler of this.handlers) handler(); }
}

class FakeDom implements RiskDocument {
  readonly els = new Map<string, FakeElement>();
  constructor(ids: string[]) {
    for (const id of ids) this.els.set(id, new FakeElement());
  }
  getElementById(id: string) { return this.els.get(id) ?? null; }
  el(id: string) { return this.els.get(id)!; }
}

class FakeStore implements DismissalStore {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
}

const chrome = () => new FakeDom([
  SAVE_BUTTON_ID, RISK_NOTICE_ID, RISK_NOTICE_TEXT_ID, RISK_NOTICE_DISMISS_ID,
]);

/**
 * A real mount that fails, so a test can take the reason the Backplane
 * actually recorded rather than one written here by hand.
 *
 * The point is the exception text: persistFs.ts splices `String(err)` into the
 * detail, and the only honest way to show that the screen never sees it is to
 * put a real exception into a real mount and follow the reason out to the
 * banner. Everything else about this fake is the minimum mountVolume touches
 * on the way to the failing populate syncfs.
 */
async function failedMount(err: Error): Promise<SessionOnlyReason | null> {
  const FS = {
    filesystems: { IDBFS: {} },
    mkdir() {}, mount() {}, unmount() {}, symlink() {},
    syncfs(_populate: boolean, callback: (e?: unknown) => void) { callback(err); },
  };
  const locks: LockManagerLike = {
    request: (_name, _options, callback) => Promise.resolve(callback({})),
  };
  const handle = mountVolume(
    { FS, addRunDependency() {}, removeRunDependency() {} },
    VOLUMES.larn,
    { locks, seed: () => {} },
  );
  await handle.ready;
  return handle.reason;
}

describe("an origin the browser refused to persist", () => {
  it("shows the one-time notice and marks the Saves button", () => {
    const dom = chrome(), store = new FakeStore();

    showSaveRisk({ persisted: false, dom, store });

    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(false);
    expect(dom.el(RISK_NOTICE_TEXT_ID).textContent).toBe(SAVE_AT_RISK_NOTICE);
    expect(dom.el(SAVE_BUTTON_ID).classes.has(SAVE_AT_RISK_CLASS)).toBe(true);
    expect(dom.el(SAVE_BUTTON_ID).title).toBe(SAVE_AT_RISK_TITLE);
  });

  it("remembers the dismissal so a returning player is not nagged", () => {
    const dom = chrome(), store = new FakeStore();
    showSaveRisk({ persisted: false, dom, store });

    dom.el(RISK_NOTICE_DISMISS_ID).click();
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(true);
    expect(store.getItem(RISK_NOTICE_DISMISSED_KEY)).not.toBeNull();

    // The next boot, same browser: the sentence is spent.
    const next = chrome();
    showSaveRisk({ persisted: false, dom: next, store });
    expect(next.el(RISK_NOTICE_ID).hidden).toBe(true);
  });

  it("keeps marking the button after the notice is dismissed", () => {
    const dom = chrome(), store = new FakeStore();
    store.setItem(RISK_NOTICE_DISMISSED_KEY, "1");

    showSaveRisk({ persisted: false, dom, store });

    // The whole reason the mark exists: it is the only warning a player who
    // dismissed on their first visit ever sees again.
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(true);
    expect(dom.el(SAVE_BUTTON_ID).classes.has(SAVE_AT_RISK_CLASS)).toBe(true);
  });

  it("explains again rather than never, when storage cannot be read", () => {
    const dom = chrome();
    const throwing: DismissalStore = {
      getItem: () => { throw new Error("SecurityError: storage access denied"); },
      setItem: () => { throw new Error("SecurityError: storage access denied"); },
    };

    showSaveRisk({ persisted: false, dom, store: throwing });
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(false);
    // And dismissing it must not throw out of the click handler.
    expect(() => dom.el(RISK_NOTICE_DISMISS_ID).click()).not.toThrow();
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(true);
  });

  it("marks the button in a page that has no notice chrome at all", () => {
    const dom = new FakeDom([SAVE_BUTTON_ID]);
    showSaveRisk({ persisted: false, dom, store: new FakeStore() });
    expect(dom.el(SAVE_BUTTON_ID).classes.has(SAVE_AT_RISK_CLASS)).toBe(true);
  });
});

describe("an origin the browser did persist", () => {
  it("says nothing and marks nothing", () => {
    const dom = chrome(), store = new FakeStore();

    showSaveRisk({ persisted: true, dom, store });

    // Not "shows a quieter warning": nothing. A grant that was given means
    // there is nothing to warn about, and a warning that fires anyway is what
    // teaches a player to ignore the next one.
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(true);
    expect(dom.el(RISK_NOTICE_TEXT_ID).textContent).toBeNull();
    expect(dom.el(SAVE_BUTTON_ID).classes.size).toBe(0);
    expect(dom.el(SAVE_BUTTON_ID).title).toBe("");
    expect(store.items.size).toBe(0);
  });
});

describe("the wording", () => {
  it("names the action and stays out of browser jargon", () => {
    expect(SAVE_AT_RISK_NOTICE).toMatch(/Saves button/);
    expect(SAVE_AT_RISK_NOTICE).toMatch(/delete/i);
    // "evict" is what the storage spec calls it, and no player does.
    expect(SAVE_AT_RISK_NOTICE).not.toMatch(/evict|quota|persist|origin|IndexedDB/i);
    // One sentence, and calm about it: nothing has gone wrong yet.
    expect(SAVE_AT_RISK_NOTICE.split(". ")).toHaveLength(1);
    expect(SAVE_AT_RISK_NOTICE).not.toMatch(/error|fail|warning|lost/i);
    expect(SAVE_AT_RISK_TITLE).not.toMatch(/evict|quota/i);
  });
});

// ---------------------------------------------------------------------------
// vect-hack-dem: the tab that cannot save at all.

describe("a tab whose save volume never mounted", () => {
  it("gives each of the three classes its own sentence", () => {
    // Not "some sentence per code": these exact three, because what separates
    // them is the action each one names, and a copy edit that quietly merged
    // two of them would leave a player doing the wrong thing about it.
    expect(sessionOnlyNotice("another-tab")).toBe(
      "Your other tab owns this game's saved games, so nothing you do here will "
      + "be saved. Close the other tab and reload to play a game you can keep. "
      + SESSION_ONLY_RESCUE);
    expect(sessionOnlyNotice("browser-cannot")).toBe(
      "This browser cannot store saved games, so this character will be gone "
      + "when you close the tab. Chrome or Firefox can store them. "
      + SESSION_ONLY_RESCUE);
    expect(sessionOnlyNotice("setup-failed")).toBe(
      "Something went wrong setting up saved games, so this character will not "
      + "be saved. Reload the page to try again. "
      + SESSION_ONLY_RESCUE);
  });

  it("shows the sentence and marks the Saves button", () => {
    const dom = chrome();

    showSessionOnlySaves({ code: "browser-cannot", dom });

    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(false);
    expect(dom.el(RISK_NOTICE_TEXT_ID).textContent)
      .toBe(sessionOnlyNotice("browser-cannot"));
    expect(dom.el(SAVE_BUTTON_ID).classes.has(SAVE_NO_SAVE_CLASS)).toBe(true);
    expect(dom.el(SAVE_BUTTON_ID).title).toBe(SAVE_NO_SAVE_TITLE);
  });

  it("forgets the dismissal, so a later page load is told again", () => {
    const dom = chrome(), store = new FakeStore();

    // The store is handed in so the assertion below is about something this
    // call can actually reach: showSessionOnlySaves passes it to the shared
    // dismiss arming, and an implementation that decided to remember this
    // dismissal would write into exactly this object.
    showSessionOnlySaves({ code: "another-tab", dom, store });
    dom.el(RISK_NOTICE_DISMISS_ID).click();
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(true);

    // Nothing written, and deliberately: the at-risk sentence remembers its
    // dismissal because it is about this browser and will be equally true
    // tomorrow. This one is about this tab. A player who closes the second tab
    // and reloads is in a different situation, and a remembered dismissal
    // would hide the next one — which might be a different class entirely.
    expect(store.items.size).toBe(0);

    const next = chrome();
    showSessionOnlySaves({ code: "another-tab", dom: next, store });
    expect(next.el(RISK_NOTICE_ID).hidden).toBe(false);
  });

  it("keeps a mount's exception text off the screen", async () => {
    // Derived the way the real thing is, not hand-written: mount a volume
    // whose populate syncfs fails with an exception, and take the code the
    // Backplane recorded. persistFs.ts splices String(err) into the detail, so
    // "boom" is genuinely in the reason this banner was raised from.
    const reason = await failedMount(new Error("boom"));
    expect(reason?.detail).toContain("boom");
    expect(reason?.code).toBe("browser-cannot");

    const dom = chrome();
    showSessionOnlySaves({ code: reason!.code, dom });

    // Today the seam makes this structural: showSessionOnlySaves is handed a
    // code and has no way to reach the detail. That is the design, and this is
    // the net under it — the first assertions above are the live half, since
    // they fail the moment the mount stops classifying that exception as
    // browser-cannot, and these two fail the moment the seam widens to carry
    // the reason itself.
    const shown = `${dom.el(RISK_NOTICE_TEXT_ID).textContent} ${dom.el(SAVE_BUTTON_ID).title}`;
    expect(shown).not.toContain("boom");
    expect(shown).not.toMatch(/Error|IndexedDB|syncfs/);
  });

  it("sends the player to the button, and to the save command it needs first", () => {
    // The inverse of what this test used to pin, and the inversion is the
    // whole of vect-hack-47a. exportSave() used to check `persistent` before
    // it touched a filesystem, so the Saves button answered "there is nothing
    // to export" in exactly these three states and no copy could name it.
    // A session-only tab now packs the engine's own writable paths, so the
    // button is a real escape hatch and every one of the three says so.
    for (const code of ["another-tab", "browser-cannot", "setup-failed"] as const) {
      expect(sessionOnlyNotice(code)).toMatch(/press Saves/);
      // And names the step before it. An export packs what the engine has
      // WRITTEN, and a session-only tab gets no autosave — the checkpointer is
      // built only for a tab that owns a volume. Copy that sent a player
      // straight to the button would hand them an empty file.
      expect(sessionOnlyNotice(code)).toMatch(/save inside the game/);
    }
    // The button's own words promise a copy the player keeps, never a saved
    // game this browser is keeping: those are different things and this state
    // is exactly where they come apart.
    expect(SAVE_NO_SAVE_TITLE).toMatch(/download/i);
    expect(SAVE_NO_SAVE_TITLE).not.toMatch(/\bkept\b|\bstores your\b/i);
  });

  it("tells the other-tab player what happened without alarming them", () => {
    const sentence = SESSION_ONLY_NOTICES["another-tab"];
    // The other tab is playing the real game and this one is a scratch copy.
    // That is a thing that has happened, not a hazard that might: no hedging,
    // and none of the vocabulary the at-risk sentence needs.
    expect(sentence).not.toMatch(/\brisk\b|\bwarning\b|\bmay\b/i);
    // And an action, because there is one: close the other tab.
    expect(sentence).toMatch(/Close the other tab/);
  });
});

describe("both save warnings at once", () => {
  // The case is ordinary, not exotic: a second tab on an origin Chrome has
  // never granted persistence to. One banner element, one Saves button, and
  // two true things to say on them.

  it("replaces the at-risk banner and mark when the harder state arrives", () => {
    const dom = chrome(), store = new FakeStore();
    showSaveRisk({ persisted: false, dom, store });

    showSessionOnlySaves({ code: "another-tab", dom });

    expect(dom.el(RISK_NOTICE_TEXT_ID).textContent)
      .toBe(sessionOnlyNotice("another-tab"));
    expect(dom.el(SAVE_BUTTON_ID).classes.has(SAVE_NO_SAVE_CLASS)).toBe(true);
    // The at-risk mark has to GO rather than sit underneath: its title tells
    // the player to press the Saves button, which refuses in this state.
    expect(dom.el(SAVE_BUTTON_ID).classes.has(SAVE_AT_RISK_CLASS)).toBe(false);
    expect(dom.el(SAVE_BUTTON_ID).title).toBe(SAVE_NO_SAVE_TITLE);
  });

  it("keeps the harder state when the grant answers second", () => {
    // The two calls race — one comes off the storage grant, the other off the
    // worker's mount — and nothing orders them. The weaker one always loses.
    const dom = chrome(), store = new FakeStore();
    showSessionOnlySaves({ code: "browser-cannot", dom });

    showSaveRisk({ persisted: false, dom, store });

    expect(dom.el(RISK_NOTICE_TEXT_ID).textContent)
      .toBe(sessionOnlyNotice("browser-cannot"));
    expect(dom.el(SAVE_BUTTON_ID).classes.has(SAVE_AT_RISK_CLASS)).toBe(false);
    expect(dom.el(SAVE_BUTTON_ID).title).toBe(SAVE_NO_SAVE_TITLE);
  });

  it("shows the harder sentence even after the at-risk one was dismissed", () => {
    const dom = chrome(), store = new FakeStore();
    store.setItem(RISK_NOTICE_DISMISSED_KEY, "1");
    showSaveRisk({ persisted: false, dom, store });
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(true);

    showSessionOnlySaves({ code: "setup-failed", dom });

    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(false);
    expect(dom.el(RISK_NOTICE_TEXT_ID).textContent)
      .toBe(sessionOnlyNotice("setup-failed"));
  });

  it("does not spend the at-risk dismissal on a click that dismissed the other", () => {
    const dom = chrome(), store = new FakeStore();
    showSaveRisk({ persisted: false, dom, store });
    showSessionOnlySaves({ code: "another-tab", dom, store });

    dom.el(RISK_NOTICE_DISMISS_ID).click();

    // One dismiss control ends up carrying both handlers. The click dismissed
    // the session-only sentence; the at-risk one is still unread, and its
    // dismissal never comes back once it is written.
    expect(dom.el(RISK_NOTICE_ID).hidden).toBe(true);
    expect(store.getItem(RISK_NOTICE_DISMISSED_KEY)).toBeNull();
  });
});
