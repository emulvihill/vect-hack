/**
 * Console output a healthy run makes, shared by the gates that assert on it.
 *
 * It lives in its own file because a gate script does its whole run at import
 * time — importing browser-check.mjs to borrow a constant would drive ten arms
 * — and because a regex copied into a second gate is a regex that will be
 * updated in only one of them. That is not hypothetical: the borg gate went red
 * the day the save-risk work shipped, because browser-check.mjs's list learned
 * about the warning below and angband-borg-check.mjs had no list at all
 * (vect-hack-zt7).
 */

/**
 * **This warning is the application working, not a defect being suppressed.
 * Do not delete this entry to "clean up" a gate.**
 *
 * main.ts asks for the storage grant on boot (persistentStorage.ts), and
 * Chromium only grants it to an origin it has engagement history with.
 * Playwright launches a fresh ephemeral profile every run, so persist()
 * declines deterministically — every arm, every night, on every gate that opens
 * a page. src/ui/saveRisk.ts exists precisely to handle that answer: the player
 * gets a one-time notice and a marked Saves button, and this line is the app
 * saying so out loud.
 *
 * A gate that failed on it would be asserting something false, which this repo
 * holds to be worse than asserting nothing (vect-hack-azf).
 *
 * Only the DECLINED answer is expected. "no storage manager" and "the
 * persistence request failed" are the two ways that code reports something
 * genuinely wrong, and they must stay fatal in every gate — which is what the
 * whole-message anchors below are for. Anything merely worded like this stays
 * fatal too. Which answer each branch gives is pinned by
 * scripts/test/backplane-persistent-storage.test.ts, under npm test.
 */
export const STORAGE_DECLINED_WARNING =
  /^\[vect-hack\] saves may be evicted: the browser declined persistence$/;
