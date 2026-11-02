// 3D arcade-vector view for the Larn Module: feeds a DungeonRenderer over a
// 67x17 CellGrid and mirrors Larn's canonical 80x24 term into the page DOM.
//
// Molded on src/modules/angband/ui/VectorView.ts, including gaze-relative
// movement (vect-hack-bil): direction keys are screen-relative through the
// shared gazeControls adapter, encoded with Larn's own vi bytes
// (keys.ts's movementKey). The command/prompt discriminator the arming
// depends on is the native __wrap_yylex flag (native/main-wasm.c): only a
// read from parse()'s command fetcher arrives with cmd=1, so a prompt always
// sees the unremapped key. Raw vi-keys still pass straight through.
import { KeyQueue } from "../../../backplane/keyQueue";
import { CellGrid } from "../../../backplane/cell";
import { DungeonRenderer, type DungeonRendererOptions } from "../../../render/DungeonRenderer";
import { Radar } from "../../../ui/hud/Radar";
import { LookHud } from "../../../ui/hud/Look";
import { gazeKey } from "../../../ui/gazeControls";
import { LARN_COLS, LARN_ROWS, LarnClassifier } from "../classifier";
import { LarnGrid, gridRegionToHtml, gridToHtml } from "../grid";
import { mapKey, movementKey } from "../keys";
import type { LarnEvent, LarnKey } from "../protocol";
import type { LarnHandler } from "../session";

const FRAME_FALLBACK_MS = 32;
const MAX_MESSAGES = 200;

// tty mirror geometry, pinned to external/larn/display.c.
//
//   map:      rows 0-16, cols 0-66 (MAXX=67, MAXY=17; drawscreen writes
//             cursor(j+1, i+1) for j<MAXX, i<MAXY — 1-based).
//   status:   1-based row 18 (cursor(1,18) at display.c:70) = 0-based row 17,
//             continuing onto 1-based row 19 (the HP line printed after the
//             \n at display.c:80) = 0-based row 18. Two rows.
//   sidebar:  botside (display.c:203) writes cursor(70, i+1) for i=0..16
//             => 0-based col 69, rows 0-16. Side-panel status (class at
//             cursor(59,18) display.c:111, levelname at cursor(59,19)
//             display.c:130, gold at cursor(69,19) display.c:136) lives on
//             the status rows and is carried by the status region below.
//   messages: 0-based rows 19-23 — the scrolling prompt/message area
//             (seepage() clears via cl_up at display.c:561; help/menus scroll
//             here). Five rows.
const ROW_STATUS = 17;
const ROW_STATUS_HEIGHT = 2;
const ROW_MESSAGE = 19;
const ROW_MESSAGE_HEIGHT = 5;
const COL_SIDEBAR = 69;
const SIDEBAR_WIDTH = 11;
const SIDEBAR_HEIGHT = 17;

/** Larn's semantic dungeon view plus a mirror of its canonical 80x24 term. */
export class VectorView implements LarnHandler {
  readonly renderer: DungeonRenderer;
  private readonly radar: Radar;
  /** Point-and-look (spec 2026-08-18). main.ts connects its describer. */
  readonly look: LookHud;
  private readonly classifier = new LarnClassifier();
  private readonly tty = new LarnGrid();
  private readonly keys = new KeyQueue<LarnKey>();
  private disposed = false;
  /** Bound once and held so dispose() can remove exactly what the constructor
   *  added — an anonymous closure cannot be un-added, which is how this view
   *  used to leak one document listener per session (vect-hack-a8r). */
  private readonly keydown = (e: KeyboardEvent) => this.onKey(e);
  private readonly started: Promise<void>;
  private readonly canvas: HTMLCanvasElement;
  private readonly $prompt = document.getElementById("prompt")!;
  private readonly $status = document.getElementById("status")!;
  private readonly $overlay = document.getElementById("overlay")!;
  private readonly $sidebar: HTMLElement;
  private needsRecentre = true;
  private overlayActive = false;
  private pending = false;
  private commandInput = false;

  constructor(canvas: HTMLCanvasElement, opts: DungeonRendererOptions = {}) {
    this.canvas = canvas;
    this.renderer = new DungeonRenderer(canvas, new CellGrid(LARN_COLS, LARN_ROWS), opts);
    this.radar = new Radar(canvas.parentElement ?? document.body);
    this.renderer.onFrame = (heading) => this.radar.draw(this.renderer.map, heading);
    this.look = new LookHud(canvas, canvas.parentElement ?? document.body, this.renderer);

    this.$sidebar = document.createElement("pre");
    this.$sidebar.id = "larn-sidebar";
    (canvas.parentElement ?? document.body).appendChild(this.$sidebar);

    document.addEventListener("keydown", this.keydown);
    this.started = this.renderer.start().then(() => {
      console.info(`[vect-hack] renderer backend: ${this.renderer.backend}`);
    }, (error: unknown) => {
      console.error("[vect-hack] renderer start failed", error);
      this.onNotice("This browser's GPU would not start the vector view. "
        + "Reload with ?game=larn&view=debug for the text view, or try Chrome or Firefox.");
    });
  }

  handle(ev: LarnEvent): void {
    switch (ev.name) {
      case "text": this.tty.text(ev.x, ev.y, ev.rgb, ev.text); break;
      case "wipe": this.tty.wipe(ev.x, ev.y, ev.n); break;
      case "curs": this.tty.curs(ev.x, ev.y); break;
      case "clear": this.tty.clear(); break;
      case "flush": break;
      case "map": {
        for (const { x, y, cell } of this.classifier.classify(ev.records)) {
          this.renderer.map.set(x, y, cell);
        }
        this.renderer.syncHero();
        if (this.needsRecentre && this.renderer.map.hero) {
          this.needsRecentre = false;
          this.renderer.recentre();
        }
        this.radar.invalidate();
        break;
      }
      case "level":
        this.renderer.map.clear();
        // Clear old-level effects immediately. Keep needsRecentre set so this
        // null-hero snap is not the final one: the first hero batch snaps at
        // the new position instead of leaving the camera on the old level.
        this.renderer.recentre();
        this.radar.invalidate();
        this.needsRecentre = true;
        break;
      case "overlay": this.overlayActive = ev.active; break;
    }
    this.scheduleRender();
  }

  onNotice(text: string): void {
    // A fatal notice means nothing can be named any more; an ordinary one is
    // no reason to keep a label the player has stopped looking at either.
    this.look.clear();
    this.message(cleanText(text));
  }

  nextKey(wait: boolean, cmd: boolean): LarnKey | null | Promise<LarnKey | null> {
    const result = this.keys.next(wait);
    // A nonblocking poll that found nothing has already been answered. Only a
    // parked command request may reinterpret a later browser key as movement.
    this.commandInput = cmd && result instanceof Promise;
    return result;
  }

  ready(): Promise<void> { return this.started; }

  /**
   * Undo the constructor (vect-hack-a8r): unbind the document listener,
   * release the engine's parked key wait, and hand every part that put
   * something on a node it does not own its own dispose. Called by the
   * Module's session when the session ends.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("keydown", this.keydown);
    // The listener above was the only thing that could ever push a key, so a
    // wait parked on nextKey would otherwise never settle — and the engine's
    // dispatch is awaiting it.
    this.keys.cancel();
    this.look.dispose();
    this.radar.dispose();
    this.renderer.dispose();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "F2") {
      e.preventDefault();
      this.message(this.renderer.toggleMode() === "first"
        ? "First-person view. Arrows walk where you look, left/right turn, shift runs. F2 returns to the orbital camera."
        : "Orbital view. Direction keys follow the camera; keypad 5 faces north.");
      return;
    }
    if (this.commandInput) {
      const gaze = gazeKey(e, this.renderer);
      if (gaze) {
        e.preventDefault();
        if (gaze.kind === "move") this.send(movementKey(gaze.direction, gaze.run));
        return;
      }
    }
    const key = mapKey(e);
    if (!key) return;
    e.preventDefault();
    this.send(key);
  }

  private send(key: LarnKey): void {
    this.keys.push(key);
    this.commandInput = false;
  }

  private message(text: string): void {
    if (!text) return;
    const line = document.createElement("div");
    line.textContent = text;
    const messages = document.getElementById("messages");
    messages?.appendChild(line);
    while (messages && messages.childElementCount > MAX_MESSAGES) messages.firstChild!.remove();
  }

  /** One redraw per burst — both the HTML build and the DOM write, since each
   *  costs about as much as the other (vect-hack-yzk, proven on Angband; Larn's
   *  lflush posts the same per-run event bursts). The frame is raced with a
   *  timer rather than trusted alone, because rAF stalls in hidden panes and
   *  headless runs (DebugView precedent, vect-hack-r05); whichever fires first
   *  renders and drops the other. */
  private scheduleRender(): void {
    if (this.pending) return;
    this.pending = true;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => {
      if (!this.pending) return;
      this.pending = false;
      clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      // The scrolling prompt/message area (rows 19-23).
      this.$prompt.innerHTML = gridRegionToHtml(this.tty, 0, ROW_MESSAGE, 80, ROW_MESSAGE_HEIGHT);
      this.$prompt.hidden = false;
      // The botside panel (col 69, rows 0-16).
      this.$sidebar.innerHTML = gridRegionToHtml(this.tty, COL_SIDEBAR, 0, SIDEBAR_WIDTH, SIDEBAR_HEIGHT);
      // The two status rows (rows 17-18), full width.
      this.$status.innerHTML = gridRegionToHtml(this.tty, 0, ROW_STATUS, 80, ROW_STATUS_HEIGHT);
      // A full-screen overlay (welcome, inventory, store, help) renders the
      // whole tty grid and hides the 3D surface + sidebar; restores when it
      // drops.
      // Keep the GPU surface laid out while an overlay owns the view. display:
      // none collapses the canvas to 0x0; reopening a small Larn inventory on
      // every command-boundary probe then rebuilds render targets repeatedly
      // and can leave the bloom chain saturated. Visibility hides the scene
      // without changing the renderer's drawing-buffer size.
      this.canvas.style.visibility = this.overlayActive ? "hidden" : "";
      this.$sidebar.hidden = this.overlayActive;
      this.$overlay.hidden = !this.overlayActive;
      this.$overlay.innerHTML = this.overlayActive ? gridToHtml(this.tty) : "";
    };
    timer = setTimeout(render, FRAME_FALLBACK_MS);
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(render);
  }
}

function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
