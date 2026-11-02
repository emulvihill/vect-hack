// The Backplane's session mechanism: one worker-backed engine, lifecycle
// routing, and the dispatch guard. Every Module's session is a thin delegate
// over this class; the message vocabularies stay Module-owned (design:
// docs/specs/2026-08-02-backplane-design.md).
//
// Fixed here once, for every Module:
// - vect-hack-1g5: an engine death becomes an on-screen notice, not a
//   console-only line.
// - vect-hack-c1w: a throwing dispatch can no longer strand the
//   Asyncify-suspended engine — the delegate's cancel-shaped fallback reply
//   is posted instead, and only then is the player told, best-effort.
// - vect-hack-4p9: a death the worker never got to post — a script that never
//   loaded, an OOM kill — and an undeliverable message reach the same notice.
//
// Assumed invariant, inherited from both hand-written sessions: at most one
// reply-owing message is in flight. Each engine has a single Asyncify suspend
// point, so it cannot ask a second question while one is outstanding — which
// is why dispatch runs un-awaited (`void this.dispatch(...)`). Overlapping
// reply-owing messages would post their replies in completion order, not
// arrival order; a Module whose worker can ever do that must serialize its
// own dispatch.
//
// The Worker is constructed by the Module, not here: Vite's build-time
// worker bundling only recognizes the literal
// `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`
// form at the call site, so the Backplane owns the session, not the spawn.

import { SaveExports, type ExportedSave, type SaveExportReply } from "./saveExport.ts";
import { Describes, type DescribeReply } from "./describe.ts";
import type { SessionOnlyCode } from "./persistFs.ts";

/** Lifecycle messages every Module's worker->main union must include. */
export type LifecycleToMain =
  | { type: "notice"; text: string }   // out-of-band player message
  | { type: "fatal"; message: string }
  /** This tab's volume never mounted, so nothing it plays will be kept
   *  (vect-hack-dem). The code and not the sentence: persistFs.ts runs in the
   *  worker and has no business owning player-facing English, and the page
   *  has to weigh this against the other save warning before drawing either.
   *  Every Module mounts a volume, so every Module's union carries it. */
  | { type: "sessionOnly"; code: SessionOnlyCode };

export interface SessionDelegate<In, Out> {
  onNotice(text: string): void;
  /** Player-facing wording for an engine death (checkpoint wording is
   *  NetHack's; Angband's says reload-to-restart). Routed to onNotice. */
  fatalNotice(message: string): string;
  /** Handle one game message; a returned message is posted to the worker. */
  dispatch(msg: In): Promise<Out | null>;
  /** The reply that unwedges the Asyncify-suspended engine when dispatch
   *  throws — cancel-shaped, per message type. null = no reply owed.
   *
   *  Must not throw. It runs inside the catch that exists to unwedge the
   *  engine, with nothing left to catch it: a throw here strands the engine
   *  for the rest of the session. Every Module's fallback is therefore a pure
   *  table lookup returning plain data, and must stay that way. */
  fallback(msg: In): Out | null;
}

/** Opt-in call tracing (?trace in the URL). Owned here; Modules read it for
 *  their detailed per-call lines, since the message names are theirs.
 *  Guarded: node-side tests import this file, where location is absent. */
export const TRACE = typeof location !== "undefined"
  && new URLSearchParams(location.search).has("trace");

/**
 * Who draws the session-only warning (vect-hack-dem).
 *
 * A page-wide slot rather than a constructor argument or a delegate method,
 * for the same reason `notice` and `fatal` are routed here and never reach a
 * Module: this is one policy for four Modules, and threading it through four
 * session classes would let three of them drift from the fourth. The Backplane
 * cannot import src/ui, so it holds the callback instead of the sentence.
 *
 * One slot, because a page runs one engine — main.ts refuses a second boot
 * outright (`__vhBooted`) — and there is one banner element for it to draw in.
 * A later registration replaces the earlier one rather than stacking, so a
 * reload-shaped re-registration cannot leave two writers on that element.
 */
let sessionOnlyListener: ((code: SessionOnlyCode) => void) | null = null;

export function onSessionOnly(listener: (code: SessionOnlyCode) => void): void {
  sessionOnlyListener = listener;
}

export class EngineSession<In extends { type: string }, Out> {
  constructor(
    private worker: Worker,
    private delegate: SessionDelegate<In | LifecycleToMain, Out>,
  ) {
    worker.onmessage = (e: MessageEvent<In | LifecycleToMain>) =>
      void this.dispatch(e.data);
    // Neither of these can be a posted message: the first is the death that
    // outran the worker's own error listener, the second is a value that
    // never became a message at all. Reported, never terminated — same as the
    // posted fatal, whose wording asks the player to reload.
    worker.onerror = (e: ErrorEvent) => this.reportDeath(
      // A script that failed to load carries no message, only the event.
      e.message ? `${e.message} (${e.filename}:${e.lineno})` : "the engine worker failed to start",
    );
    worker.onmessageerror = () =>
      this.reportDeath("a message from the engine could not be deserialized");
  }

  private exports = new SaveExports();
  private describes = new Describes();
  /** Set by the first death of any kind. One death arrives twice — each
   *  worker's own `error` listener posts a fatal and the uncancelled error
   *  still reaches onerror above — so the console keeps every report and the
   *  player is told once. */
  private reported = false;
  /** Has the engine sent one message of its own? False means it died on the
   *  way in, which is the death the save volume can be the cause of. */
  private started = false;

  private reportDeath(message: string): void {
    console.error("engine died:", message);
    if (this.reported) return;
    this.reported = true;
    // Unguarded, unlike the catch in dispatch(): a death owes the engine no
    // reply, so a throwing onNotice costs only the notice here.
    this.delegate.onNotice(this.delegate.fatalNotice(message) + this.resetAdvice());
  }

  /**
   * The extra sentence a boot fatal gets (vect-hack-60i).
   *
   * Every Module's fatalNotice already ends by asking for a reload, and a
   * reload is the right first move: most deaths are not the volume's fault. It
   * is the second reload that means the save is, and that is the player with
   * no way forward — the file that caused it is already cleared, so nothing on
   * the page will offer them anything.
   *
   * Only before the engine has said anything. A death mid-game is a bug in a
   * running game, and pointing that player at the button that deletes their
   * character would be advice that costs them the character.
   *
   * Shared here rather than added to four fatalNotice strings for the reason
   * notice and fatal are routed here at all: this is one policy for four
   * Modules, and four copies of it would drift.
   */
  private resetAdvice(): string {
    return this.started
      ? ""
      : " If it dies again on the way in, the stored save may be the cause:"
        + " the Saves button can delete it.";
  }

  private async dispatch(msg: In | LifecycleToMain): Promise<void> {
    // Save-export replies are Backplane traffic, routed here for the same
    // reason notice/fatal are: every Module carries the identical message, so
    // the delegate never sees it and the next Module gets exports for free.
    if (msg.type === "saveBlob") {
      this.exports.settle(msg as unknown as SaveExportReply);
      return;
    }
    if (msg.type === "describeReply") {
      this.describes.settle(msg as unknown as DescribeReply);
      return;
    }
    if (msg.type === "notice") {
      this.delegate.onNotice((msg as { text: string }).text);
      return;
    }
    // Not routed to the delegate, and that is the whole point: the delegate's
    // onNotice is the message strip, which the engine's own opening messages
    // push this warning off within a turn or two (vect-hack-h4q, -dem).
    if (msg.type === "sessionOnly") {
      // Guarded: this reaches DOM mutation, and a page with broken chrome must
      // still get its engine. Same reasoning as the notice guard below.
      try { sessionOnlyListener?.((msg as { code: SessionOnlyCode }).code); }
      catch (err) { console.error("failed to report session-only saves:", err); }
      return;
    }
    if (msg.type === "fatal") {
      this.reportDeath((msg as { message: string }).message);
      return;
    }
    // The first message that is the engine's own rather than the Backplane's
    // lifecycle: past here, this game got as far as talking to its view. What
    // that buys is the difference between a death during play and a death on
    // the way in, which are two different pieces of advice (vect-hack-60i).
    this.started = true;
    let reply: Out | null;
    let notice: string | null = null;
    try {
      reply = await this.delegate.dispatch(msg);
    } catch (err) {
      // The engine is suspended waiting on this very message; answering
      // cancel-shaped beats wedging it forever.
      console.error("view failed to answer the engine:", err);
      reply = this.delegate.fallback(msg);
      notice = `A display error cancelled the current action (${String(err)}).`;
    }
    if (reply !== null) this.worker.postMessage(reply);
    // Strictly after the reply, and guarded: onNotice reaches DOM mutation
    // (TextHud.message), and a throw there must cost the notice, never the
    // unwedging this catch exists to guarantee.
    if (notice !== null) {
      try { this.delegate.onNotice(notice); }
      catch (err) { console.error("failed to report the display error:", err); }
    }
  }

  terminate(): void {
    this.worker.terminate();
  }

  /** The volume, packed for the player to keep. The bytes live in the
   *  worker's filesystem, so this is a round trip; it rejects rather than
   *  hanging. Posted directly rather than through send(): the request is
   *  Backplane vocabulary, typed in each Module's Out union for its worker's
   *  benefit, not something the main-thread Module code ever constructs. */
  exportSave(): Promise<ExportedSave> {
    return this.exports.request((msg) => this.worker.postMessage(msg));
  }

  /** The engine's own name for what is at a map cell, in the Module's own
   *  grid coordinates, or null when there is nothing honest to say. Posted
   *  directly rather than through send(), for the same reason exportSave() is:
   *  the request is Backplane vocabulary, typed into each Module's Out union
   *  for its worker's benefit, not something Module code constructs. A hover
   *  fires constantly, so only the latest request is ever answered — every
   *  earlier promise resolves null. */
  describe(x: number, y: number): Promise<string | null> {
    return this.describes.request((msg) => this.worker.postMessage(msg), x, y);
  }

  /** Send a Module-owned lifecycle command that does not owe a reply. */
  send(message: Out): void {
    this.worker.postMessage(message);
  }
}
