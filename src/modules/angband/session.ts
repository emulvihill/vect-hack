// Main-thread side of the Angband Module bridge: a thin delegate over the
// Backplane's EngineSession — the same mechanism the other three Modules use,
// which is the point (vect-hack-1g5/c1w are fixed in one place for all).
// Display events are one-way; the single blocking request/reply is the key
// wait, mirroring the engine's one suspend point,
// Term_xtra(TERM_XTRA_EVENT, wait=true).
import { EngineSession, TRACE, type SessionDelegate } from "../../backplane/session";
import type { ExportedSave } from "../../backplane/saveExport";
import {
  KC_ESCAPE,
  type AngbandEvent, type AngbandKey, type AngbandMainToWorker, type AngbandWorkerToMain,
} from "./protocol";

export interface AngbandHandler {
  onReady?(): void;
  /** Out-of-band player message: engine death, quit, future storage warnings. */
  onNotice(text: string): void;
  handle(ev: AngbandEvent): void;
  /** Next key for the engine. wait=false must answer immediately
   * (null = no key); wait=true may block until the player presses one. */
  nextKey(wait: boolean, cmd: boolean): AngbandKey | null | Promise<AngbandKey | null>;
  /** Undo whatever the view put on the page (vect-hack-a8r). Called after the
   *  worker is gone, so a key wait parked on the view's queue is settled
   *  rather than left hanging with this session's dispatch awaiting it.
   *  Optional: a headless handler or a bot decorator need not have one. */
  dispose?(): void;
}

/**
 * The reply that unwedges the Asyncify-suspended engine when the view throws
 * mid-call (the backplane design's Angband fallback table). getKey is the
 * only message that owes one — the worker parks a resolver for each
 * (src/modules/angband/worker.ts) — and its shape follows `wait`:
 *
 * - wait=true is a prompt, so the cancel shape is ESC.
 * - wait=false is a poll, so the cancel shape is "no key" (code 0).
 *   TERM_XTRA_FLUSH drains the queue by polling until it gets exactly that
 *   (native/main-wasm.c:104); ESC there would not cancel anything, it would
 *   press a phantom Escape into the drain and send it round again.
 */
export function angbandFallback(msg: AngbandWorkerToMain): AngbandMainToWorker | null {
  return msg.type === "getKey"
    ? { type: "key", id: msg.id, code: msg.wait ? KC_ESCAPE : 0, mods: 0 }
    : null;
}

/** The Module's half of the session contract, built apart from the class so
 *  it is reachable without spawning a real Worker (its tests live beside
 *  EngineSession's, in scripts/test/backplane-session.test.ts). */
export function makeDelegate(
  handler: AngbandHandler,
  onReleased: () => void = () => {},
): SessionDelegate<AngbandWorkerToMain, AngbandMainToWorker> {
  // The one place a player message leaves the Module: quit goes through it
  // too, so a future decoration (dedupe, log) has a single home.
  const notice = (text: string) => handler.onNotice(text);
  return {
    onNotice: notice,
    // Unlike NetHack's, this needs no recovery wording: Angband checkpoints
    // through its own save_game_checked(), so there is no rebuilt-save case
    // to explain — the quit message reports the outcome through `saved`.
    fatalNotice: (message) =>
      `The Angband engine died — ${message}. Reload the page to restart.`,
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
          if (TRACE) console.debug("[angband]", msg.ev.name, msg.ev);
          handler.handle(msg.ev);
          return null;
        case "getKey": {
          const key = await handler.nextKey(msg.wait, msg.cmd);
          return { type: "key", id: msg.id, code: key?.code ?? 0, mods: key?.mods ?? 0 };
        }
        case "quit":
          // A normal engine exit — death, retirement, play_game() returning
          // — with quit wording, not fatalNotice's. A quit that carries text
          // is a fault and quitMessage routes it to the lifecycle `fatal`
          // above, bar the wizard's quit-without-saving (protocol.ts).
          notice(msg.persistent && msg.saved
            ? "Angband exited — your game is saved. Reload to continue."
            : "Angband exited — reload to restart.");
          return null;
        case "released":
          onReleased();
          return null;
        default:
          return null; // notice/fatal are routed by EngineSession, never here
      }
    },
    fallback: angbandFallback,
  };
}

export class AngbandSession {
  private session: EngineSession<AngbandWorkerToMain, AngbandMainToWorker>;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private handler: AngbandHandler) {
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

  /** ?borg pacing in ms per borg move, 0 = unthrottled. Fire-and-forget: the
   *  worker holds it until the volume is up (worker.ts). */
  setBorgDelay(ms: number): void {
    this.session.send({ type: "borgDelay", ms });
  }

  terminate() {
    if (this.releaseTimer !== null) return;
    this.session.send({ type: "release" });
    // A broken worker cannot acknowledge; termination itself releases its
    // Web Lock, so bound the graceful handoff instead of leaking the worker.
    this.releaseTimer = setTimeout(() => this.finishTerminate(), 250);
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
