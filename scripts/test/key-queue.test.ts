// The Backplane's one input mechanism: a buffer-or-waiter queue. Engines
// pull keys (next); views push them. wait=false answers immediately —
// engines poll that way from TERM_XTRA_FLUSH-style drains and must never
// block on it.
import { describe, expect, it } from "vitest";
import { KeyQueue } from "../../src/backplane/keyQueue";

describe("KeyQueue", () => {
  it("answers a buffered key immediately, FIFO", () => {
    const q = new KeyQueue<number>();
    q.push(1);
    q.push(2);
    expect(q.next(false)).toBe(1);
    expect(q.next(true)).toBe(2); // buffered: no promise even when waiting is allowed
  });

  it("answers null immediately when empty and wait=false", () => {
    const q = new KeyQueue<number>();
    expect(q.next(false)).toBeNull();
  });

  it("treats a falsy key as a real key, not an empty buffer", () => {
    const q = new KeyQueue<number>();
    q.push(0);                       // NUL: Ctrl+Space, ctrl(" ") & 0x1f
    expect(q.next(true)).toBe(0);    // not a Promise — truthiness would park a waiter here
  });

  it("parks a waiter until the next push", async () => {
    const q = new KeyQueue<string>();
    const p = q.next(true);
    expect(p).toBeInstanceOf(Promise);
    q.push("a");
    await expect(p).resolves.toBe("a");
  });

  it("a push while a waiter is parked feeds the waiter, not the buffer", async () => {
    const q = new KeyQueue<number>();
    const p = q.next(true);
    q.push(7);
    q.push(8);
    await expect(p).resolves.toBe(7);
    expect(q.next(false)).toBe(8);
  });

  it("refuses a second waiter instead of orphaning the first", async () => {
    const q = new KeyQueue<number>();
    const p = q.next(true);
    expect(p).toBeInstanceOf(Promise);
    expect(() => q.next(true)).toThrow(/single consumer/i);
    // The first waiter is intact: the invariant is stated, not enforced by
    // dropping the key the parked caller is owed.
    q.push(3);
    await expect(p).resolves.toBe(3);
  });

  it("still polls while a waiter is parked — only a second wait is the violation", async () => {
    const q = new KeyQueue<number>();
    const p = q.next(true);
    expect(q.next(false)).toBeNull(); // the poll answers "no key", and takes none
    q.push(5);
    await expect(p).resolves.toBe(5); // the parked waiter still gets the next key
  });
});

// Teardown (vect-hack-a8r). A view that unbinds its keydown listener has cut
// the only thing that could ever push, so whatever is parked on next(true) is
// a promise nobody will settle — and the Backplane's dispatch is awaiting it,
// which keeps the message, the await and the whole view reachable.
describe("KeyQueue.cancel", () => {
  /** Did the promise settle, or did the clock beat it? Awaiting a
   *  never-settling promise HANGS a suite instead of failing it, so every
   *  assertion below races a timer and states which one won. */
  async function raceClock<T>(p: Promise<T>, ms = 50) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<{ won: "timer" }>((r) => { timer = setTimeout(() => r({ won: "timer" }), ms); });
    const out = await Promise.race([p.then((value) => ({ won: "promise" as const, value })), clock]);
    clearTimeout(timer);
    return out;
  }

  it("settles a parked waiter instead of leaving it hanging", async () => {
    const q = new KeyQueue<number>();
    const p = q.next(true) as Promise<number | null>;
    expect(p).toBeInstanceOf(Promise);
    q.cancel();
    expect(await raceClock(p)).toEqual({ won: "promise", value: null });
  });

  it("resolves with null rather than rejecting", async () => {
    // A rejection would travel out of the view's nextKey into
    // EngineSession's dispatch catch — the throwing-dispatch guard
    // (vect-hack-1g5/c1w) — which posts a cancel-shaped reply AND tells the
    // player a display error cancelled their action. A deliberate teardown is
    // neither. An unawaited rejection would also be an unhandled rejection.
    const q = new KeyQueue<number>();
    const p = q.next(true) as Promise<number | null>;
    let rejected: unknown = "not rejected";
    // Raced, not awaited directly: a promise that never settles would spend
    // this test's whole timeout instead of failing on the next line.
    const settled = raceClock(p.catch((e) => { rejected = e; return "threw" as const; }));
    q.cancel();
    expect(await settled).toEqual({ won: "promise", value: null });
    expect(rejected).toBe("not rejected");
  });

  it("answers a later blocking read immediately, never parking a waiter nothing can feed", async () => {
    const q = new KeyQueue<number>();
    q.cancel();
    expect(q.next(true)).toBeNull();  // not a Promise: nothing survives to push
    expect(q.next(false)).toBeNull();
  });

  it("drops a buffered key and refuses a later push", () => {
    const q = new KeyQueue<number>();
    q.push(1);
    q.cancel();
    q.push(2);
    expect(q.next(false)).toBeNull();
  });

  it("is harmless on an idle queue, and idempotent", () => {
    const q = new KeyQueue<number>();
    expect(() => { q.cancel(); q.cancel(); }).not.toThrow();
    expect(q.next(true)).toBeNull();
  });
});
