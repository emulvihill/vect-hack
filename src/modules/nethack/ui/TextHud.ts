// Text chrome shared by every view: messages, status line, menus, overlays and
// all keyboard input. It owns the window bookkeeping too, so a view only has to
// recognise its own map window. Map events are no-ops here — the view handles
// them before delegating.
import type { ShimEvent, MenuItemData } from "../protocol";
import type { ShimReply, NethackHandler } from "../session";
import { BACKSPACE, CR, ESC, SPACE, ctrl, key, meta } from "./keys";
import { COMMAND_GROUPS } from "./commandMenu";
import { KeyQueue } from "../../../backplane/keyQueue";
import { CLR } from "../../../backplane/colors";
import { activeSkin } from "../../../skins";
import type { PendingInput } from "../../../ui/touch/scheme";

const MAX_MESSAGES = 200;
/** How long a non-blocking window stays up before it dismisses itself. */
const TRANSIENT_OVERLAY_MS = 1500;
/** delay_output() is a paced animation beat, not a real wait. */
const DELAY_OUTPUT_MS = 40;

// CLR_* palette for text chrome — the skin's hudClr table, deliberately not
// the 3D palette (different medium; see src/skins/index.ts).
const COLORS = activeSkin().hudClr;

// Per-field printf format for the status line, keyed by BL_* index
// (include/botl.h). NetHack hands these to the port through
// status_enablefield(), but win/shim/winshim.c:251 wires the windowport table
// to genl_status_enablefield — the no-op — so the shim callback never fires and
// the port is left with bare values. Mirrored from initblstats[] (src/botl.c:703)
// until that is fixed upstream; a real enablefield always takes precedence.
// The leading spaces are the field separators, so the pieces concatenate.
const STATUS_FMT: Record<number, string> = {
  0: "%s",        // BL_TITLE
  1: " St:%s", 2: " Dx:%s", 3: " Co:%s", 4: " In:%s", 5: " Wi:%s", 6: " Ch:%s",
  7: " %s",       // BL_ALIGN
  8: " S:%s",     // BL_SCORE
  9: " %s",       // BL_CAP
  10: " %s",      // BL_GOLD (value carries its own "$:")
  11: " Pw:%s", 12: "(%s)", // BL_ENE, BL_ENEMAX
  13: " Xp:%s",   // BL_XP
  14: " AC:%s",   // BL_AC
  15: " HD:%s",   // BL_HD
  16: " T:%s",    // BL_TIME
  17: " %s",      // BL_HUNGER
  18: " HP:%s", 19: "(%s)", // BL_HP, BL_HPMAX
  // BL_LEVELDESC. Upstream's "%s" assumes tty's layout, where the level
  // description opens the second status line; ours is one run, so it needs the
  // separator the other fields carry.
  20: " %s",
  21: "/%s",      // BL_EXP
  22: "%s",       // BL_CONDITION
  23: " %s", 24: " %s", 25: " %s", 26: " %s", // weapon, armor, terrain, version
};

/**
 * Resolve the `\GXXXXNNNN` glyph escapes NetHack embeds in status text
 * (src/windows.c:1466, decode_mixed). BL_GOLD is the only field that produces
 * one (src/botl.c:1070) and it is always the currency symbol, which is what
 * `invis_goldsym` substitutes too — so a literal "$" is the whole decode.
 */
function decodeMixed(text: string): string {
  return text.replace(/\\G[0-9a-fA-F]{8}/g, () => "$");
}

/**
 * Auto-assigned menu accelerators in wintty.c's end_menu order: 'a'..'z', then
 * wrap to 'A' (win/tty/wintty.c:2726). Upstream never runs off the end because
 * it paginates at 52 lines and restarts every page at 'a'; this overlay is one
 * scrolling page, so past 52 the honest answer is no letter at all — that row
 * stays clickable. Counting on past 'z' instead produced '{ | } ~' and then
 * DEL, which no keyboard sends (vect-hack-814).
 */
const AUTO_ACCELS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

interface MenuState {
  items: MenuItemData[]; prompt: string; how: number;
  selected: Set<number>; accels: Map<string, number>;
  /** Confirmed per-item pick count (upstream's tty_menu_item.count);
   *  absent means "all" (-1), same as the core's own default. */
  counts: Map<number, number>;
  /** Digits typed before the next accelerator; null when none are pending.
   *  Cleared after every accelerator press, win/tty/wintty.c's reset_count. */
  typedCount: number | null;
}

const KEYMAP: Record<string, number> = {
  ArrowLeft: key("h"), ArrowDown: key("j"), ArrowUp: key("k"), ArrowRight: key("l"),
  Enter: CR, Escape: ESC, Backspace: BACKSPACE, Delete: BACKSPACE,
  Home: key("y"), End: key("b"), PageUp: key("u"), PageDown: key("n"),
};

/** Every key name KeyboardEvent.getModifierState() answers for — the keys
 *  whose own keydown is half of a chord rather than a keystroke of its own.
 *  A combination is not one of these: Ctrl-D arrives as key "d". */
const MODIFIER_KEYS = new Set([
  "Alt", "AltGraph", "CapsLock", "Control", "Fn", "FnLock", "Hyper", "Meta",
  "NumLock", "OS", "ScrollLock", "Shift", "Super", "Symbol", "SymbolLock",
]);

/**
 * getdir() (external/NetHack/src/cmd.c:3989) is the one `yn_function` call
 * that means "which way" — it always passes NULL choices, which the shim
 * decodes to `""` (sys/libnh/libnhmain.c's `UTF8ToString(0) === ""`). But
 * empty choices alone doesn't single it out: a dozen other prompts pass NULL
 * too (item-letter picks in invent.c/spell.c, "What do you look for?" in
 * detect.c, "adjust?" in quest.c, "What command?" in pager.c, ...), and `def`
 * doesn't help either — several of those also pass '\0'. What every getdir()
 * call site shares, default or custom (dig.c, sounds.c, pickup.c, wizcmds.c),
 * is that the query text contains "direction"; grepping every other
 * empty-choices caller in external/NetHack/src turns up none that do. That's
 * the discriminator — text matching because there is no shape left to match.
 */
function isDirectionPrompt(query: string, choices: string): boolean {
  return choices === "" && /direction/i.test(query);
}

export class TextHud implements NethackHandler {
  private winTypes = new Map<number, number>();
  private nextWin = 1;
  private WT: Record<string, number | string> = {};
  private ATR: Record<string, number | string> = {};

  private textLines = new Map<number, string[]>();
  private menus = new Map<number, MenuState>();
  private statusFields = new Map<number, string>();
  private statusFmt = new Map<number, string>();
  private statusOrder: number[] = [];

  /**
   * A view's chance to reinterpret a command key before the engine sees it —
   * gaze-relative movement in both camera modes uses it
   * (src/modules/nethack/ui/moveKeys.ts).
   * `null` declines and the normal KEYMAP path runs; `"consumed"` swallows the
   * key without feeding the engine, which is how a free action like turning the
   * camera costs no game time.
   *
   * Consulted on the command path, plus one narrow exception: a getdir()
   * prompt (see `directionPrompt`/`isDirectionPrompt`), so an arrow can answer
   * "In what direction?" with the direction the camera is looking. `getlin` is
   * covered by `lineInput` and full menus by `activeMenu`, but `yn_function`
   * and `message_menu` otherwise block on the same key queue as `nhgetch` with
   * nothing else to tell them apart — hence `prompting`. Answering "Really
   * quit?" with a remapped arrow is the bug that gate still exists to prevent.
   */
  remap: ((e: KeyboardEvent) => number | "consumed" | null) | null = null;

  /** Every message line, as sent — VectorView listens for the engine's
   *  step-onto-loot announcements here (pointerActions.itemHereMessage). */
  onMessage: ((text: string) => void) | null = null;

  /**
   * Observer of every key code the engine reads (spec 2026-08-06: the
   * hit-flash inference tracks the last direction sent). Fires from readKey,
   * the queue's sole consumer, so every key typed or clicked into it —
   * keyboard, yn chip, pointer/menu sendKeys alike — is seen exactly once,
   * and a code that never reached the engine can never aim a pulse.
   *
   * `command` is false when the code answers a question rather than driving
   * the command loop (`busyWithPrompt`). A direction key is only a step into
   * the next cell at command level; typed at getdir()'s "In what direction?"
   * it is a ranged or targeted answer, and counting it would aim the pulse
   * at a neighbour the player never touched.
   *
   * Consumption, not entry, is where that flag can be read honestly: the
   * queue buffers, so type-ahead arrives before the prompt it answers exists.
   * Attack east with `l`, then answer the "Really attack the shopkeeper?"
   * confirmation with a `y` typed before that yn_function dispatched, and a
   * flag stamped at push time would call the `y` a command — northwest — and
   * pulse a cell diagonally behind the hero. Here the reader that actually
   * takes the key decides. The engine blocks on the reply, so the direction
   * is still current when the combat message it produces arrives.
   */
  onKeyFed: ((code: number, command: boolean) => void) | null = null;

  /** Depth of prompts blocked on readKey(). Non-zero means the next key belongs
   *  to a question the game asked, not to the command loop. */
  private prompting = 0;

  /** True only while the pending `yn_function` is getdir()'s (see
   *  `isDirectionPrompt`) — the one shape `remap` is still consulted for
   *  while `prompting` is nonzero. */
  private directionPrompt = false;

  private keys = new KeyQueue<number>();
  private overlayDone: ((v: ShimReply) => void) | null = null;
  private activeMenu: MenuState | null = null;
  private lineInput: ((s: string | null) => void) | null = null;
  /** The pointer's own menu (vect-hack-be3.3) — not a NetHack menu, no
   *  ShimEvent behind it, so it is tracked separately from activeMenu. Shares
   *  #overlay with showOverlay/runMenu below; see `overlayOwner` for how the
   *  three arbitrate who's allowed to touch it. */
  private actionMenu: { close: () => void; passthrough: boolean } | null = null;
  /** The most recent pointerdown was spent dismissing the action menu — its
   *  paired click is not an action (see consumeOutsideDismissal). */
  private outsideDismissal = false;
  /**
   * Whoever currently has the floor on #overlay's content — an engine window
   * (showOverlay/runMenu) or the action menu (showActionMenu). Every claim
   * mints a fresh token before writing anything, so a stale owner's own
   * teardown — the action menu's close(), reachable from an outside click
   * queued before it lost the floor, and showOverlay's transient auto-hide
   * timeout, which can fire well after something else has taken over — can
   * tell it no longer owns #overlay and skip blanking it. The two engine
   * paths never need to arbitrate against each other: NetHack only ever has
   * one window blocked on a promise at a time, so showOverlay and runMenu
   * can't contend with each other, only with the action menu's independent,
   * pointer-driven lifetime (vect-hack-be3 review: #overlay had two owners
   * with no arbitration).
   */
  private overlayOwner: object | null = null;

  private $messages = document.getElementById("messages")!;
  private $status = document.getElementById("status")!;
  private $overlay = document.getElementById("overlay")!;
  private $prompt = document.getElementById("prompt")!;
  private $cmdBtn = document.getElementById("cmdbtn")!;

  /** The most recent line appended to #messages, so message() can overwrite
   *  it instead of appending — see message()'s header for when that applies.
   *  `text` is always the base text (never the rendered "(xN)" suffix), so
   *  later equality checks compare against what the engine actually sent. */
  private lastLine: { el: HTMLDivElement; text: string; transient: boolean; count: number } | null = null;

  /** Bound once and held so dispose() can remove exactly what the constructor
   *  added (vect-hack-a8r). Anonymous closures could not be un-added, and all
   *  four of the nodes below — document, #cmdbtn, #prompt, #overlay — belong
   *  to index.html rather than to this HUD: they outlive it, so a second HUD
   *  meant a key delivered twice. */
  private readonly keydown = (e: KeyboardEvent) => this.onKey(e);
  private readonly cmdBtnClick = () => {
    // Blur first: a focused button treats a later Space or Enter as its own
    // activation, and both are keys the game wants.
    this.$cmdBtn.blur();
    this.showCommandMenu();
  };
  private readonly promptClick = (e: MouseEvent) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-yn]");
    if (!chip) return;
    const answer = chip.dataset.yn!;
    this.feedKey(answer === "esc" ? ESC : key(answer));
  };
  private readonly overlayClick = () => {
    if (this.activeMenu || this.actionMenu) return;
    if (this.overlayDone) this.dismissOverlay();
  };
  private disposed = false;

  constructor() {
    document.addEventListener("keydown", this.keydown);
    this.$cmdBtn.addEventListener("click", this.cmdBtnClick);
    // One permanent listener for every yn chip there will ever be: they only
    // exist while ynFunction has a choices-bearing prompt up, and its finally
    // clause blanks #prompt, so there is never a stale chip to click.
    this.$prompt.addEventListener("click", this.promptClick);
    // A blocking text window ("--More--": help, discoveries, the dungeon
    // overview — half the command menu ends in one) waits on "press any key";
    // this is the pointer's way to press it, or the menu button dead-ends at
    // every screen it opens. Permanent and delegated like the chip listener
    // above: menus put their own click handlers on #overlay, so this one
    // stands down whenever either kind of menu owns it — same precedence
    // order as onKey below.
    this.$overlay.addEventListener("click", this.overlayClick);
  }

  /**
   * Undo the constructor (vect-hack-a8r): unbind all four listeners it put on
   * page-owned nodes, close whatever pointer menu is up so its own document
   * listener and timer go with it, and release the engine's parked key wait.
   *
   * removeEventListener on a listener that is not registered is a no-op, so
   * the two menu listeners come off unconditionally: a HUD disposed while a
   * NetHack menu is up would otherwise leave them on #overlay for good.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("keydown", this.keydown);
    this.$cmdBtn.removeEventListener("click", this.cmdBtnClick);
    this.$prompt.removeEventListener("click", this.promptClick);
    this.$overlay.removeEventListener("click", this.overlayClick);
    this.$overlay.removeEventListener("click", this.onMenuClick);
    this.$overlay.removeEventListener("keydown", this.stopQtyKeys);
    this.actionMenu?.close();
    // The listeners above were the only things that could ever push, so a
    // readKey parked on the queue would never settle — and EngineSession's
    // dispatch is awaiting it, which holds this whole HUD reachable.
    this.keys.cancel();
  }

  onReady(constants: Record<string, Record<string, number | string>>) {
    this.WT = constants["WIN_TYPE"] ?? {};
    this.ATR = constants["ATTR"] ?? {};
  }

  /** True for the window NetHack draws the dungeon into. */
  isMap(win: number): boolean {
    return this.winTypes.get(win) === this.WT["NHW_MAP"];
  }

  /** True for the message window; the hit-flash inference reads only it —
   *  the same combat line quoted in a text dump is not a hit happening now. */
  isMessage(win: number): boolean {
    return this.winTypes.get(win) === this.WT["NHW_MESSAGE"];
  }

  // ---- event dispatch -----------------------------------------------------

  handle(ev: ShimEvent): ShimReply | Promise<ShimReply> {
    switch (ev.name) {
      case "create_nhwindow": {
        const id = this.nextWin++;
        this.winTypes.set(id, ev.wintype);
        return id;
      }
      case "destroy_nhwindow":
        this.winTypes.delete(ev.win); this.textLines.delete(ev.win); this.menus.delete(ev.win);
        return;
      case "clear_nhwindow":
        if (this.isMap(ev.win)) return;
        this.textLines.set(ev.win, []);
        // A stale lastLine would otherwise drive the collapse decision for
        // whatever message comes next, so clearing the message window resets
        // it alongside textLines — only the message window: a menu or text
        // window being cleared says nothing about the message stream, and
        // must not break a "(xN)" collapse in progress. NetHack clears
        // WIN_MESSAGE before every "Count: N" putstr once cnt > 9
        // (src/cmd.c:5106) — if the line being cleared was a transient echo,
        // tty leaves no trace of it either, so it has to come out of the DOM
        // here too, or each digit leaves its own line. A real message's line
        // is left in place; clearing only drops the collapse state so the
        // next real message starts its own line.
        if (this.isMessage(ev.win)) {
          if (this.lastLine?.transient) this.lastLine.el.remove();
          this.lastLine = null;
        }
        return;
      case "putstr": {
        if (this.isMessage(ev.win)) this.message(ev.text, ev.attr);
        else {
          const lines = this.textLines.get(ev.win) ?? [];
          lines.push(ev.text);
          this.textLines.set(ev.win, lines);
        }
        return;
      }
      case "display_nhwindow": {
        if (this.isMap(ev.win)) return;
        const lines = this.textLines.get(ev.win);
        if (lines?.length)
          return this.showOverlay(lines.map((t) => `<div>${escapeHtml(t)}</div>`).join(""), ev.blocking);
        return;
      }
      case "start_menu":
        this.menus.set(ev.win, {
          items: [], prompt: "", how: 0, selected: new Set(), accels: new Map(),
          counts: new Map(), typedCount: null,
        });
        return;
      case "add_menu":
        this.menus.get(ev.win)?.items.push(ev.item);
        return;
      case "end_menu": {
        const m = this.menus.get(ev.win);
        if (m) m.prompt = ev.prompt;
        return;
      }
      case "select_menu":
        return this.runMenu(ev.win, ev.how);
      case "raw_print":
        this.message(ev.text);
        return;
      case "nhgetch": case "nh_poskey":
        return this.readKey();
      case "yn_function":
        return this.ynFunction(ev.query, ev.choices, ev.def);
      case "message_menu":
        return this.messageMenu(ev.how, ev.text);
      case "getlin":
        return this.getLine(ev.query);
      case "askname":
        return this.getLine("Who are you?").then((s) => s || "player");
      case "get_ext_cmd":
        return this.extCmd(ev.commands);
      case "getmsghistory":
        return "";
      case "status_enablefield":
        if (ev.enable && !this.statusOrder.includes(ev.fieldidx)) this.statusOrder.push(ev.fieldidx);
        if (ev.enable && ev.fmt) this.statusFmt.set(ev.fieldidx, ev.fmt);
        if (!ev.enable) { this.statusFields.delete(ev.fieldidx); this.statusFmt.delete(ev.fieldidx); }
        return;
      case "status_update":
        if (ev.text !== null) this.statusFields.set(ev.fldidx, ev.text);
        this.renderStatus();
        return;
      case "delay_output":
        return new Promise((r) => setTimeout(() => r(undefined), DELAY_OUTPUT_MS));
      case "exit_nhwindows":
        this.message(ev.text || "[Game over — engine exited.]");
        return;
      default:
        return;
    }
  }

  /**
   * ATR_NOHISTORY (doc/window.txt: "avoid putting message into recall
   * history") marks a transient echo — farlook's autodescribe as the cursor
   * crosses each cell (src/getpos.c:652), the "Count: N" prefix as digits
   * accumulate (src/cmd.c:5106) — that tty shows on its one message line
   * without ever scrolling it into history. We have no separate line/history
   * split, so the nearest equivalent is to keep overwriting the last line
   * while the transient streak lasts: none of those intermediate lines was
   * ever a real event, so there's nothing lost by dropping them.
   *
   * A verbatim repeat of a *real* message (two combat rounds both landing
   * "You hit it!") is not disposable the same way — each one is a distinct
   * event, so collapsing it onto one line the way a transient streak does
   * would silently lose one. Collapse it anyway (still not one history line
   * per repetition) but keep a "(xN)" count, incrementing in place, so the
   * line stays honest about how many times it happened.
   */
  message(text: string, attr = 0) {
    if (!text.trim()) return;
    const transient = (attr & Number(this.ATR["ATR_NOHISTORY"] ?? 0)) !== 0;
    const last = this.lastLine;
    let div: HTMLDivElement;
    let count = 1;
    if (last?.transient) {
      div = last.el;
      div.textContent = text;
    } else if (last && text === last.text) {
      count = last.count + 1;
      div = last.el;
      div.textContent = `${text} (x${count})`;
    } else {
      div = document.createElement("div");
      div.textContent = text;
      this.$messages.appendChild(div);
      while (this.$messages.childElementCount > MAX_MESSAGES) this.$messages.firstChild!.remove();
    }
    this.lastLine = { el: div, text, transient, count };
    this.$messages.scrollTop = this.$messages.scrollHeight;
    this.onMessage?.(text);
  }

  private renderStatus() {
    const order = this.statusOrder.length
      ? this.statusOrder
      : [...this.statusFields.keys()].sort((a, b) => a - b);
    this.$status.textContent = order
      .map((f): string => {
        const text = decodeMixed(this.statusFields.get(f) ?? "");
        if (text.trim() === "") return "";
        const fmt = this.statusFmt.get(f) ?? STATUS_FMT[f] ?? " %s";
        return fmt.replace("%s", text);
      })
      .join("");
  }

  // ---- input --------------------------------------------------------------

  private async readKey(): Promise<number> {
    // wait=true never resolves null, but the waiter's type admits it and a
    // `!` would erase at compile time — a null reaching here would flow on as
    // the engine's reply value, and a null in a scalar C return slot kills it
    // (fallbackValue's header, ../../core/session.ts). Throw instead: that
    // lands in EngineSession's catch, which answers ESC for a key wait.
    const k = await this.keys.next(true);
    // Since dispose(), null on a blocking read is expected rather than a
    // contract violation: the queue was cancelled because this HUD's
    // listeners are gone (vect-hack-a8r). Answer ESC — the same cancel shape
    // nethackFallback posts for a key wait — rather than raising a display
    // error at a player whose session is already being torn down.
    if (k === null && this.disposed) return ESC;
    if (k === null) throw new Error("readKey: KeyQueue resolved null on a blocking read");
    this.onKeyFed?.(k, !this.busyWithPrompt);
    return k;
  }

  private feedKey(code: number) {
    this.keys.push(code);
  }

  /**
   * True while a real NetHack prompt, menu or line-input is up — checked by
   * both pointer entry points (sendKeys, showActionMenu) so the two can't
   * drift apart on what counts as "busy". A click aimed at the map is not an
   * answer to a question the player never saw, the same worry `prompting`
   * exists for on the keyboard side (see remap's doc comment above) — a
   * queued direction key could otherwise land on a pending yn_function as a
   * stray "y", or a pointer menu could stomp on a real one already showing.
   */
  private get busyWithPrompt(): boolean {
    return this.prompting > 0 || this.activeMenu !== null
      || this.overlayDone !== null || this.lineInput !== null;
  }

  /**
   * Feed a resolved action's key(s) to the engine as if they were typed — the
   * pointer layer's one entry point into the key queue
   * (src/modules/nethack/ui/pointerActions.ts, moveKeys.ts's resolveTarget),
   * and the touch layer's too (src/ui/touch/).
   *
   * `answersDirection` reopens the busy gate for exactly one shape, and for
   * the same reason `remap` is reopened for it (see remap's doc comment): a
   * getdir() prompt is asking which way, and a compass direction is the only
   * thing that can answer it. Without this a thumb pad could walk but could
   * never answer "In what direction?", which is where open, close, kick and
   * untrap all end — the verbs the pointer command menu declined to carry for
   * want of an answer. Safe for the reason resolveTarget's own header gives:
   * what travels is a plain ASCII direction letter, never a Meta fold, so the
   * shim's 'c' return converter is never handed anything over 128.
   *
   * Every other prompt shape still refuses, a direction key included. A `y`
   * or an `s` arriving at "In what direction?" is not an answer, it is a step.
   */
  sendKeys(codes: number[], answersDirection = false): void {
    if (this.busyWithPrompt && !(answersDirection && this.directionPrompt)) return;
    for (const code of codes) this.feedKey(code);
  }

  /**
   * Which shape of question, if any, the engine is currently blocked on —
   * the one thing a touch build has to know to route a tap (vect-hack-21k,
   * src/ui/touch/scheme.ts). Derived from the same four fields
   * `busyWithPrompt` reads, so the two can never disagree about "busy"; what
   * it adds is which KIND of busy, because a yn chip, a menu row, a direction
   * and a line input are four different answers and only one of them is a key
   * this HUD would take.
   *
   * Ordered most specific first: a direction prompt is a `prompting` too, and
   * a line input can be up while nothing else is.
   */
  get pendingInput(): PendingInput {
    if (this.lineInput) return "line";
    if (this.activeMenu || this.overlayDone) return "menu";
    if (this.directionPrompt) return "direction";
    if (this.prompting > 0) return "yesno";
    return "none";
  }

  /**
   * Finish a getlin() with no keystroke. A phone's soft keyboard has its own
   * Return, but nothing guarantees the page sees it — and a getlin reached
   * from a menu row (naming a character, an extended command) would otherwise
   * be a prompt a touch player cannot leave in either direction.
   * `accept` false is the Escape path, which getLine already means as null.
   */
  finishLineInput(accept: boolean): void {
    if (!this.lineInput) return;
    const input = document.getElementById("linein") as HTMLInputElement | null;
    this.finishLine(accept ? input?.value ?? "" : null);
  }

  /**
   * True exactly once when the most recent pointerdown was spent dismissing
   * the action menu. The click handler that would otherwise act on that
   * gesture's paired click (VectorView's primaryAction) asks-and-clears here;
   * an unconsumed flag is cleared by the next pointerdown, so a dismissal can
   * never swallow a later, deliberate click.
   */
  consumeOutsideDismissal(): boolean {
    const spent = this.outsideDismissal;
    this.outsideDismissal = false;
    return spent;
  }

  private onKey(e: KeyboardEvent) {
    if (this.lineInput) return; // input element handles it
    e.preventDefault();
    // A bare modifier keydown (the Shift that starts a "Z") is not the
    // keystroke it is paired with: spending an overlay's "press any key", a
    // PICK_NONE menu's dismissal or the stand-on menu's one free keystroke on
    // it would clear what the player was reading and then deliver the real
    // key — still to come — to the command loop as a live command
    // (vect-hack-ca5). Leave all three up; the next, real keydown works them
    // as usual.
    if (MODIFIER_KEYS.has(e.key)) return;
    if (this.actionMenu) {
      // A menu the player opened is modal; the auto-opened stand-on menu
      // (passthrough) must never cost a keystroke — any key closes it and
      // then acts normally. Escape only dismisses either way: leaking it to
      // the game would cancel a count or answer a prompt the next event puts
      // up, which the player never asked it to.
      if (!this.actionMenu.passthrough) {
        if (e.key === "Escape") this.actionMenu.close();
        return;
      }
      this.actionMenu.close();
      if (e.key === "Escape") return;
    }
    if (this.activeMenu) return this.menuKey(e);
    if (this.overlayDone) return this.dismissOverlay();
    // remap's return bypasses keyCode()'s ASCII guard below — a remapped code
    // goes straight to feedKey(), never through the <= 127 check. Safe on the
    // command path because the shim's compiled 'c' return converter is reached
    // solely by yn_function and message_menu, which `prompting` gates remap
    // off from. directionPrompt reopens that gate for exactly one of the two —
    // getdir()'s yn_function — and stays safe there for a different reason:
    // every Action the editable binding table (vect-hack-be3.5) can name for a
    // key is validated against ACTIONS, and resolve() only ever answers one of
    // those with a plain ASCII direction letter, a "turn", or a "reset" — all
    // feeding nothing — never anything resolve() couldn't also produce for ordinary movement.
    const mapped = (this.prompting === 0 || this.directionPrompt)
      ? this.remap?.(e) ?? null : null;
    if (mapped === "consumed") return;
    const code = mapped ?? this.keyCode(e);
    if (code !== null) this.feedKey(code);
  }

  private keyCode(e: KeyboardEvent): number | null {
    // Own-property only: "toString" is a KeyboardEvent.key nobody presses, but a
    // prototype hit would queue Object.prototype's method where a code belongs.
    if (Object.hasOwn(KEYMAP, e.key)) return KEYMAP[e.key]!;
    if (e.key.length !== 1) return null;
    if (e.ctrlKey) return ctrl(e.key); // masked to 0-31 regardless of e.key, already safe
    // Cmd rides OS/browser shortcuts the page can't reliably intercept, and
    // the bare letter would be a *different* command — drop, never mistranslate.
    if (e.metaKey) return null;
    if (e.altKey) {
      // NetHack's classic Meta fold, M(c) = 0x80 | c — Alt+c is chat, Alt+p
      // pray. Command path only: while `prompting` is up the raw code goes
      // straight back through the compiled 'c' return converter (the same
      // >128 ceiling documented below), and the bare letter would answer a
      // question the player didn't ask it to — so a prompt drops it instead.
      return this.prompting === 0 && e.key.charCodeAt(0) <= 127 ? meta(e.key) : null;
    }
    // yn_function's no-choices path and message_menu hand this code straight
    // back to the bridge, whose compiled 'c' return converter throws for
    // anything over 128 (win/shim/winshim.c's setPointerValue) and wedges
    // Asyncify. Drop an accented or IME character here rather than let it
    // reach that boundary.
    return e.key.charCodeAt(0) <= 127 ? key(e.key) : null;
  }

  private async ynFunction(query: string, choices: string, def: number): Promise<number> {
    // Some prompts carry their answers inside the query and pass no choices
    // at all (embeddedChoices below). Then the query already reads
    // "... [ynaq]" and appending "[any]" to it would be nonsense.
    const inline = choices || isDirectionPrompt(query, choices) ? "" : embeddedChoices(query);
    this.$prompt.innerHTML =
      escapeHtml(choices ? `${query} [${choices}]` : inline ? query : `${query} [any]`)
      + ynChips(choices || inline);
    this.$prompt.hidden = false;
    this.prompting++;
    if (isDirectionPrompt(query, choices)) this.directionPrompt = true;
    try {
      for (;;) {
        const k = await this.readKey();
        if (!choices) return k;
        if (choices.includes(String.fromCharCode(k))) return k;
        if (k === ESC) return choices.includes("q") ? key("q") : choices.includes("n") ? key("n") : def;
        if ((k === CR || k === SPACE) && def) return def;
      }
    } finally {
      this.prompting--;
      this.directionPrompt = false;
      this.$prompt.hidden = true;
      // Blank it rather than just hiding it: a hidden chip is unclickable,
      // but leaving the answers to a question already settled sitting in the
      // DOM is the kind of thing the next reader has to re-derive.
      this.$prompt.textContent = "";
    }
  }

  /**
   * The core's one-item menu: `text` is the item, and the prompt it belongs to
   * is still waiting for an answer (doc/window.txt). PICK_NONE is a plain
   * message; otherwise the key goes back as the answer — the core checks it
   * against the inventory, so a letter picks the item and anything else just
   * re-asks. 0 means "dismissed, nothing selected".
   */
  private async messageMenu(how: number, text: string): Promise<number> {
    this.message(text);
    if (how === 0) return 0; // PICK_NONE
    this.$prompt.textContent = `${text} [letter to pick, ESC to cancel]`;
    this.$prompt.hidden = false;
    this.prompting++;
    try {
      const k = await this.readKey();
      return k === CR || k === SPACE ? 0 : k;
    } finally {
      this.prompting--;
      this.$prompt.hidden = true;
    }
  }

  private getLine(query: string): Promise<string | null> {
    this.$prompt.innerHTML = `${escapeHtml(query)} <input id="linein" spellcheck="false">`;
    this.$prompt.hidden = false;
    const input = document.getElementById("linein") as HTMLInputElement;
    input.focus();
    return new Promise((resolve) => {
      this.lineInput = resolve;
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") this.finishLine(input.value);
        else if (e.key === "Escape") this.finishLine(null);
      };
    });
  }

  /** Reply is an index into extcmdlist; -1 cancels. Accepts unique prefixes. */
  private async extCmd(commands: { name: string; desc: string }[]): Promise<number> {
    const line = await this.getLine("# (extended command)");
    if (line === null || line === "") return -1;
    const exact = commands.findIndex((c) => c.name === line);
    if (exact !== -1) return exact;
    const prefixed = commands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.name.startsWith(line));
    if (prefixed.length === 1) return prefixed[0]!.i;
    this.message(prefixed.length === 0
      ? `Unknown extended command: ${line}`
      : `Ambiguous: ${prefixed.map(({ c }) => c.name).slice(0, 8).join(", ")}`);
    return -1;
  }

  private finishLine(v: string | null) {
    const r = this.lineInput!;
    this.lineInput = null;
    this.$prompt.hidden = true;
    this.$prompt.textContent = "";
    r(v);
  }

  // ---- menus / overlays ---------------------------------------------------

  private showOverlay(html: string, blocking: boolean): Promise<ShimReply> | undefined {
    // Claim #overlay before closing out the action menu, not after — so its
    // close() sees a token that's already moved on and skips blanking what
    // we're about to write (overlayOwner's header).
    const owner = (this.overlayOwner = {});
    this.actionMenu?.close();
    this.$overlay.innerHTML = blocking
      ? html + `<div class="mhint">[click, or press any key, to continue]</div>`
      : html;
    this.$overlay.hidden = false;
    if (!blocking) {
      setTimeout(() => { if (this.overlayOwner === owner) this.hideOverlay(); }, TRANSIENT_OVERLAY_MS);
      return;
    }
    return new Promise((r) => (this.overlayDone = r));
  }

  /** Resolve a blocking overlay's wait — the keyboard's "any key" and the
   *  constructor's #overlay click land here alike. */
  private dismissOverlay(): void {
    const r = this.overlayDone!;
    this.overlayDone = null;
    this.hideOverlay();
    r(undefined);
  }

  private hideOverlay() {
    this.overlayOwner = null;
    this.$overlay.hidden = true;
    this.$overlay.innerHTML = "";
  }

  /**
   * The pointer's full-menu tier (vect-hack-be3.3, right click): a plain row
   * per applicable action, reusing the overlay chrome so it reads like every
   * other menu even though nothing here is a ShimEvent. Declines while a real
   * NetHack overlay/menu/prompt is up rather than stomping on it. Closes on
   * Escape, on picking a row, or on a click outside it.
   *
   * Rows carry `data-pi`, not renderMenu()'s `data-i` — a real menu's rows
   * use that same delegated-click shape on the same element, and giving each
   * owner its own attribute means the two listeners can never both match one
   * click, even in the moment one is torn down and the other stood up.
   *
   * close() always tears its own listeners down, but only blanks #overlay if
   * `overlayOwner` still names this menu's own claim — an engine window that
   * has since taken over (showOverlay/runMenu, which close this out
   * themselves when they claim #overlay) is never blanked by a stale close()
   * an outside click or Escape fires later.
   */
  showActionMenu(rows: { label: string; run: () => void }[],
                 opts?: { passthrough?: boolean }): void {
    if (rows.length === 0) return;
    if (this.busyWithPrompt) return;
    // An unasked-for (auto-opened) menu never replaces one already up — the
    // player's own menu, or an earlier auto-open they haven't dealt with —
    // nor a live transient overlay (showOverlay's non-blocking window,
    // display_nhwindow with blocking=false): busyWithPrompt doesn't cover
    // that case, since nothing is blocked on a promise while it's up, but an
    // auto-open would still cut it off before its own timer, or the player,
    // ever got to it. A player-opened menu is deliberately exempt: it still
    // claims #overlay from a transient window below (actionMenu?.close() is
    // the same claim showOverlay/runMenu make), because that replacement was
    // asked for — this guard exists only to stop the menu nobody asked for.
    if (opts?.passthrough && (this.actionMenu || this.overlayOwner !== null)) return;
    const owner = (this.overlayOwner = {});
    this.actionMenu?.close();
    this.$overlay.innerHTML = rows
      .map((r, i) => `<div class="pmrow" data-pi="${i}">${escapeHtml(r.label)}</div>`)
      .join("") + `<div class="mhint">[click an action, or click elsewhere to cancel]</div>`;
    this.$overlay.hidden = false;
    const onRowClick = (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-pi]");
      // Close before running the row, not after. A row whose run() opens
      // another menu — every category row in showCommandMenu below — would
      // otherwise have its brand-new `actionMenu` nulled out by this
      // closure's own teardown running second, leaving rows on screen that
      // Escape no longer closes and an engine window no longer tears down.
      close();
      if (row) rows[Number(row.dataset.pi)]!.run();
    };
    const onOutside = (e: MouseEvent) => {
      if (this.$overlay.contains(e.target as Node)) return;
      // The browser still delivers this pointerdown's paired click, and the
      // canvas would run primaryAction on whatever cell it lands on — the
      // "click elsewhere to cancel" gesture must not attack a monster. Mark
      // the gesture spent; the flag is cleared by whoever consumes it, or by
      // the next pointerdown (a once listener added during dispatch never
      // fires for the event being dispatched, so this really means "next").
      this.outsideDismissal = true;
      document.addEventListener("pointerdown",
        () => { this.outsideDismissal = false; }, { capture: true, once: true });
      close();
    };
    const close = () => {
      // The timer clears too: a close() that lands before the deferred
      // registration below has run (an engine window claiming #overlay in the
      // same task) would otherwise leave onOutside to be added afterward with
      // nothing left to ever remove it. And actionMenu resets only if it
      // still names this menu — close() can run late (the queued outside
      // click the header describes), after a successor menu has taken the
      // slot, and must not null that menu's state out from under its own
      // Escape handling.
      clearTimeout(outsideTimer);
      this.$overlay.removeEventListener("click", onRowClick);
      document.removeEventListener("pointerdown", onOutside, true);
      if (this.actionMenu === handle) this.actionMenu = null;
      if (this.overlayOwner === owner) this.hideOverlay();
    };
    const handle = { close, passthrough: opts?.passthrough ?? false };
    this.$overlay.addEventListener("click", onRowClick);
    // Deferred: registering this synchronously, inside the same contextmenu
    // dispatch that opened the menu, risks the platform's own trailing
    // pointer activity for that gesture closing it before the player sees it.
    const outsideTimer = setTimeout(
      () => document.addEventListener("pointerdown", onOutside, true), 0);
    this.actionMenu = handle;
  }

  /**
   * The command menu (vect-hack-be3.7): every everyday NetHack command that
   * needs no target, two levels deep, opened from the always-visible button
   * and reachable with the pointer alone. The verbs that DO need a target are
   * not here — they live on the map, in the right-click menu that
   * pointerActions.ts builds.
   *
   * Built out of showActionMenu rather than a menu mechanism of its own: a
   * category row's run() simply reopens the menu with that group's rows, so a
   * "submenu" costs one more call and inherits, for free, the #overlay
   * ownership arbitration, the Escape handling and the busy-prompt gate the
   * action menu already has. The Back row is the same trick pointed the other
   * way.
   */
  showCommandMenu(): void {
    this.showActionMenu(COMMAND_GROUPS.map((group) => ({
      label: `${group.label}...`,
      run: () => this.showActionMenu([
        ...group.commands.map((c) => ({ label: c.label, run: () => this.sendKeys([c.code]) })),
        { label: "‹ Back", run: () => this.showCommandMenu() },
      ]),
    })));
  }

  private runMenu(win: number, how: number): Promise<ShimReply> {
    const m = this.menus.get(win);
    if (!m || m.items.length === 0) return Promise.resolve(null);
    // Claim #overlay before closing out the action menu — same reasoning as
    // showOverlay above, so its close() doesn't blank what renderMenu() is
    // about to draw.
    this.overlayOwner = {};
    this.actionMenu?.close();
    m.how = how;
    m.selected.clear();
    m.accels.clear();
    m.counts.clear();
    m.typedCount = null;
    let auto = 0; // AUTO_ACCELS index; advances only when one is handed out
    m.items.forEach((it, i) => {
      if (it.identifier !== 0) {
        const acc = it.accelerator || AUTO_ACCELS[auto++] || "";
        (it as { accelerator: string }).accelerator = acc;
        if (acc) m.accels.set(acc, i);
      }
    });
    this.activeMenu = m;
    this.$overlay.addEventListener("click", this.onMenuClick);
    this.$overlay.addEventListener("keydown", this.stopQtyKeys);
    this.renderMenu();
    return new Promise((r) => (this.overlayDone = r));
  }

  private renderMenu() {
    const m = this.activeMenu!;
    const rows = m.items.map((it, i) => {
      if (it.identifier === 0)
        return `<div class="mhead">${escapeHtml(it.text)}</div>`;
      const col = COLORS[it.color] ?? COLORS[CLR.GRAY];
      const label = `<span class="macc">${escapeHtml(it.accelerator)}</span> <span style="color:${col}">${escapeHtml(it.text)}</span>`;
      if (m.how === 0) return `<div>${label}</div>`;
      const mark = m.selected.has(i) ? "+" : "-";
      // Empty means "all" (count -1); a typed value overrides it. Read fresh
      // off the DOM on click rather than kept live in sync, so digit-prefix
      // keying and this control never fight over the same buffer. PICK_ONE
      // takes exactly one item and ends the menu on the first pick, so a
      // per-item count is meaningless there — the field is PICK_ANY only.
      const qty = m.counts.get(i);
      const qtyInput = m.how === 2
        ? `<input type="number" class="mqty" min="0" placeholder="all" value="${qty ?? ""}">`
        : "";
      return `<div class="pmrow" data-i="${i}"><span class="macc">${escapeHtml(it.accelerator)}</span> ${m.how === 2 ? mark + " " : ""}<span style="color:${col}">${escapeHtml(it.text)}</span>${qtyInput}</div>`;
    });
    const hint = m.how === 0
      ? `<div class="pmrow mhint" data-act="dismiss">[click, or press any key, to dismiss]</div>`
      : m.how === 1
      ? `<div class="mhint">[click or press a letter to pick, <span class="pmrow" data-act="cancel">ESC to cancel</span>]</div>`
      : `<div class="mhint">[click or press letters to toggle, <span class="pmrow" data-act="done">Enter confirms</span>, <span class="pmrow" data-act="cancel">ESC cancels</span>]</div>`;
    this.$overlay.innerHTML =
      (m.prompt ? `<div class="mhead">${escapeHtml(m.prompt)}</div>` : "") +
      rows.join("") + hint;
    this.$overlay.hidden = false;
  }

  private menuKey(e: KeyboardEvent) {
    const m = this.activeMenu!;
    if (e.key === "Escape") {
      // wintty.c's case '\033': mid-count, Escape only stops the count: the
      // menu stays open and typing a fresh accelerator still works. Only a
      // bare Escape (nothing pending) cancels the whole menu.
      if (m.typedCount !== null) { m.typedCount = null; return; }
      return this.finishMenu(null);
    }
    if (m.how === 0) return this.finishMenu({ picks: [] }); // PICK_NONE: any key
    if (e.key === "Enter") return this.finishMenu({ picks: this.collectPicks(m) });
    if (/^[0-9]$/.test(e.key)) {
      const next = (m.typedCount ?? 0) * 10 + Number(e.key);
      if (next !== 0) m.typedCount = next; // ignore leading zeros, same as wintty.c
      return;
    }
    const idx = m.accels.get(e.key);
    if (idx === undefined) return;
    const count = m.typedCount;
    m.typedCount = null;
    this.selectItem(idx, count);
  }

  /**
   * Where a click on the overlay lands while a real menu is up: event
   * delegation on $overlay (same mechanism as showActionMenu) plus a data-i
   * per row, rather than a per-row listener. A click on the quantity input is
   * left alone so the native number field and its spinner still work; the
   * row's own count is read straight off that input rather than mirrored
   * into state, so there's exactly one place a value can be "current".
   */
  private onMenuClick = (e: MouseEvent) => {
    const m = this.activeMenu;
    if (!m) return;
    const t = e.target as HTMLElement;
    if (t.closest("input")) return;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "cancel") return this.finishMenu(null);
    if (act === "done") return this.finishMenu({ picks: this.collectPicks(m) });
    if (act === "dismiss") return this.finishMenu({ picks: [] });
    const row = t.closest<HTMLElement>("[data-i]");
    if (!row) return;
    const idx = Number(row.dataset.i);
    const raw = row.querySelector<HTMLInputElement>("input.mqty")?.value;
    const n = raw ? Number(raw) : NaN;
    // A count is a quantity of items, never a fraction of one.
    this.selectItem(idx, Number.isInteger(n) && n >= 0 ? n : null);
  };

  /** Let the quantity control's own keys (digits, the native spinner) reach
   *  the input instead of onKey's global command routing — same reason
   *  getLine's #linein stops propagation on its keydowns. */
  private stopQtyKeys = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") e.stopPropagation();
  };

  /**
   * The one selection-update path accelerator letters and pointer rows both
   * funnel through — classic digit-prefix-then-letter on the keyboard,
   * letter or row click plus this row's quantity field on the pointer.
   * Mirrors upstream's toggle_menu_curr (win/tty/wintty.c): an explicit
   * count > 0 always applies, even to an already-selected item, without
   * deselecting it; no count toggles plain selection. An explicit 0 — only
   * the pointer's quantity field can produce one; the keyboard path drops
   * leading zeros like wintty does — means "none of it": it deselects a
   * selected item and leaves an unselected one alone.
   */
  private selectItem(idx: number, count: number | null) {
    const m = this.activeMenu!;
    const it = m.items[idx];
    if (!it || it.identifier === 0) return; // heading, or a stray index
    if (m.selected.has(idx)) {
      if (count !== null && count > 0) m.counts.set(idx, count);
      else { m.selected.delete(idx); m.counts.delete(idx); }
    } else if (count !== null && count > 0) {
      m.selected.add(idx);
      m.counts.set(idx, count);
    } else if (count === null) {
      m.selected.add(idx);
    }
    if (m.how === 1) return this.finishMenu({ picks: this.collectPicks(m) });
    this.renderMenu();
  }

  private collectPicks(m: MenuState) {
    return [...m.selected].map((i) => ({
      identifier: m.items[i]!.identifier, count: m.counts.get(i) ?? -1, itemflags: 0,
    }));
  }

  private finishMenu(v: ShimReply) {
    this.$overlay.removeEventListener("click", this.onMenuClick);
    this.$overlay.removeEventListener("keydown", this.stopQtyKeys);
    this.activeMenu = null;
    const r = this.overlayDone!;
    this.overlayDone = null;
    this.hideOverlay();
    r(v);
  }
}

export const HUD_COLORS = COLORS;

/**
 * Clickable answers for a yn_function's fixed choice set (vect-hack-be3.7).
 * Without them the command menu dead-ends: half its rows end in "Really save?
 * [yn]" and the pointer has no way to say yes, which is the whole point of
 * the menu. The trailing "esc" chip feeds a real ESC rather than guessing an
 * answer, so ynFunction's own escape rule (q if offered, else n, else the
 * default) stays the single place that decision is made.
 *
 * A prompt with no choices gets no chips. That set includes getdir(), whose
 * answer is a direction the camera supplies (vect-hack-be3.6) — a fixed row
 * of eight letters would be exactly the wrong shape for it.
 */
function ynChips(choices: string): string {
  const answers = [...choices].filter((c) => c >= "!" && c <= "~");
  if (answers.length === 0) return "";
  return answers
    .map((c) => `<span class="ynchip" data-yn="${escapeHtml(c)}">${escapeHtml(c)}</span>`)
    .join("") + `<span class="ynchip" data-yn="esc">esc</span>`;
}

/**
 * The answers a prompt spells inside its own query text rather than in
 * `choices` — found by the touch spike (vect-hack-21k), where it is the first
 * question of every game and, without this, an unanswerable one.
 *
 * It is not a shim bug. external/NetHack/src/role.c:2256 passes `(char *) 0`
 * for choices on "Shall I pick ... for you? [ynaq]" on purpose — the comment
 * there says "accept any character and do validation ourselves so that we can
 * shorten prompt" — and then loops until it gets a y, n or a. So the letters
 * really are the answers; they are just carried in the sentence.
 *
 * Deliberately narrow, because guessing wrong offers a player a button that
 * means something else: a short run of alphanumerics in brackets, at the very
 * end of the query, and only when `choices` is empty. A getdir() prompt is
 * excluded by its caller, not here — its query has no brackets today, and an
 * eight-letter row would be exactly the wrong shape for it if it ever did
 * (ynChips's own header).
 */
export function embeddedChoices(query: string): string {
  return /\[([A-Za-z0-9]{1,8})\]\s*$/.exec(query)?.[1] ?? "";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
