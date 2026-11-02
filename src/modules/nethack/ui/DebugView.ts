// Debug text view: a tty-style map on top of the shared text HUD. Purpose is
// to prove the bridge end-to-end in plain characters; the 3D VectorView is the
// product UI. Reachable with ?view=debug.
import type { ShimEvent } from "../protocol";
import type { ShimReply, NethackHandler } from "../session";
import { TextHud, escapeHtml, HUD_COLORS } from "./TextHud";
import { CLR } from "../../../backplane/colors";

const COLS = 80, ROWS = 21;

interface Cell { ch: string; color: number }

export class DebugView implements NethackHandler {
  private hud = new TextHud();

  private map: Cell[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ ch: " ", color: 7 })));
  private mapDirty = false;
  private $map: HTMLElement;

  constructor() {
    const stage = document.getElementById("stage")!;
    stage.classList.add("text-mode");
    this.$map = document.createElement("pre");
    this.$map.id = "map";
    stage.appendChild(this.$map);
  }

  onReady(constants: Record<string, Record<string, number | string>>) {
    this.hud.onReady(constants);
  }

  onNotice(text: string) {
    this.hud.message(text);
  }

  /** Undo the constructor (vect-hack-a8r). This view binds nothing itself —
   *  every listener and the key queue belong to the HUD it composes — so the
   *  whole of its teardown is handing that on. */
  dispose(): void {
    this.hud.dispose();
  }

  handle(ev: ShimEvent): ShimReply | Promise<ShimReply> {
    switch (ev.name) {
      case "print_glyph": {
        const row = this.map[ev.y];
        if (row && ev.x >= 0 && ev.x < COLS)
          row[ev.x] = { ch: ev.cell.ch, color: ev.cell.color };
        this.scheduleFlush();
        return;
      }
      case "clear_nhwindow":
        if (this.hud.isMap(ev.win)) { this.clearMap(); return; }
        break;
      case "display_nhwindow":
        if (this.hud.isMap(ev.win)) { this.scheduleFlush(); return; }
        break;
    }
    return this.hud.handle(ev);
  }

  private clearMap() {
    for (const row of this.map) for (const c of row) { c.ch = " "; c.color = 7; }
    this.scheduleFlush();
  }

  /** Coalesce map redraws with a microtask — rAF stalls in hidden panes. */
  private scheduleFlush() {
    if (this.mapDirty) return;
    this.mapDirty = true;
    queueMicrotask(() => this.flush());
  }

  private flush() {
    if (!this.mapDirty) return;
    this.mapDirty = false;
    this.$map.innerHTML = this.map.map((row) => {
      let html = "", run = "", runColor = -1;
      const emit = () => {
        if (run) html += `<span style="color:${HUD_COLORS[runColor] ?? HUD_COLORS[CLR.GRAY]}">${escapeHtml(run)}</span>`;
        run = "";
      };
      for (const c of row) {
        if (c.color !== runColor) { emit(); runColor = c.color; }
        run += c.ch;
      }
      emit();
      return html;
    }).join("\n");
  }
}
