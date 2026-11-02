import { KeyQueue } from "../../../backplane/keyQueue";
import { MoriaGrid, gridToHtml } from "../grid";
import { mapKey } from "../keys";
import type { MoriaEvent, MoriaInputContext, MoriaKeyMode } from "../protocol";
import type { MoriaHandler } from "../session";

const FRAME_FALLBACK_MS = 32;

export class TtyView implements MoriaHandler {
  private grid = new MoriaGrid();
  private keys = new KeyQueue<number>();
  private pending = false;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private context: MoriaInputContext = "literal";
  private mode: MoriaKeyMode = "original";
  private $map: HTMLElement;
  private readonly keydown = (event: KeyboardEvent) => this.onKey(event);

  constructor() {
    const stage = document.getElementById("stage")!;
    stage.classList.add("text-mode");
    this.$map = document.createElement("pre");
    this.$map.id = "map";
    stage.appendChild(this.$map);
    document.addEventListener("keydown", this.keydown);
  }

  handle(ev: MoriaEvent): void {
    if (ev.name === "frame") this.grid.frame(ev.cells, ev.x, ev.y);
    this.scheduleRender();
  }

  onNotice(text: string): void {
    const line = document.createElement("div");
    line.textContent = text;
    document.getElementById("messages")?.appendChild(line);
  }

  async nextKey(
    wait: boolean,
    context: MoriaInputContext,
    mode: MoriaKeyMode,
  ): Promise<number | null> {
    this.context = context;
    this.mode = mode;
    try {
      return await this.keys.next(wait);
    } finally {
      this.context = "literal";
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("keydown", this.keydown);
    // The listener above was the only thing that could ever push, so a wait
    // parked on nextKey would never settle (vect-hack-a8r).
    this.keys.cancel();
    if (this.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    clearTimeout(this.timer);
    this.pending = false;
  }

  private onKey(event: KeyboardEvent): void {
    const key = mapKey(event, this.context, this.mode);
    if (key === null) return;
    event.preventDefault();
    this.keys.push(key);
  }

  private scheduleRender(): void {
    if (this.pending || this.disposed) return;
    this.pending = true;
    const render = () => {
      if (!this.pending || this.disposed) return;
      this.pending = false;
      clearTimeout(this.timer);
      if (this.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.$map.innerHTML = gridToHtml(this.grid);
    };
    this.timer = setTimeout(render, FRAME_FALLBACK_MS);
    if (typeof requestAnimationFrame === "function") this.frame = requestAnimationFrame(render);
  }
}
