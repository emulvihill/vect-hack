// Debug tty view for the Angband Module: renders the 80x24 grid as
// colored text and feeds keys to the engine. Deliberately NOT DebugView —
// that one is welded to NetHack's windowport events (print_glyph, TextHud
// windows); this one speaks AngbandEvent and remains the debug/no-GPU sibling
// of VectorView. Reuses index.html's existing .text-mode/#map styling.
import { KeyQueue } from "../../../backplane/keyQueue";
import type { AngbandEvent, AngbandKey } from "../protocol";
import type { AngbandHandler } from "../session";
import { AngbandGrid, gridToHtml } from "../grid";
import { mapKey } from "../keys";

/** How long a burst may wait for an animation frame that may never come. Two
 * frames at 60Hz: long enough to coalesce a step's worth of events, short
 * enough that a stalled pane still feels live. */
const FRAME_FALLBACK_MS = 32;

export class TtyView implements AngbandHandler {
  private grid = new AngbandGrid();
  private pending = false;
  private $map: HTMLElement;
  /** Single consumer, as the queue requires: the engine's one suspend point
   * is the only caller of nextKey. */
  private keys = new KeyQueue<AngbandKey>();
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

  handle(ev: AngbandEvent) {
    switch (ev.name) {
      case "text": this.grid.text(ev.x, ev.y, ev.rgb, ev.text); break;
      case "wipe": this.grid.wipe(ev.x, ev.y, ev.n); break;
      case "curs": this.grid.curs(ev.x, ev.y); break;
      case "clear": this.grid.clear(); break;
      case "flush": break; // frame boundary; redraws are coalesced below anyway
    }
    this.scheduleRender();
  }

  /** Backplane notices (engine death, quit, future storage warnings) render
   * as plain message lines above the tty grid — index.html's #messages
   * survives the Angband boot, whose debug path removes #view and #cmdbtn. */
  onNotice(text: string) {
    const div = document.createElement("div");
    div.textContent = text;
    document.getElementById("messages")?.appendChild(div);
  }

  nextKey(wait: boolean, _cmd: boolean): AngbandKey | null | Promise<AngbandKey | null> {
    return this.keys.next(wait);
  }

  /** Undo the constructor: unbind the key listener and release the engine's
   *  parked key wait. Called by AngbandSession when the session ends. */
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
   * costs about as much as the other (vect-hack-yzk). A microtask cannot do
   * this: Angband calls Term_fresh() once per changed square, so a town step
   * arrives as 28-71 separate tasks and every one of them drained its own
   * microtask, rebuilding the whole 80x24 grid — 40.4ms a step measured.
   * The frame is raced with a timer rather than trusted alone, because rAF
   * stalls in hidden panes and headless runs (DebugView precedent,
   * vect-hack-r05); whichever fires first renders and drops the other. */
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
