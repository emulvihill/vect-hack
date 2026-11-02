import { KeyQueue } from "../../../backplane/keyQueue";
import { CellGrid, TERRAIN_CATEGORIES, type Cell } from "../../../backplane/cell";
import { DungeonRenderer, type DungeonRendererOptions } from "../../../render/DungeonRenderer";
import { Radar } from "../../../ui/hud/Radar";
import { LookHud } from "../../../ui/hud/Look";
import { gazeKey } from "../../../ui/gazeControls";
import { ANGBAND_COLS, ANGBAND_ROWS, AngbandClassifier } from "../classifier";
import { AngbandGrid, gridRegionToHtml, gridToHtml } from "../grid";
import { angbandKeyDir, inferAngbandHit, type Dir, type Point } from "../hitInference";
import { mapKey, movementKey } from "../keys";
import type { AngbandEvent, AngbandKey } from "../protocol";
import type { AngbandHandler } from "../session";

const FRAME_FALLBACK_MS = 32;
const MAX_MESSAGES = 200;
// Pinned to upstream ui-term.c's SIDEBAR_LEFT arrays and ui-term.h's map edge.
const ROW_TOP = 1;
const ROW_BOTTOM = 1;
const COL_MAP = 13;

/** Angband's semantic dungeon view plus a mirror of its canonical 80x24 term. */
export class VectorView implements AngbandHandler {
  readonly renderer: DungeonRenderer;
  private readonly radar: Radar;
  /** Point-and-look (spec 2026-08-18). main.ts connects its describer. */
  readonly look: LookHud;
  private readonly classifier = new AngbandClassifier();
  private readonly tty = new AngbandGrid();
  private readonly keys = new KeyQueue<AngbandKey>();
  private disposed = false;
  /** Bound once and held so dispose() can remove exactly what the constructor
   *  added — an anonymous closure cannot be un-added, which is how this view
   *  used to leak one document listener per session (vect-hack-a8r). */
  private readonly keydown = (e: KeyboardEvent) => this.onKey(e);
  private readonly started: Promise<void>;
  private readonly $prompt = document.getElementById("prompt")!;
  private readonly $status = document.getElementById("status")!;
  private readonly $overlay = document.getElementById("overlay")!;
  private readonly $sidebar: HTMLElement;
  private needsRecentre = true;
  private overlayActive = false;
  private pending = false;
  private commandInput = false;
  /** Hit-inference bookkeeping (spec 2026-08-06): the last direction sent to
   *  the engine and the last ranged-effect cell, both fed to inferAngbandHit. */
  private lastDir: Dir | null = null;
  private lastEffect: Point | null = null;

  constructor(canvas: HTMLCanvasElement, opts: DungeonRendererOptions = {}) {
    this.renderer = new DungeonRenderer(canvas, new CellGrid(ANGBAND_COLS, ANGBAND_ROWS), opts);
    this.radar = new Radar(canvas.parentElement ?? document.body);
    this.renderer.onFrame = (heading) => this.radar.draw(this.renderer.map, heading);
    this.look = new LookHud(canvas, canvas.parentElement ?? document.body, this.renderer);

    this.$sidebar = document.createElement("pre");
    this.$sidebar.id = "angband-sidebar";
    (canvas.parentElement ?? document.body).appendChild(this.$sidebar);

    document.addEventListener("keydown", this.keydown);
    this.started = this.renderer.start().then(() => {
      console.info(`[vect-hack] renderer backend: ${this.renderer.backend}`);
    }, (error: unknown) => {
      console.error("[vect-hack] renderer start failed", error);
      this.onNotice("This browser's GPU would not start the vector view. "
        + "Reload with ?game=angband&view=debug for the text view, or try Chrome or Firefox.");
    });
  }

  handle(ev: AngbandEvent): void {
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
        // The old level's direction and effect cell name cells that no longer
        // exist: the new level's first message must not inherit them.
        this.lastDir = null;
        this.lastEffect = null;
        // Clear old-level effects immediately. Keep needsRecentre set so this
        // null-hero snap is not the final one: the first hero batch snaps at
        // the new position instead of leaving the camera on the old level.
        this.renderer.recentre();
        this.radar.invalidate();
        this.needsRecentre = true;
        break;
      case "message": {
        const victim = inferAngbandHit(
          ev.messageType, ev.text, this.renderer.map.hero, this.lastDir, this.lastEffect);
        // An effect cell answers the one message that follows it and no more.
        // send() cannot be the only consumer: under ?borg the decorator answers
        // the engine itself, so no key is ever sent and a missile's cell would
        // sit there until a later melee crit claimed it. Losing a pulse is the
        // safe side of "a guessed pulse is worse than none".
        this.lastEffect = null;
        if (victim) this.renderer.hitFlash(victim.x, victim.y);
        this.message(cleanText(ev.text));
        break;
      }
      case "overlay": this.overlayActive = ev.active; break;
      case "effect": {
        this.lastEffect = { x: ev.x, y: ev.y };
        const current = this.renderer.map.at(ev.x, ev.y);
        const terrain = terrainUnder(current);
        const cell: Cell = {
          category: "effect", ch: ev.ch, color: ev.color, rgb: ev.rgb,
          beam: ev.beam, ...(terrain ? { terrain } : {}),
        };
        this.renderer.map.set(ev.x, ev.y, cell);
        // The grid is engine truth and nothing in the record stream retracts an
        // effect Cell — the engine's own repaint of those grids does. That
        // repaint is paced by Angband's delay_factor (ui-display.c: draw,
        // Term_fresh, Term_xtra(TERM_XTRA_DELAY, delay_factor)), which the
        // player can set to 0 from the options menu; the set and the repaint
        // then reach us in one batch and no frame ever samples the blast. So
        // the render layer is told the effect FIRED as well, and gives it a
        // lifetime of its own (vect-hack-auo, MapFx.effect).
        this.renderer.effectFired(ev.x, ev.y, cell);
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

  nextKey(wait: boolean, cmd: boolean): AngbandKey | null | Promise<AngbandKey | null> {
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

  private send(key: AngbandKey): void {
    // Freshness is the disambiguator (see hitInference.ts): a direction key
    // sets lastDir ONLY at command level — a keypad direction typed into a
    // prompt (fire targeting, menus) answers a question, it is not a melee
    // move, and counting it would send a ranged crit's pulse to an adjacent
    // cell. Any other key clears lastDir, and every key starts a new
    // command, so the previous command's effect cell is stale.
    this.lastDir = this.commandInput ? angbandKeyDir(key) : null;
    this.lastEffect = null;
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
      this.$prompt.innerHTML = gridRegionToHtml(this.tty, 0, 0, 80, ROW_TOP);
      this.$prompt.hidden = false;
      this.$sidebar.innerHTML = gridRegionToHtml(
        this.tty, 0, ROW_TOP, COL_MAP, 24 - ROW_TOP - ROW_BOTTOM,
      );
      this.$sidebar.hidden = this.overlayActive;
      this.$status.innerHTML = gridRegionToHtml(this.tty, 0, 24 - ROW_BOTTOM, 80, ROW_BOTTOM);
      this.$overlay.hidden = !this.overlayActive;
      this.$overlay.innerHTML = this.overlayActive ? gridToHtml(this.tty) : "";
    };
    timer = setTimeout(render, FRAME_FALLBACK_MS);
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(render);
  }
}

function terrainUnder(cell: Cell): Cell | null {
  if (TERRAIN_CATEGORIES.has(cell.category)) return cell;
  return cell.terrain && TERRAIN_CATEGORIES.has(cell.terrain.category) ? cell.terrain : null;
}

function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
