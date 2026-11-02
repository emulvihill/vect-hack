// Point-and-look: the engine's own name for whatever the pointer is over,
// beside the pointer (spec docs/specs/2026-08-18-look-hud-design.md).
//
// Game-free, like the radar beside it: it picks a cell with the renderer's own
// pickCell() — which already works in both cameras — rings it, and asks
// whoever wired `describe` for a name. Every Module's VectorView builds one;
// main.ts connects it to that Module's session in a line.
//
// The ring goes up the instant the pointer crosses into a new cell, because
// that answer is local; the word follows after a short debounce, because that
// one is a round trip to a worker. A hover crossing a room would otherwise
// fire one request per cell it passed through.

/** How long the pointer has to rest before the engine is asked. Short enough
 *  to feel immediate, long enough that a sweep across a room asks once or
 *  twice rather than forty times. */
export const LOOK_DEBOUNCE_MS = 50;
/** How long a tap's label stays up: touch has no hover to end it. */
export const LOOK_TAP_MS = 3_000;
/** The one-shot notice, in the same spirit as the first-person controls line. */
export const LOOK_HINT = "Point at anything to name it";
export const LOOK_HINT_MS = 2_500;
/** Gap between the pointer and the label's corner, in CSS pixels. */
const LABEL_OFFSET = 14;

/** What the HUD needs from a pointer event; PointerEvent and MouseEvent both fit. */
export interface LookPointer {
  clientX: number;
  clientY: number;
}

export interface LookTarget {
  addEventListener(type: string, listener: (event: LookPointer) => void): void;
  removeEventListener(type: string, listener: (event: LookPointer) => void): void;
}

export interface LookParent {
  appendChild(child: HTMLElement): unknown;
}

/** The renderer's half: DungeonRenderer satisfies this. Narrow on purpose —
 *  the unit test drives the HUD without a GPU. */
export interface LookRenderer {
  pickCell(clientX: number, clientY: number): { x: number; y: number } | null;
  setHighlight(cell: { x: number; y: number } | null): void;
}

export type Describer = (x: number, y: number) => Promise<string | null>;

/** First letter up; everything after it is the engine's wording, untouched. */
export function lookLabel(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export class LookHud {
  /** Wired by main.ts to the Module's session. Null until then — and a hover
   *  before the engine is up simply shows nothing. */
  describe: Describer | null = null;

  private readonly el: HTMLElement;
  private cell: { x: number; y: number } | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  /** The hint's own hide, held apart from `expiry`: every browser fires a
   *  pointermove alongside the pointerenter that raised the hint, and that
   *  move cancels the pending question's timers. Sharing one slot let it
   *  cancel the hint's hide too — with `describe` wired the hint flashed for
   *  a debounce instead of its window, and without one it never went away. */
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every new question and by every clear; a reply whose generation
   *  is stale is one for a cell the pointer has already left. */
  private generation = 0;
  private hinted = false;

  // Bound once and held so dispose() can remove exactly what the constructor
  // added — LookTarget has no removeEventListener-by-type-alone shorthand.
  private readonly onMove = (e: LookPointer) => this.point(e);
  private readonly onEnter = (e: LookPointer) => this.hint(e);
  private readonly onLeave = () => this.clear();
  private readonly onClick = (e: LookPointer) => this.point(e, true);

  constructor(private readonly canvas: LookTarget, parent: LookParent, private readonly renderer: LookRenderer) {
    this.el = document.createElement("div");
    this.el.id = "looklabel";
    this.el.hidden = true;
    parent.appendChild(this.el);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerenter", this.onEnter);
    canvas.addEventListener("pointerleave", this.onLeave);
    // Touch and pen: a tap names what it is about to act on. Deliberately not
    // preventDefault and not stopPropagation — NetHack's click verbs and the
    // right-click action menu are bound to this same element, and the label
    // names the target of the verb rather than replacing it.
    canvas.addEventListener("click", this.onClick);
  }

  /** Drop ring and label: the pointer left, the engine died, or a describe
   *  failed. Also the fatal-notice path — every VectorView calls this from
   *  onNotice. */
  clear(): void {
    this.generation++;
    this.cancel();
    this.cancelHint();
    this.cell = null;
    this.renderer.setHighlight(null);
    this.hide();
  }

  /** Undo the constructor: unregister every listener it added, then drop the
   *  element. A Module's VectorView owns a LookHud for its own lifetime and
   *  must be able to tear it down without leaking a closure onto a canvas
   *  that outlives it. */
  dispose(): void {
    this.cancel();
    this.cancelHint();
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerenter", this.onEnter);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("click", this.onClick);
    this.el.remove();
  }

  /** One pointer position: ring the cell now, ask for its name shortly.
   *  `tap` re-asks even for the cell already under the pointer — a touch
   *  device has no hover, so the tap itself is the whole gesture. */
  private point(e: LookPointer, tap = false): void {
    this.place(e.clientX, e.clientY);
    const cell = this.renderer.pickCell(e.clientX, e.clientY);
    if (!cell) { this.clear(); return; }
    if (!tap && this.cell && this.cell.x === cell.x && this.cell.y === cell.y) return;
    this.cell = cell;
    this.renderer.setHighlight(cell);
    this.cancel();
    const gen = ++this.generation;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.ask(cell, gen, tap);
    }, LOOK_DEBOUNCE_MS);
  }

  private async ask(cell: { x: number; y: number }, gen: number, tap: boolean): Promise<void> {
    const describe = this.describe;
    if (!describe) return;
    let text: string | null;
    try {
      text = await describe(cell.x, cell.y);
    } catch (err) {
      console.warn("look: the engine could not be asked:", err);
      if (gen === this.generation) this.clear();
      return;
    }
    if (gen !== this.generation) return; // the pointer has moved on
    if (!text) { this.hide(); return; }
    this.show(text);
    // Touch has no pointerleave to end the label, so a tap's answer expires.
    if (tap) this.after(LOOK_TAP_MS, () => this.clear());
  }

  private hint(e: LookPointer): void {
    if (this.hinted) return;
    this.hinted = true;
    this.place(e.clientX, e.clientY);
    this.show(LOOK_HINT);
    // Only the hint takes itself down. By the time this fires an engine answer
    // may well have replaced it, and that label is not the hint's to hide.
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      if (this.el.textContent === lookLabel(LOOK_HINT)) this.hide();
    }, LOOK_HINT_MS);
  }

  private show(text: string): void {
    this.el.textContent = lookLabel(text);
    this.el.hidden = false;
  }

  private hide(): void {
    this.el.hidden = true;
    this.el.textContent = "";
  }

  private place(clientX: number, clientY: number): void {
    // Fixed positioning, so this is the whole arithmetic: no offset against
    // the stage's box, and no clipping by it near the edges.
    this.el.style.left = `${clientX + LABEL_OFFSET}px`;
    this.el.style.top = `${clientY + LABEL_OFFSET}px`;
  }

  private after(ms: number, run: () => void): void {
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => { this.expiry = null; run(); }, ms);
  }

  private cancel(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.debounce = this.expiry = null;
  }

  /** Apart from cancel(): a pointermove must not take the hint down with it. */
  private cancelHint(): void {
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    this.hintTimer = null;
  }
}
