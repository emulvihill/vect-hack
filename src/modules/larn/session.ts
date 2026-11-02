// Main-thread side of the Larn Module bridge: a thin delegate over the
// Backplane's EngineSession — the same mechanism the other three Modules use,
// which is the point (vect-hack-1g5/c1w are fixed in one place for all).
// Display events are one-way; the single blocking request/reply is the key
// wait, mirroring the engine's one suspend point, the read(0,&b,1) the shim
// wraps (src/modules/larn/native/main-wasm.c).
import { EngineSession, TRACE, type SessionDelegate } from "../../backplane/session";
import type { ExportedSave } from "../../backplane/saveExport";
import {
  KC_ESCAPE,
  type LarnEvent, type LarnKey, type LarnMainToWorker, type LarnWorkerToMain,
} from "./protocol";

export interface LarnHandler {
  onReady?(): void;
  /** Out-of-band player message: engine death, quit, storage warnings. */
  onNotice(text: string): void;
  handle(ev: LarnEvent): void;
  /** Next key for the engine. wait=false must answer immediately
   * (null = no key); wait=true may block until the player presses one. */
  /** Undo whatever the view put on the page (vect-hack-a8r). Called after the
   *  worker is gone, so a key wait parked on the view's queue is settled
   *  rather than left hanging with this session's dispatch awaiting it.
   *  Optional: a headless handler or a bot decorator need not have one. */
  dispose?(): void;
  nextKey(wait: boolean, cmd: boolean): LarnKey | null | Promise<LarnKey | null>;
}

/**
 * The reply that unwedges the Asyncify-suspended engine when the view throws
 * mid-call (the backplane design's fallback table). getKey is the only
 * message that owes one — the worker parks a resolver for each
 * (src/modules/larn/worker.ts) — and its shape follows `wait`:
 *
 * - wait=true is a prompt, so the cancel shape is ESC (Larn reads the raw
 *   byte 27 as cancel everywhere it prompts).
 * - wait=false is a poll, so the cancel shape is "no key" (code 0); ESC
 *   there would be a phantom keypress, not a cancel.
 */
export function larnFallback(msg: LarnWorkerToMain): LarnMainToWorker | null {
  return msg.type === "getKey"
    ? { type: "key", id: msg.id, code: msg.wait ? KC_ESCAPE : 0, mods: 0 }
    : null;
}

/** The Module's half of the session contract, built apart from the class so
 *  it is reachable without spawning a real Worker (its tests live in
 *  scripts/test/larn-session.test.ts). */
export function makeDelegate(
  handler: LarnHandler,
  onReleased: () => void = () => {},
): SessionDelegate<LarnWorkerToMain, LarnMainToWorker> {
  // The one place a player message leaves the Module: quit goes through it
  // too, so a future decoration (dedupe, log) has a single home.
  const notice = (text: string) => handler.onNotice(text);
  return {
    onNotice: notice,
    // Like Angband's: no recovery wording — there is no rebuilt-save case to
    // explain. Phase 2's checkpoint work may revisit.
    fatalNotice: (message) =>
      `The Larn engine died — ${message}. Reload the page to restart.`,
    dispatch: async (msg) => {
      switch (msg.type) {
        case "ready":
          // No storage line here any more. It said "Saving is off — IndexedDB
          // is unavailable: TypeError: ..." into the message strip, where the
          // engine's own opening messages pushed it away within a turn, and
          // the half a player could read was the half that was exception text.
          // The Backplane raises a banner instead (vect-hack-dem).
          handler.onReady?.();
          return null;
        case "event":
          if (TRACE) console.debug("[larn]", msg.ev.name, msg.ev);
          handler.handle(msg.ev);
          return null;
        case "getKey": {
          const key = await handler.nextKey(msg.wait, msg.cmd);
          return { type: "key", id: msg.id, code: key?.code ?? 0, mods: key?.mods ?? 0 };
        }
        case "quit":
          // The engine's own end — death, win, save-and-quit — via
          // __wrap_exit. saved is hardwired false in phase 1 (no checkpoint
          // machinery), so the promise branch is phase 2's to earn.
          notice(msg.persistent && msg.saved
            ? "Larn exited — your game is saved. Reload to continue."
            : "Larn exited — reload to restart.");
          return null;
        case "released":
          onReleased();
          return null;
        default:
          return null; // notice/fatal are routed by EngineSession, never here
      }
    },
    fallback: larnFallback,
  };
}

export class LarnSession {
  private session: EngineSession<LarnWorkerToMain, LarnMainToWorker>;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private handler: LarnHandler) {
    this.session = new EngineSession(
      // Written out syntactically: Vite's build-time worker bundling only
      // recognizes this exact form at the call site.
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
      makeDelegate(handler, () => this.finishTerminate()),
    );
  }

  /** EngineSession owns the export round trip; this is its Module face. */
  exportSave(): Promise<ExportedSave> {
    return this.session.exportSave();
  }

  /** The engine's own name for a map cell; EngineSession owns the round trip. */
  describe(x: number, y: number): Promise<string | null> {
    return this.session.describe(x, y);
  }

  terminate() {
    if (this.releaseTimer !== null) return;
    this.session.send({ type: "release" });
    // A broken worker cannot acknowledge; termination itself releases its
    // Web Lock, so bound the graceful handoff instead of leaking the worker.
    // One landed checkpoint sync plus the final volume sync can each consume
    // persistFs's 10-second bound. Keep the broken-worker escape hatch beyond
    // both; an early kill would release the Web Lock with the save half-written.
    this.releaseTimer = setTimeout(() => this.finishTerminate(), 21_000);
  }

  private finishTerminate() {
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.session.terminate();
    // After the worker, not before: while the graceful release is still in
    // flight the engine may ask one more question, and a view disposed early
    // would answer it "no key" instead of letting the player finish. Once the
    // worker is gone, a still-parked key wait can only ever hang.
    this.handler.dispose?.();
  }
}
