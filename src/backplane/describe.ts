// Naming one map cell: the page asks, the Module's worker answers from a
// read-only native query that uses the engine's own naming code (spec
// docs/specs/2026-08-18-look-hud-design.md).
//
// Modelled on saveExport.ts — a page->worker round trip with a reply table —
// with one difference that comes from the caller: a hover fires constantly, so
// a newer request supersedes every older one and the caller only ever sees the
// answer to the latest position. Nothing here is game-specific: every Module
// includes these two messages in its protocol union, EngineSession routes the
// reply, and every worker answers through the one helper below.

/** A describer is a table lookup and a string format; anything slower than
 *  this is an engine that stopped answering, and a hover must not hang on it. */
const DESCRIBE_TIMEOUT_MS = 5_000;

export type DescribeRequest = { type: "describe"; id: number; x: number; y: number };
export type DescribeReply = { type: "describeReply"; id: number; text: string | null };

/**
 * Main-thread half: one in-flight request at a time, by design. Nothing here
 * rejects — a hover is not an operation the player asked for, so a dead
 * worker, a timeout and "the engine has nothing to say" all read the same to
 * the HUD: no label.
 */
export class Describes {
  private nextId = 1;
  private pending: {
    id: number;
    resolve(text: string | null): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  request(send: (msg: DescribeRequest) => void, x: number, y: number): Promise<string | null> {
    // Whatever was in flight is about a cell the pointer has already left.
    this.settleCurrent(null);
    const id = this.nextId++;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => this.settleCurrent(null), DESCRIBE_TIMEOUT_MS);
      this.pending = { id, resolve, timer };
      try {
        send({ type: "describe", id, x, y });
      } catch (err) {
        // A dead worker throws here rather than staying silent; settle now.
        console.warn("describe could not be sent:", err);
        this.settleCurrent(null);
      }
    });
  }

  /** Settle from a worker reply. An id we are not waiting for is one we
   *  already superseded or timed out — dropping it is right, and it must not
   *  throw. */
  settle(msg: DescribeReply): void {
    if (this.pending?.id !== msg.id) return;
    this.settleCurrent(msg.text);
  }

  private settleCurrent(text: string | null): void {
    const waiter = this.pending;
    if (!waiter) return;
    this.pending = null;
    clearTimeout(waiter.timer);
    waiter.resolve(text);
  }
}

/**
 * Worker half: answer one request from the Module's describer. A failure
 * becomes a reply rather than an exception, because the caller is a message
 * handler — throwing there loses the request and leaves the page waiting out
 * its whole timeout for a failure that is already known. That includes a
 * describer that does not exist yet: a hover during engine boot.
 *
 * Synchronous by design: it runs while the engine is parked on its Asyncify
 * suspend point, so a describer must return without unwinding — no windowport
 * call on its normal path, and nothing that blocks for input.
 *
 * "Read-only" here means the answer is read from state the player can already
 * see; it does not promise a describer touches no engine state at all. The
 * Angband, Larn and Moria describers are pure queries. NetHack's is not: its
 * do_screen_description() has a didlook: tail that can advance the game RNG
 * and mark a named trap seen, and one defensive branch that can print — so
 * that Module makes the call under its non-unwinding bridge swap. The cost is
 * accepted because NetHack's own autodescribe cursor pays exactly the same one
 * per cell it crosses. A new Module's describer should be a pure query; if it
 * cannot be, say so where it is written, as describeScreenCell's own
 * header in src/modules/nethack/wasmAbi.ts does.
 */
export function answerDescribeRequest(
  msg: DescribeRequest,
  describer: ((x: number, y: number) => string | null) | undefined,
  post: (reply: DescribeReply) => void,
): void {
  let text: string | null = null;
  try {
    text = describer ? describer(msg.x, msg.y) : null;
  } catch (err) {
    console.warn("describe failed:", err);
    text = null;
  }
  post({ type: "describeReply", id: msg.id, text: text || null });
}
