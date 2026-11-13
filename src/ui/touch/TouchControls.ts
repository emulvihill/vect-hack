// The touch scheme's DOM half (vect-hack-21k): a thumb pad, an action bar and
// the one piece of camera chrome a finger cannot otherwise reach. Shared and
// game-free — it builds the elements, routes each tap through scheme.ts, and
// hands the result to a Module's adapter. The other three Modules should need
// an adapter and nothing here.
//
// It creates its own elements rather than unhiding markup in index.html: the
// whole layer is behind a URL flag, and a page that never sets the flag should
// not carry a pad in its DOM. The CSS does live in index.html with the rest of
// the chrome, scoped to TOUCH_BODY_CLASS so it is inert until this installs.
//
// Nothing here resizes the canvas. Every element is absolutely positioned
// inside #stage, the same shape the storage notice takes and for the same
// reason: a WebGPU resize rebuilds the trail targets.
import { resolve, type GazeAction } from "../gaze";
import type { GazeCamera } from "../gazeControls";
import {
  BAR_ID, CAMERA_ID, LINE_ACCEPT, LINE_CANCEL, PAD_GRID, PAD_ID,
  PAD_LABEL, PAD_TITLE, TOUCH_BODY_CLASS, barMode, routeCommand, routePad,
  type BarMode, type PendingInput, type TouchBarItem,
} from "./scheme";

/** The camera the pad resolves against: the shared gaze surface plus the one
 *  thing a keyboard reaches with F2 and a finger has no key for. */
export interface TouchCamera extends GazeCamera {
  toggleMode(): "orbital" | "first";
}

/**
 * Everything a Module has to answer for its own touch build. Each method is
 * one seam the shared layer refuses to guess at.
 */
export interface TouchHost {
  /** Where the elements go: #stage, so nothing here resizes the canvas. */
  stage: HTMLElement;
  camera: TouchCamera;
  bar: readonly TouchBarItem[];
  /** What the engine is blocked on, asked fresh on every tap — the answer
   *  changes while a thumb is in the air. */
  pending(): PendingInput;
  /** The Module's own encoding of a compass eighth (clockwise from north),
   *  exactly the contract gazeControls hands its callers. */
  directionKey(direction: number): number;
  /**
   * Feed key codes through the Module's existing command seam.
   * `answersDirection` is true only for the pad answering a getdir() prompt,
   * which is the one shape a prompt lets past — the seam still decides.
   */
  send(codes: readonly number[], answersDirection: boolean): void;
  /** The Module's own command menu — the bar's tail, never a second one. */
  openMore(): void;
  /** Finish a line prompt: the soft keyboard's Return is not guaranteed to
   *  reach the page, and there is no other way off getlin() with no keys. */
  finishLine(accept: boolean): void;
  /** Say something to the player, in the Module's own message strip. */
  note(text: string): void;
}

/** How often the bar re-reads what the engine is waiting for, to dim itself.
 *  A poll rather than a subscription on purpose: this drives one CSS class,
 *  and the alternative is a change notification threaded through five
 *  unrelated places in TextHud for a visual that nobody can perceive at 8Hz. */
const BAR_POLL_MS = 120;

export class TouchControls {
  private pad: HTMLDivElement;
  private bar: HTMLDivElement;
  private cameraBtn: HTMLButtonElement;
  private poll: ReturnType<typeof setInterval>;
  private mode: BarMode | null = null;

  constructor(private host: TouchHost) {
    document.body.classList.add(TOUCH_BODY_CLASS);

    this.pad = document.createElement("div");
    this.pad.id = PAD_ID;
    PAD_GRID.forEach((action, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.textContent = PAD_LABEL[i]!;
      b.title = PAD_TITLE[i]!;
      // pointerdown, not click: a step should land under the thumb rather
      // than on the lift, and the pad is the one control pressed in a hurry.
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        b.blur(); // a focused button would eat the next Space or Enter
        this.tapPad(action);
      });
      this.pad.appendChild(b);
    });

    this.bar = document.createElement("div");
    this.bar.id = BAR_ID;

    this.cameraBtn = document.createElement("button");
    this.cameraBtn.type = "button";
    this.cameraBtn.id = CAMERA_ID;
    this.cameraBtn.tabIndex = -1;
    this.cameraBtn.title = "Switch between the orbital and first-person camera";
    this.setCameraLabel(this.host.camera.mode);
    this.cameraBtn.addEventListener("click", () => {
      this.cameraBtn.blur();
      // Chrome, in both senses: it feeds the engine nothing, whatever the
      // engine is waiting for. F2 has this property on the keyboard because
      // TextHud's keyCode() cannot name a function key; here it is explicit.
      const next = this.host.camera.toggleMode();
      this.setCameraLabel(next);
      this.host.note(next === "first"
        ? "First-person view. The pad steps where you look; drag to turn."
        : "Orbital view. The pad follows the camera; its centre faces north.");
    });

    this.host.stage.append(this.bar, this.pad, this.cameraBtn);
    this.pump();
    this.poll = setInterval(() => this.pump(), BAR_POLL_MS);
  }

  /** Re-read what the engine is waiting for and redraw the bar if it changed.
   *  The poll's one job, exposed so a test drives the transition rather than
   *  waiting on a wall clock. */
  pump(): void {
    this.render(barMode(this.host.pending()));
  }

  /** Tear the layer down. Nothing in the app does this today — the flag is
   *  read once at boot — but a layer that cannot be removed is a leak waiting
   *  for the first Module that swaps views at runtime. */
  stop(): void {
    clearInterval(this.poll);
    this.pad.remove();
    this.bar.remove();
    this.cameraBtn.remove();
    document.body.classList.remove(TOUCH_BODY_CLASS);
  }

  private setCameraLabel(mode: "orbital" | "first"): void {
    this.cameraBtn.textContent = mode === "first" ? "◱ 1st" : "◰ 3rd";
  }

  private tapPad(action: GazeAction): void {
    const route = routePad(action, this.host.pending());
    if (route === "refuse") return;
    // One gaze resolution for all nine keys, including the centre: the shared
    // arithmetic answers "reset" for the centre and a compass eighth for the
    // eight around it, and neither case knows what game this is.
    const r = resolve(action, this.host.camera.heading);
    if (r?.kind === "reset" || route === "chrome") {
      this.host.camera.resetFacing();
      return;
    }
    if (r?.kind !== "key") return;
    this.host.send([this.host.directionKey(r.direction)], route === "answer");
  }

  private tapBar(item: TouchBarItem): void {
    if (item.kind === "more") {
      // The Module's own menu decides for itself whether it may open; the
      // routing gate here is about keys, and "more" sends none.
      this.host.openMore();
      return;
    }
    if (routeCommand(this.host.pending()) === "refuse") return;
    this.host.send(item.codes!, false);
  }

  /** Redraw the bar only when the mode actually changed — the poll runs eight
   *  times a second and rebuilding buttons under a thumb would cancel taps. */
  private render(mode: BarMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.bar.textContent = "";
    this.bar.classList.toggle("locked", mode === "locked");
    if (mode === "line") {
      this.bar.append(
        this.barButton(LINE_ACCEPT.glyph, LINE_ACCEPT.label, () => this.host.finishLine(true)),
        this.barButton(LINE_CANCEL.glyph, LINE_CANCEL.label, () => this.host.finishLine(false)),
      );
      return;
    }
    for (const item of this.host.bar) {
      this.bar.appendChild(
        this.barButton(item.glyph, item.label, () => this.tapBar(item)));
    }
  }

  private barButton(glyph: string, label: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.tabIndex = -1;
    b.title = label;
    const g = document.createElement("span");
    g.className = "tbglyph";
    g.textContent = glyph;
    const t = document.createElement("span");
    t.className = "tblabel";
    t.textContent = label;
    b.append(g, t);
    b.addEventListener("click", () => { b.blur(); run(); });
    return b;
  }
}
