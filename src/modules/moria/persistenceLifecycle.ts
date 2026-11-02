// Moria's asynchronous durability state, isolated from worker.ts so native
// exit, release, and sync-failure ordering are testable without a Worker.
import { createMoriaCheckpoint, type MoriaCheckpoint } from "./checkpoint.ts";
import type { MoriaPersistHandle } from "./persist.ts";

export type MoriaExitOutcome = 0 | 1 | 2;

export interface MoriaQuitState {
  saved: boolean;
  persistent: boolean;
  reason: string | null;
}

export class MoriaPersistenceLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private quitPromise: Promise<MoriaQuitState> | null = null;
  private releasePromise: Promise<void> | null = null;
  private readonly current: () => MoriaPersistHandle | undefined;
  private readonly checkpoint: MoriaCheckpoint;
  closing = false;

  constructor(
    current: () => MoriaPersistHandle | undefined,
    checkpoint: MoriaCheckpoint = createMoriaCheckpoint(),
  ) {
    this.current = current;
    this.checkpoint = checkpoint;
  }

  deliverKey(deliver: () => void): boolean {
    if (this.closing) return false;
    deliver();
    return true;
  }

  /** Called by the awaited native pre-exit hook after terminalRestore's final
   * frame. Expected storage errors become a truthful normal quit; unexpected
   * bridge errors remain the bridge's responsibility and can still be fatal. */
  checkpointCommand = (): boolean => {
    const persist = this.current();
    if (this.closing || !persist?.persistent) return false;
    this.checkpoint.command();
    return this.checkpoint.due();
  };

  checkpointLanded = async (): Promise<boolean> => {
    const persist = this.current();
    if (this.closing || !persist?.persistent) return false;
    try {
      // Native awaits this callback before another candidate can reuse the
      // fixed pending path, so move it to a unique generation immediately.
      persist.publishCheckpoint();
    } catch (error) {
      console.warn("[vect-hack] could not publish a Moria checkpoint:", error);
      return false;
    }
    try {
      await this.enqueue(() => persist.flush());
      this.checkpoint.landed();
      return true;
    } catch (error) {
      console.warn("[vect-hack] could not persist a Moria checkpoint:", error);
      return false;
    }
  };

  checkpointRecoveryPath = (): string => {
    const persist = this.current();
    return !this.closing && persist?.persistent ? persist.checkpointRecoveryPath : "";
  };

  beforeExit(outcome: MoriaExitOutcome): Promise<MoriaQuitState> {
    this.closing = true;
    if (this.quitPromise === null) {
      const persist = this.current();
      const persistent = persist?.persistent ?? false;
      this.quitPromise = (async () => {
        // The developer sentence, not the code: `quit`'s reason is a
        // console/diagnostic field, and the player-facing half of the
        // session-only state travels as its own message (vect-hack-dem).
        if (!persist || !persistent) return {
          saved: false,
          persistent,
          reason: persist?.reason?.detail ?? "persistent storage did not initialize",
        };
        try {
          await this.enqueue(async () => {
            if (outcome === 1) persist.clearRecovery();
            else if (outcome === 2) persist.recordTerminal();
            await persist.flush();
          });
          return { saved: outcome === 1, persistent: true, reason: persist.reason?.detail ?? null };
        } catch (error) {
          return {
            saved: false,
            persistent: true,
            reason: `could not persist the Moria volume: ${String(error)}`,
          };
        }
      })();
    }
    return this.quitPromise;
  }

  /** A channel close cannot strand a lock behind a failed sync. It shares the
   * native-exit flush when one exists, otherwise starts the same one final
   * transaction, and releases only after that bounded operation settles. */
  async release(): Promise<void> {
    this.closing = true;
    if (this.releasePromise !== null) return this.releasePromise;
    const persist = this.current();
    this.releasePromise = (async () => {
      if (this.quitPromise !== null) await this.quitPromise;
      else if (persist?.persistent) {
        try { await this.enqueue(() => persist.flush()); }
        catch (error) {
          console.warn("[vect-hack] could not persist the Moria volume:", error);
        }
      }
      try { persist?.release(); }
      catch (error) {
        console.warn("[vect-hack] could not release the Moria save volume:", error);
      }
    })();
    return this.releasePromise;
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const run = this.tail.then(operation);
    this.tail = run.catch(() => {});
    return run;
  }
}
