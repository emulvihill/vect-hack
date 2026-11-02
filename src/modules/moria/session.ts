import { EngineSession, TRACE, type SessionDelegate } from "../../backplane/session";
import type { ExportedSave } from "../../backplane/saveExport";
import {
  KC_ESCAPE,
  type MoriaEvent,
  type MoriaInputContext,
  type MoriaKeyMode,
  type MoriaMainToWorker,
  type MoriaWorkerToMain,
} from "./protocol";

// A graceful release can first drain a 10s-bounded IDBFS auto-persist queue,
// then enter a separate 10s-bounded strict sync. Leave one second for the
// release acknowledgement before treating the Worker as broken.
const RELEASE_TIMEOUT_MS = 21_000;

export interface MoriaHandler {
  onReady?(): void;
  onNotice(text: string): void;
  handle(ev: MoriaEvent): void;
  nextKey(
    wait: boolean,
    context: MoriaInputContext,
    mode: MoriaKeyMode,
  ): number | null | Promise<number | null>;
  /** Undo whatever the view put on the page (vect-hack-a8r). Called after the
   *  worker is gone, so a key wait parked on the view's queue is settled
   *  rather than left hanging with this session's dispatch awaiting it.
   *  Optional: a headless handler or a bot decorator need not have one. */
  dispose?(): void;
}

export function moriaFallback(msg: MoriaWorkerToMain): MoriaMainToWorker | null {
  if (msg.type !== "getKey") return null;
  return {
    type: "key",
    id: msg.id,
    result: msg.wait ? { status: "key", key: KC_ESCAPE } : { status: "none" },
  };
}

export function makeDelegate(
  handler: MoriaHandler,
  onReleased: () => void = () => {},
): SessionDelegate<MoriaWorkerToMain, MoriaMainToWorker> {
  return {
    onNotice: (text) => handler.onNotice(text),
    fatalNotice: (message) => `The Moria engine died — ${message}. Reload the page to restart.`,
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
          if (TRACE) console.debug("[moria]", msg.ev.name, msg.ev);
          handler.handle(msg.ev);
          return null;
        case "getKey": {
          const key = await handler.nextKey(msg.wait, msg.context, msg.mode);
          if (key !== null && (!Number.isInteger(key) || key < 0 || key > 255))
            throw new Error(`Moria view returned invalid byte ${key}`);
          return {
            type: "key",
            id: msg.id,
            result: key === null ? { status: "none" } : { status: "key", key },
          };
        }
        case "quit":
          handler.onNotice(msg.persistent && msg.saved
            ? "Moria exited — your game is saved. Reload to continue."
            : msg.persistent && msg.reason
              ? `Moria exited — reload to restart. Saving failed — ${msg.reason}.`
              : "Moria exited — reload to restart.");
          return null;
        case "released":
          onReleased();
          return null;
        default:
          return null;
      }
    },
    fallback: moriaFallback,
  };
}

export class MoriaSession {
  private session: EngineSession<MoriaWorkerToMain, MoriaMainToWorker>;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private handler: MoriaHandler) {
    this.session = new EngineSession(
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
      makeDelegate(handler, () => this.finishTerminate()),
    );
  }

  exportSave(): Promise<ExportedSave> {
    return this.session.exportSave();
  }

  /** The engine's own name for a map cell; EngineSession owns the round trip. */
  describe(x: number, y: number): Promise<string | null> {
    return this.session.describe(x, y);
  }

  terminate(): void {
    if (this.releaseTimer !== null) return;
    this.session.send({ type: "release" });
    this.releaseTimer = setTimeout(() => this.finishTerminate(), RELEASE_TIMEOUT_MS);
  }

  private finishTerminate(): void {
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
