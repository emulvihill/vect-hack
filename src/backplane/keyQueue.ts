// The Backplane's input mechanism: the buffer-or-waiter queue NetHack and
// Angband had each written independently (TextHud's keyQueue/pendingKey
// pair, TtyView's buffer/waiter pair), extracted once and now used by all
// four Modules. Single consumer by design — each engine has exactly one
// blocking suspend point, so at most one waiter is ever parked. Everything
// richer (movement resolution, count prefixes, prompts, menus) is Module UI,
// not Backplane.
// Vocabulary per CONTEXT.md; nothing here may import from src/modules/*,
// src/render/ or src/ui/, and it never touches the DOM.
export class KeyQueue<K> {
  private buffer: K[] = [];
  private waiter: ((k: K | null) => void) | null = null;
  /** Set once by cancel(); never cleared. See cancel() for why one-way. */
  private cancelled = false;

  push(k: K): void {
    if (this.cancelled) return; // a key for a view that is gone
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(k);
    } else {
      this.buffer.push(k);
    }
  }

  /** wait=false answers immediately (null = none); wait=true may block, and
   *  throws if a waiter is already parked (the single-consumer invariant).
   *  Empty is `undefined` from shift(), never a falsy key: TtyView's copy
   *  tested the shifted value for truth, which only held because its keys
   *  are objects — TextHud's are numbers, and NUL (0) is a real key. */
  next(wait: boolean): K | null | Promise<K | null> {
    // After cancel() nothing can ever push again, so parking a waiter here
    // would be building the hang this method's own invariant exists to
    // prevent. "No key" is the honest answer, and it is one every caller
    // already handles.
    if (this.cancelled) return null;
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return buffered;
    if (!wait) return null;
    // Parking a second waiter would drop the first on the floor and hang
    // whoever holds its promise, silently. Unreachable while the invariant
    // holds — each engine suspends on one key at a time — so the throw costs
    // nothing today and turns a future hang into a stack trace.
    if (this.waiter) throw new Error("KeyQueue: a waiter is already parked (single consumer)");
    return new Promise<K | null>((resolve) => { this.waiter = resolve; });
  }

  /**
   * Teardown (vect-hack-a8r): settle whoever is parked, and take no more.
   *
   * A view that removes its keydown listener has cut the only thing that
   * could ever push. Whatever is parked on next(true) is then a promise
   * nobody will settle — and it is not an idle one: the Backplane's dispatch
   * is awaiting it (`await handler.nextKey(...)`), so the await, its message
   * and the view it closes over all stay reachable for the life of the page.
   *
   * It RESOLVES with null rather than rejecting, for three reasons:
   *  - null is already this method's word for "no key": wait=false answers
   *    with it constantly, and every Module's dispatch already turns it into
   *    that engine's own no-key reply (Angband's `key?.code ?? 0` is the same
   *    shape angbandFallback posts for a cancelled poll).
   *  - a rejection would travel out of nextKey into EngineSession.dispatch's
   *    catch — the throwing-dispatch guard (vect-hack-1g5/c1w) — which would
   *    post a fallback reply to a worker being terminated and tell the player
   *    "A display error cancelled the current action". A deliberate teardown
   *    is not a display error, and that guard must keep meaning what it says.
   *  - a rejected promise no caller happens to await is an unhandled
   *    rejection, which is a page-level error report for a normal shutdown.
   *
   * One-way. A queue whose view is disposed is not restartable — the next
   * game gets a new view and a new queue — and a re-armable flag would only
   * offer a way to resurrect a queue whose pusher no longer exists.
   */
  cancel(): void {
    this.cancelled = true;
    this.buffer.length = 0;
    const w = this.waiter;
    this.waiter = null;
    w?.(null);
  }
}
