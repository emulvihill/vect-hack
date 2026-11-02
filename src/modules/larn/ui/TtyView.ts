// Debug tty view for the Larn Module: renders the 80x24 grid as colored
// text and feeds keys to the engine. The Angband TtyView's sibling — same
// shape, Larn's protocol: it speaks LarnEvent (including wipe, which the
// shim decodes from CL_LINE/CL_DOWN) and remains the debug/no-GPU view;
// phase 2 adds the VectorView beside it. Reuses index.html's existing
// .text-mode/#map styling.
import { KeyQueue } from "../../../backplane/keyQueue";
import type { LarnEvent, LarnKey } from "../protocol";
import type { LarnHandler } from "../session";
import { LarnGrid, gridToHtml } from "../grid";
import { mapKey } from "../keys";

/** How long a burst may wait for an animation frame that may never come. Two
 * frames at 60Hz: long enough to coalesce a step's worth of events, short
 * enough that a stalled pane still feels live. */
const FRAME_FALLBACK_MS = 32;

export class TtyView implements LarnHandler {
  private grid = new LarnGrid();
  private pending = false;
  private $map: HTMLElement;
  /** Single consumer, as the queue requires: the engine's one suspend point
   * is the only caller of nextKey. */
  private keys = new KeyQueue<LarnKey>();
  private disposed = false;
  /** Bound once and held so dispose() can remove exactly what the
   *  constructor added — an anonymous closure cannot be un-added, which is
   *  how this view used to leak one listener per session (vect-hack-a8r). */
  private readonly keydown = (e: KeyboardEvent) => this.onKey(e);

  constructor() {
    const stage = document.getElementById("stage")!;
    stage.classList.add("text-mode");
    this.$map = document.createElement("pre");
    this.$map.id = "map";
    stage.appendChild(this.$map);
    document.addEventListener("keydown", this.keydown);
  }

  handle(ev: LarnEvent) {
    switch (ev.name) {
      case "text": this.grid.text(ev.x, ev.y, ev.rgb, ev.text); break;
      case "wipe": this.grid.wipe(ev.x, ev.y, ev.n); break;
      case "curs": this.grid.curs(ev.x, ev.y); break;
      case "clear": this.grid.clear(); break;
      case "flush": break; // frame boundary; redraws are coalesced below anyway
    }
    this.scheduleRender();
  }

  /** Backplane notices (engine death, quit, storage warnings) render as
   * plain message lines above the tty grid — index.html's #messages
   * survives the Larn boot, whose debug path removes #view and #cmdbtn. */
  onNotice(text: string) {
    const div = document.createElement("div");
    div.textContent = text;
    document.getElementById("messages")?.appendChild(div);
  }

  nextKey(wait: boolean, _cmd: boolean): LarnKey | null | Promise<LarnKey | null> {
    return this.keys.next(wait);
  }

  /** Undo the constructor: unbind the key listener and release the engine's
   *  parked key wait. Called by LarnSession when the session ends. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("keydown", this.keydown);
    this.keys.cancel();
  }

  private onKey(e: KeyboardEvent) {
    const key = mapKey(e);
    if (!key) return;
    e.preventDefault(); // arrows must not scroll, ctrl-combos must reach the game
    this.keys.push(key);
  }

  /** One redraw per burst — both the HTML build and the DOM write, since each
   * costs about as much as the other (vect-hack-yzk, proven on Angband; Larn's
   * lflush posts the same per-run event bursts). The frame is raced with a
   * timer rather than trusted alone, because rAF stalls in hidden panes and
   * headless runs (DebugView precedent, vect-hack-r05); whichever fires first
   * renders and drops the other. */
  private scheduleRender() {
    if (this.pending || this.disposed) return;
    this.pending = true;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => {
      if (!this.pending || this.disposed) return;
      this.pending = false;
      clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      this.$map.innerHTML = gridToHtml(this.grid);
    };
    timer = setTimeout(render, FRAME_FALLBACK_MS);
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(render);
  }
}
