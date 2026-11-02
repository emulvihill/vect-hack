// The pure half of the control gate (fp-controls-check.mjs), split out for the
// same reason moria-gate-utils.mjs was: the rule is worth a test, and nothing
// inside a gate that needs a GPU and a dev server can have one.

/**
 * Is NetHack parked on a read the gaze bindings are armed for?
 *
 * Three facts, and the gate was reading none of them — it pressed a key, slept
 * a fixed 200 ms, and asserted against whatever that landed in (vect-hack-hfa).
 *
 *  - `parked`: TextHud's key queue has a waiter, so the engine is blocked in
 *    nhgetch and can produce nothing further of its own. Without it a message
 *    still in flight lands after the one an assertion is about, and an overlay
 *    still to come swallows the next keystroke.
 *  - `queued === 0`: nothing is buffered ahead of that read. Moria's arm
 *    refuses on the same count, and for the same reason — a key this gate did
 *    not mean to send is about to be consumed as though it did.
 *  - `pendingInput === "none"`: the engine is waiting for a COMMAND rather
 *    than for an answer, which is the one state TextHud consults `remap` in.
 *    A wait alone is not enough: a yn_function is a wait too, and there an
 *    arrow is a plain 'h' and not a turn.
 *
 * `needHero` is the boot case: a page can be parked on its first command read
 * before the level has reached the renderer.
 */
export function nethackArmed(state, needHero = false) {
  return !!state.parked
    && (state.queued ?? 0) === 0
    && state.pendingInput === "none"
    && (!!state.hero || !needHero);
}
