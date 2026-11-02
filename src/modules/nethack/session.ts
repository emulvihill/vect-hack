// Main-thread side of the NetHack bridge: a thin delegate over the
// Backplane's EngineSession. The windowport vocabulary (ShimEvent,
// WorkerToMain/MainToWorker) stays Module-owned; the shared mechanism owns
// worker lifecycle, fatal->notice routing (vect-hack-1g5) and the dispatch
// guard (vect-hack-c1w). NethackHandler remains the Module's view
// interface — there is no shared GameView in phase 2 (backplane design,
// "What the NetHack Module keeps private").
import { EngineSession, TRACE, type SessionDelegate } from "../../backplane/session";
import type { ExportedSave } from "../../backplane/saveExport";
import type { MainToWorker, ShimEvent, WorkerToMain } from "./protocol";

export type ShimReply = number | string | boolean | { picks: { identifier: number; count: number; itemflags: number }[] } | null | undefined | void;

export interface NethackHandler {
  onReady?(constants: Record<string, Record<string, number | string>>): void;
  /** Engine-independent message for the player, e.g. storage warnings. */
  onNotice?(text: string): void;
  /** Undo whatever the view put on the page (vect-hack-a8r). Called after the
   *  worker is gone, so a key wait parked on the view's queue is settled
   *  rather than left hanging with this session's dispatch awaiting it.
   *  Optional: a headless handler or a bot decorator need not have one. */
  dispose?(): void;
  handle(ev: ShimEvent): ShimReply | Promise<ShimReply>;
}

const ESC = 27;

/**
 * The cancel-shaped reply that unwedges the Asyncify-suspended engine when
 * the view throws mid-call (the backplane design's NetHack fallback table):
 * ESC for the key waits, the caller's default for yn_function, null
 * (= cancel: "\x1b" for getlin worker-side, -1 picks for select_menu) for
 * the rest — display events owe a null reply and nothing more.
 *
 * Three events cannot take that null: the view's reply goes straight into a
 * scalar C return slot, and setPointerValue()
 * (external/NetHack/sys/libnh/libnhmain.c:895) throws a TypeError on a
 * non-number there — which would kill the engine instead of cancelling, the
 * one thing this fallback exists to prevent. They answer with a number.
 */
export function fallbackValue(ev: ShimEvent): number | null {
  switch (ev.name) {
    case "nhgetch": case "nh_poskey": return ESC;
    case "yn_function": return ev.def;
    case "get_ext_cmd": return -1;      // the documented cancel (protocol.ts)
    case "message_menu": return ESC;    // the reply is the key pressed
    // Least-bad, not a cancel: create_nhwindow is not a prompt, and the
    // engine needs a winid back. WIN_ERR (-1) panics it and a fatal defeats
    // the fallback, so 0 keeps it limping — it can collide with a real
    // window id, which is still strictly better than a wedged engine.
    case "create_nhwindow": return 0;
    default: return null;
  }
}

/** The Module's half of the session contract, built apart from the class so
 *  it is reachable without spawning a real Worker (its tests live beside
 *  EngineSession's, in scripts/test/backplane-session.test.ts). */
export function makeDelegate(
  handler: NethackHandler,
): SessionDelegate<WorkerToMain, MainToWorker> {
  return {
    onNotice: (text) => handler.onNotice?.(text),
    // Checkpoint wording is NetHack's own: autosave means a reload offers
    // the last checkpoint (src/modules/nethack/checkpoint.ts).
    fatalNotice: (message) =>
      `The NetHack engine died — ${message}. Reload the page; your last autosave will be offered.`,
    dispatch: async (msg) => {
      switch (msg.type) {
        case "ready":
          handler.onReady?.(msg.constants);
          return null;
        case "call": {
          if (TRACE) console.debug("[shim]", msg.ev.name, msg.ev);
          const value = await handler.handle(msg.ev);
          // A view case that answers with a bare `return;` still owes the
          // engine a value: undefined does not survive as a reply, null is
          // the protocol's "nothing".
          return { type: "reply", id: msg.id, value: value === undefined ? null : (value as never) };
        }
        default:
          return null; // notice/fatal are routed by EngineSession, never here
      }
    },
    // Every shim call owes a reply, display events included: the worker
    // holds a resolver for each one (src/modules/nethack/worker.ts's
    // ask()). Only the value is cancel-shaped — a null *message* would
    // strand the engine.
    fallback: (msg) =>
      msg.type === "call"
        ? { type: "reply", id: msg.id, value: fallbackValue(msg.ev) }
        : null,
  };
}

export class NetHackSession {
  private session: EngineSession<WorkerToMain, MainToWorker>;

  constructor(private handler: NethackHandler) {
    this.session = new EngineSession(
      // Written out syntactically: Vite's build-time worker bundling only
      // recognizes this exact form at the call site.
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
      makeDelegate(handler),
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
    this.session.terminate();
    // After the worker, not before: once it is gone, a key wait parked on the
    // HUD's queue can only ever hang — the dispatch awaiting it holds the
    // whole view reachable (vect-hack-a8r).
    this.handler.dispose?.();
  }
}
