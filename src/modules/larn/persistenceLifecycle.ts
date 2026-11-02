// The Larn worker's asynchronous durability state, separated from worker.ts
// so the exact save/quit/release ordering is directly testable in Node.
import type { PersistHandle } from "../../backplane/persistFs";
import { savedOnQuit, type LarnWorkerToMain } from "./protocol";

type QuitMessage = Extract<LarnWorkerToMain, { type: "quit" }>;

export class LarnPersistenceLifecycle {
  private flushing: Promise<void> = Promise.resolve();
  private saved = false;
  private closing = false;

  constructor(private readonly current: () => PersistHandle | undefined) {}

  /** Deliver a main-thread key only while the worker still owns its session.
   * release() closes this gate synchronously, before its first await. */
  deliverKey(deliver: () => void): boolean {
    if (this.closing) return false;
    deliver();
    return true;
  }

  /** Called synchronously by the native save wrapper. Queue each flush so a
   * later checkpoint cannot hide an earlier in-flight IDBFS transaction. */
  saveLanded(): void {
    // A native save cannot legitimately begin after the input gate closes:
    // WASM is suspended at its key wait while the release message runs. Keep
    // this second guard so even an accidental direct callback cannot extend
    // the flush queue after release captured it.
    if (this.closing) return;
    const persist = this.current();
    if (!persist?.persistent) {
      this.saved = false;
      return;
    }
    this.flushing = this.flushing
      .then(() => persist.flush())
      .then(
        () => { this.saved = true; },
        () => { this.saved = false; },
      );
  }

  /** Drain the landed save, then flush all other volume changes before the
   * native exit is reported to the main thread. */
  async quit(nativeSaveSucceeded: number): Promise<QuitMessage> {
    this.closing = true;
    await this.flushing;
    const persist = this.current();
    try {
      await persist?.flush();
    } catch {
      this.saved = false;
    }
    return {
      type: "quit",
      saved: savedOnQuit(this.saved, nativeSaveSucceeded),
      persistent: persist?.persistent ?? false,
      // The developer sentence, not the code: `quit`'s reason is a
      // console/diagnostic field, and the player-facing half of the
      // session-only state travels as its own message (vect-hack-dem).
      reason: persist?.reason?.detail ?? null,
    };
  }

  /** A handoff must not release the Web Lock while a checkpoint is still
   * entering IDBFS. Always release eventually: a failed final sync cannot be
   * repaired by retaining a dead tab's lock. */
  async release(): Promise<void> {
    // This assignment runs before the first await in an async function. A key
    // reply queued behind the release message therefore cannot resume WASM
    // and create a new save after the flush tail below has been selected.
    this.closing = true;
    await this.flushing;
    const persist = this.current();
    try {
      await persist?.flush();
    } catch {
      // mountVolume reports persistence failures; release still must finish.
    } finally {
      persist?.release();
    }
  }
}
