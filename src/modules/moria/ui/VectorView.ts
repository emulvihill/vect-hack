import { CellGrid } from "../../../backplane/cell";
import { KeyQueue } from "../../../backplane/keyQueue";
import { DungeonRenderer, type DungeonRendererOptions } from "../../../render/DungeonRenderer";
import { Radar } from "../../../ui/hud/Radar";
import { LookHud } from "../../../ui/hud/Look";
import { STEP_OF } from "../../../ui/gaze";
import { gazeKey } from "../../../ui/gazeControls";
import { MORIA_COLS, MORIA_ROWS, MoriaClassifier } from "../classifier";
import { MoriaGrid, gridToHtml } from "../grid";
import {
  inferMoriaHit,
  moriaKeyDir,
  ORIGINAL_DIRECTIONS,
  ROGUELIKE_DIRECTIONS,
  type MoriaDir,
} from "../hitInference";
import { mapKey } from "../keys";
import { OVERLAY } from "../mapRecords";
import type { MoriaEvent, MoriaInputContext, MoriaKeyMode } from "../protocol";
import type { MoriaSemanticState } from "../semanticProtocol";
import type { MoriaHandler } from "../session";

const FRAME_FALLBACK_MS = 32;
const MAX_MESSAGES = 200;
const TTY_COLS = 80;
const PROMPT_ROW = 0;
const SIDEBAR_COLS = 13;
const SIDEBAR_TOP = 1;
const SIDEBAR_ROWS = 22;

/** Umoria's sanitized semantic dungeon plus its canonical 80x24 term mirror. */
export class VectorView implements MoriaHandler {
  readonly renderer: DungeonRenderer;
  private readonly radar: Radar;
  /** Point-and-look (spec 2026-08-18). main.ts connects its describer. */
  readonly look: LookHud;
  private readonly classifier = new MoriaClassifier();
  private readonly tty = new MoriaGrid();
  private readonly keys = new KeyQueue<number>();
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
  private state: MoriaSemanticState | null = null;
  private needsRecentre = true;
  private pending = false;
  private commandInput = false;
  private inputContext: MoriaInputContext = "literal";
  private mode: MoriaKeyMode = "original";
  private lastDir: MoriaDir | null = null;
  /** Original-mode run is the two source inputs '.' then a direction. */
  private runContinuation: number | null = null;
  /** Direction waiting for the real getDirectionWithMemory() literal read. */
  private pendingRunDir: MoriaDir | null = null;
  /** A user-entered original '.' whose source direction read is still active. */
  private manualRunPending = false;
  /** True only while a literal KeyQueue waiter will consume the next byte. */
  private literalInputPending = false;

  constructor(canvas: HTMLCanvasElement, opts: DungeonRendererOptions = {}) {
    this.canvas = canvas;
    this.renderer = new DungeonRenderer(canvas, new CellGrid(MORIA_COLS, MORIA_ROWS), opts);
    this.radar = new Radar(canvas.parentElement ?? document.body);
    this.renderer.onFrame = (heading) => this.radar.draw(this.renderer.map, heading);
    this.look = new LookHud(canvas, canvas.parentElement ?? document.body, this.renderer);

    this.$sidebar = document.createElement("pre");
    this.$sidebar.id = "moria-sidebar";
    (canvas.parentElement ?? document.body).appendChild(this.$sidebar);

    document.addEventListener("keydown", this.keydown);
    this.started = this.renderer.start().then(() => {
      console.info(`[vect-hack] renderer backend: ${this.renderer.backend}`);
    }, (error: unknown) => {
      console.error("[vect-hack] renderer start failed", error);
      this.onNotice("This browser's GPU would not start the vector view. "
        + "Reload with ?game=moria&view=debug for the text view, or try Chrome or Firefox.");
    });
  }

  handle(event: MoriaEvent): void {
    switch (event.name) {
      case "frame":
        this.tty.frame(event.cells, event.x, event.y);
        break;
      case "bell":
        break;
      case "map": {
        if (event.reset) {
          this.renderer.map.clear();
          this.lastDir = null;
          this.runContinuation = null;
          this.pendingRunDir = null;
          this.manualRunPending = false;
          this.literalInputPending = false;
          this.needsRecentre = true;
        }
        for (const { x, y, cell } of this.classifier.classify(event.records)) {
          this.renderer.map.set(x, y, cell);
        }
        this.renderer.syncHero();
        if (this.needsRecentre && this.renderer.map.hero !== null) {
          this.needsRecentre = false;
          this.renderer.recentre();
        }
        this.radar.invalidate();
        break;
      }
      case "state":
        this.state = event.state;
        break;
      case "message": {
        // originalCommands('.') prints this exact prompt before its second
        // read. Any different source line makes the queued byte ambiguous for
        // hit inference even though the engine may still consume it.
        if (this.runContinuation !== null && event.text !== "Which direction?") {
          this.pendingRunDir = null;
        }
        const victim = inferMoriaHit(event.text, this.renderer.map.hero, this.lastDir);
        if (victim !== null) this.renderer.hitFlash(victim.x, victim.y);
        this.message(cleanText(event.text));
        break;
      }
    }
    this.scheduleRender();
  }

  onNotice(text: string): void {
    // A fatal notice means nothing can be named any more; an ordinary one is
    // no reason to keep a label the player has stopped looking at either.
    this.look.clear();
    this.message(cleanText(text));
  }

  nextKey(
    wait: boolean,
    context: MoriaInputContext,
    mode: MoriaKeyMode,
  ): number | null | Promise<number | null> {
    this.mode = mode;
    const result = this.keys.next(wait);

    // The internally queued direction is the second half of original-mode
    // camera run. It is a literal prompt answer, but still belongs to the
    // fresh movement command and must not erase hit evidence.
    const consumedContinuation = typeof result === "number"
      && context === "literal" && result === this.runContinuation;
    if (consumedContinuation) {
      this.lastDir = this.pendingRunDir;
      this.runContinuation = null;
      this.pendingRunDir = null;
    } else if (context !== "outer-command" && !this.manualRunPending) {
      this.lastDir = null;
      this.runContinuation = null;
      this.pendingRunDir = null;
    }

    // Only an actually parked outer-command request may arm gaze remapping.
    this.commandInput = context === "outer-command" && result instanceof Promise;
    this.literalInputPending = context === "literal" && result instanceof Promise;
    this.inputContext = result instanceof Promise ? context : "literal";
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

  private onKey(event: KeyboardEvent): void {
    if (event.key === "F2") {
      event.preventDefault();
      this.message(this.renderer.toggleMode() === "first"
        ? "First-person view. Arrows walk where you look, left/right turn, shift runs. F2 returns to the orbital camera."
        : "Orbital view. Direction keys follow the camera; keypad 5 faces north.");
      return;
    }

    if (this.commandInput) {
      const gaze = gazeKey(event, this.renderer);
      if (gaze) {
        event.preventDefault();
        if (gaze.kind === "move") this.sendMovement(gaze.direction, gaze.run);
        return;
      }
    }

    const key = mapKey(event, this.inputContext, this.mode);
    if (key === null) return;
    event.preventDefault();
    this.sendRaw(key);
  }

  private sendMovement(direction: number, run: boolean): void {
    const [dx, dy] = STEP_OF[direction]!;
    const dir = { dx, dy };
    if (this.mode === "original") {
      const directionKey = ORIGINAL_DIRECTIONS.charCodeAt(direction);
      if (run) {
        // '.' is not the movement evidence. Arm only when the engine consumes
        // the exact queued direction in its following literal read.
        this.lastDir = null;
        this.runContinuation = directionKey;
        this.pendingRunDir = dir;
        this.manualRunPending = false;
        this.keys.push(".".charCodeAt(0));
        this.keys.push(directionKey);
      } else {
        this.lastDir = dir;
        this.runContinuation = null;
        this.pendingRunDir = null;
        this.manualRunPending = false;
        this.keys.push(directionKey);
      }
    } else {
      const key = ROGUELIKE_DIRECTIONS[direction]!;
      this.lastDir = dir;
      this.runContinuation = null;
      this.pendingRunDir = null;
      this.manualRunPending = false;
      this.keys.push((run ? key.toUpperCase() : key).charCodeAt(0));
    }
    this.commandInput = false;
    this.literalInputPending = false;
    this.inputContext = "literal";
  }

  private sendRaw(key: number): void {
    const direction = moriaKeyDir(key, this.mode);
    let bufferedRunDirection = false;
    if (this.commandInput && this.mode === "original" && key === ".".charCodeAt(0)) {
      this.lastDir = null;
      this.manualRunPending = true;
    } else if (this.inputContext === "literal" && this.manualRunPending) {
      if (direction !== null) {
        if (this.literalInputPending) {
          this.lastDir = direction;
        } else {
          this.lastDir = null;
          this.runContinuation = key;
          this.pendingRunDir = direction;
          bufferedRunDirection = true;
        }
        this.manualRunPending = false;
      } else if (key === 27) {
        this.lastDir = null;
        this.manualRunPending = false;
      }
    } else {
      this.lastDir = this.commandInput ? direction : null;
      this.manualRunPending = false;
    }
    if (!bufferedRunDirection) {
      this.runContinuation = null;
      this.pendingRunDir = null;
    }
    this.keys.push(key);
    this.commandInput = false;
    this.literalInputPending = false;
    this.inputContext = "literal";
  }

  private message(text: string): void {
    if (!text) return;
    const line = document.createElement("div");
    line.textContent = text;
    const messages = document.getElementById("messages");
    messages?.appendChild(line);
    while (messages && messages.childElementCount > MAX_MESSAGES) messages.firstChild!.remove();
  }

  private scheduleRender(): void {
    if (this.pending) return;
    this.pending = true;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => {
      if (!this.pending) return;
      this.pending = false;
      clearTimeout(timer);
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);

      this.$prompt.innerHTML = gridRegionToHtml(this.tty, 0, PROMPT_ROW, TTY_COLS, 1);
      this.$prompt.hidden = false;
      this.$sidebar.innerHTML = gridRegionToHtml(
        this.tty, 0, SIDEBAR_TOP, SIDEBAR_COLS, SIDEBAR_ROWS,
      );
      this.$status.textContent = this.state === null ? "" : statusText(this.state);

      const overlayActive = this.state !== null && this.state.overlay !== OVERLAY.NONE;
      this.canvas.style.visibility = overlayActive ? "hidden" : "";
      this.$sidebar.hidden = overlayActive;
      this.$overlay.hidden = !overlayActive;
      this.$overlay.innerHTML = overlayActive ? gridToHtml(this.tty) : "";
    };
    timer = setTimeout(render, FRAME_FALLBACK_MS);
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(render);
  }
}

function statusText(state: MoriaSemanticState): string {
  const conditions = [
    state.blind ? "Blind" : "",
    state.hallucinating ? "Hallucinating" : "",
    state.confused ? "Confused" : "",
    state.afraid ? "Afraid" : "",
    state.poisoned ? "Poisoned" : "",
    state.resting ? "Resting" : "",
  ].filter(Boolean).join(" ");
  return `${state.playerName}  L${state.playerLevel} XP ${state.experience} AU ${state.gold}`
    + `  HP ${state.hp}/${state.maxHp} MP ${state.mana}/${state.maxMana} AC ${state.ac}`
    + `  Depth ${state.depth} Turn ${state.turn}${conditions ? `  ${conditions}` : ""}`;
}

function gridRegionToHtml(
  grid: MoriaGrid,
  left: number,
  top: number,
  width: number,
  height: number,
): string {
  const rows: string[] = [];
  const cursorInRange = grid.cursor.x >= left && grid.cursor.x < left + width
    && grid.cursor.y >= top && grid.cursor.y < top + height;
  for (let y = top; y < top + height; y++) {
    let row = "";
    for (let x = left; x < left + width; x++) {
      const ch = escapeHtml(String.fromCharCode(grid.cells[y * TTY_COLS + x]!));
      row += cursorInRange && grid.cursor.x === x && grid.cursor.y === y
        ? `<span class="cursor" style="text-decoration:underline">${ch}</span>`
        : ch;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
