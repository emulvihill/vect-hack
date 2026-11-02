// The product view: the dungeon rendered as arcade vector graphics, with the
// shared text HUD floating over it. It owns the NetHack half of the pipeline —
// print_glyph -> Classifier -> the CellGrid it hands the renderer; everything
// else goes to the HUD.
import type { ShimEvent } from "../protocol";
import type { ShimReply, NethackHandler } from "../session";
import { DungeonRenderer, type DungeonRendererOptions } from "../../../render/DungeonRenderer";
import { CellGrid } from "../../../backplane/cell";
import { NETHACK_COLS, NETHACK_ROWS, NetHackClassifier } from "../classifier";
import { Radar } from "../../../ui/hud/Radar";
import { LookHud } from "../../../ui/hud/Look";
import { TextHud } from "./TextHud";
import { inferNethackHit, nethackKeyDir, type Dir } from "../hitInference";
import { chord } from "./keys";
import { loadBindings } from "./keyBindings";
import { ORBITAL_BINDINGS, resolve, resolveTarget, type Action } from "./moveKeys";
import { ACTION_LABEL, applicableActions, heroActions, itemHereMessage, primaryAction, targetAt, type PointerTarget } from "./pointerActions";
import { installNethackTouch } from "./touchAdapter";
import type { TouchControls } from "../../../ui/touch/TouchControls";

/** Beyond this many pixels, a pointerdown/up pair was a camera drag (orbit or
 *  first-person look), not a click — the pointer is an action device only, so
 *  a drag that happens to end over the canvas must never read as one. */
const CLICK_DRAG_PX = 6;

export class VectorView implements NethackHandler {
  private hud = new TextHud();
  readonly renderer: DungeonRenderer;
  private radar: Radar;
  /** Point-and-look (spec 2026-08-18). main.ts connects its describer. */
  readonly look: LookHud;
  private classifier = new NetHackClassifier();
  private started: Promise<void>;
  private needsRecentre = true;
  // Loaded once per view: there's no live editor to change it mid-session
  // (vect-hack-be3.5 declined one), so a fresh reload is the only time a
  // saved change would need to take effect anyway.
  private bindings = loadBindings();
  /** Hit-inference bookkeeping (spec 2026-08-06): the direction of the
   *  command in flight, the only thing that says which cell a "You hit the
   *  newt!" is about. Null whenever nothing aims it. */
  private lastDir: Dir | null = null;
  /** #stage: where every absolutely-positioned overlay this view owns goes —
   *  the radar, the Look label and, behind ?touch, the pad and the bar. */
  private stage: HTMLElement;
  /** The canvas, held so dispose() can unbind the pointer listeners the
   *  constructor put on it — it belongs to index.html and outlives this view. */
  private canvas: HTMLCanvasElement;
  private disposed = false;
  /** Where the pointerdown of the gesture in flight landed. A field rather
   *  than a constructor local because the three handlers that read it are now
   *  named — an anonymous closure cannot be un-added (vect-hack-a8r). */
  private downX = 0;
  private downY = 0;

  constructor(canvas: HTMLCanvasElement, opts: DungeonRendererOptions = {}) {
    this.canvas = canvas;
    this.stage = canvas.parentElement ?? document.body;
    this.renderer = new DungeonRenderer(canvas, new CellGrid(NETHACK_COLS, NETHACK_ROWS), opts);
    // The radar has to turn with the camera, not just with the map, so it
    // repaints off the render loop — cheaply, since it skips a still frame.
    this.radar = new Radar(this.stage);
    this.renderer.onFrame = (facing) => this.radar.draw(this.renderer.map, facing);
    this.look = new LookHud(canvas, this.stage, this.renderer);
    // Gaze-relative movement in both modes; which table only decides what the
    // keys mean (orbital: all eight move; first person: left/right turn). The
    // mode check lives here because this is the object holding both the HUD
    // and the camera: the HUD never learns what a turn or a reset is, and the
    // resolver never learns what mode the renderer is in. Saved overrides
    // (loadBindings) apply to the first-person table only.
    this.hud.remap = (e) => {
      const table = this.renderer.mode === "first" ? this.bindings : ORBITAL_BINDINGS;
      const r = resolve(table[chord(e)], this.renderer.heading);
      if (r?.kind === "turn") { this.renderer.turn(r.delta); return "consumed"; }
      if (r?.kind === "reset") { this.renderer.resetFacing(); return "consumed"; }
      // resolve() never answers "keys" for a camera-relative action; that
      // shape belongs to resolveTarget()'s pointer/menu actions.
      return r?.kind === "key" ? r.code : null;
    };
    // Freshness is the whole disambiguator (see hitInference.ts): the message
    // text says a hit happened, the last key sent says where. Only a
    // command-level direction key aims it — an answer to a prompt or a menu
    // is not a step, and any other key clears the aim rather than leaving a
    // stale one to pulse the wrong cell.
    this.hud.onKeyFed = (code, command) => {
      this.lastDir = command ? nethackKeyDir(code) : null;
    };
    // F2 switches cameras. Function keys are the safe half of the keyboard for
    // view chrome: TextHud.keyCode() only translates its KEYMAP names and
    // single characters, so "F2" resolves to null and nothing is ever fed to
    // the game — while every letter and Ctrl-combination is a NetHack command.
    document.addEventListener("keydown", this.onF2);
    // Pointer actions (vect-hack-be3.3): left click resolves the one obvious
    // verb for whatever's under the cursor, right click lists every verb that
    // applies. Neither ever means "walk here" (be3.2 declined click-to-move)
    // — empty floor, or a target with no obvious verb, does nothing.
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    // Stepping onto loot: the engine's own announcement is the source of
    // truth (a glyph stash goes stale exactly when items are dropped under
    // the hero — spec 2026-07-30), and the menu it opens is passthrough so a
    // keyboard player never notices it.
    this.hud.onMessage = (text) => {
      if (itemHereMessage(text)) this.openHeroMenu(true);
    };
    this.started = this.renderer.start().then(() => {
      console.info(`[vect-hack] renderer backend: ${this.renderer.backend}`);
    }, (e: unknown) => {
      // The no-GPU-at-all case is caught before this view is ever built (see
      // ui/gpuSupport). Anything reaching here is a GPU that agreed and then
      // backed out — still not something to shout a TypeError about.
      console.error("[vect-hack] renderer start failed", e);
      this.hud.message("This browser's GPU would not start the vector view. "
        + "Reload with ?view=debug for the text view, or try Chrome or Firefox.");
    });
  }

  // Bound once and held so dispose() can remove exactly what the constructor
  // added. document and the canvas are index.html's, not this view's: every
  // anonymous closure put on them outlived the view that made it, so a second
  // view meant F2 toggled twice and one click ran two verbs (vect-hack-a8r).
  private readonly onF2 = (e: KeyboardEvent) => {
    if (e.key !== "F2") return;
    e.preventDefault();
    this.hud.message(this.renderer.toggleMode() === "first"
      ? "First-person view. Arrows walk where you look, left/right turn, "
        + "shift runs. F2 returns to the orbital camera."
      : "Orbital view. Direction keys follow the camera; keypad 5 faces north.");
  };
  private readonly onPointerDown = (e: PointerEvent) => {
    this.downX = e.clientX;
    this.downY = e.clientY;
  };
  private wasClick(e: MouseEvent): boolean {
    return Math.hypot(e.clientX - this.downX, e.clientY - this.downY) <= CLICK_DRAG_PX;
  }
  private readonly onClick = (e: MouseEvent) => {
    // A click whose pointerdown was spent closing the action menu is the
    // cancel gesture itself, not an aim at the cell under it.
    if (this.hud.consumeOutsideDismissal()) return;
    if (!this.wasClick(e)) return;
    const t = this.pickTarget(e.clientX, e.clientY);
    if (!t) return;
    if (t.isHero) return this.openHeroMenu(false);
    const action = primaryAction(t);
    if (action) this.sendAction(action, t.dir);
  };
  private readonly onContextMenu = (e: MouseEvent) => {
    e.preventDefault(); // the cameras already do this; stay consistent either way
    if (!this.wasClick(e)) return;
    const t = this.pickTarget(e.clientX, e.clientY);
    if (!t) return;
    if (t.isHero) return this.openHeroMenu(false);
    const dir = t.dir;
    this.hud.showActionMenu(applicableActions(t).map((a) => ({
      label: ACTION_LABEL[a], run: () => this.sendAction(a, dir),
    })));
  };

  /**
   * Undo the constructor (vect-hack-a8r): unbind everything this view put on
   * document and on the page's canvas, and hand every part that did the same
   * its own dispose. The HUD's dispose is what releases the engine's parked
   * key wait — this view owns no KeyQueue of its own.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("keydown", this.onF2);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("click", this.onClick);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.hud.dispose();
    this.look.dispose();
    this.radar.dispose();
    this.renderer.dispose();
  }

  onReady(constants: Record<string, Record<string, number | string>>) {
    this.hud.onReady(constants);
    this.classifier.configure(constants["GLYPH"]);
  }

  onNotice(text: string) {
    // A fatal notice means nothing can be named any more; an ordinary one is
    // no reason to keep a label the player has stopped looking at either.
    this.look.clear();
    this.hud.message(text);
  }

  handle(ev: ShimEvent): ShimReply | Promise<ShimReply> {
    switch (ev.name) {
      case "print_glyph":
        this.renderer.map.set(ev.x, ev.y, this.classifier.classify(ev.cell));
        return;
      case "curs":
        // getpos() — farlook, travel, targeting — walks the map cursor around
        // and the player has no other way to see where they are pointing.
        if (this.hud.isMap(ev.win)) {
          this.renderer.map.cursor = { x: ev.x, y: ev.y };
          return;
        }
        break;
      case "cliparound":
        // Fallback hero position: MG_HERO on a printed glyph is authoritative,
        // but cliparound still arrives on every flush and costs nothing.
        if (!this.renderer.map.hero) this.renderer.map.hero = { x: ev.x, y: ev.y };
        return;
      case "putstr":
        // Hit flash (spec 2026-08-06): combat text is the only hit signal
        // NetHack's shim hands a view. Inferred before the hud consumes the
        // line — it still gets it, below.
        if (this.hud.isMessage(ev.win)) {
          const victim = inferNethackHit(ev.text, this.renderer.map.hero, this.lastDir);
          if (victim) this.renderer.hitFlash(victim.x, victim.y);
        }
        break;
      case "clear_nhwindow":
        if (this.hud.isMap(ev.win)) {
          this.renderer.map.clear();
          this.radar.invalidate();
          this.needsRecentre = true; // new level: don't fly the camera across it
          this.lastDir = null; // and whatever the last key aimed at is gone with it
          return;
        }
        break;
      case "display_nhwindow":
        if (this.hud.isMap(ev.win)) {
          this.radar.invalidate(); // the monsters just moved
          if (this.needsRecentre && this.renderer.map.hero) {
            this.needsRecentre = false;
            this.renderer.recentre();
          } else {
            this.renderer.syncHero();
          }
          return;
        }
        break;
    }
    return this.hud.handle(ev);
  }

  /** Resolves once the GPU backend is up; used by boot diagnostics. */
  ready(): Promise<void> {
    return this.started;
  }

  /**
   * The touch scheme (vect-hack-21k), behind ?touch. A method here rather than
   * a call from main.ts so the HUD stays private: the touch layer needs the
   * same two objects this view already holds, and the composition root only
   * has to decide whether the flag is set.
   */
  installTouch(): TouchControls {
    return installNethackTouch(this.hud, this.renderer, this.stage);
  }

  private pickTarget(clientX: number, clientY: number): PointerTarget | null {
    const cell = this.renderer.pickCell(clientX, clientY);
    return cell && targetAt(this.renderer.map, cell.x, cell.y);
  }

  private sendAction(action: Action, dir: number | null): void {
    const r = resolveTarget(action, dir);
    if (r?.kind === "key") this.hud.sendKeys([r.code]);
    else if (r?.kind === "keys") this.hud.sendKeys(r.codes);
  }

  /** The hero's own cell has no single obvious verb, so both clicks open the
   *  same stand-on menu (spec 2026-07-30). Auto-opened (passthrough) when the
   *  engine announces loot underfoot; TextHud refuses a passthrough open
   *  while any menu, prompt or overlay is up, so this needs no guard here. */
  private openHeroMenu(passthrough: boolean): void {
    this.hud.showActionMenu(heroActions(this.renderer.map.under).map((r) => ({
      label: r.label, run: () => this.hud.sendKeys([r.code]),
    })), passthrough ? { passthrough: true } : undefined);
  }
}
