// The bot's world model, built solely from observed ShimEvents (+ the view's
// reply for create_nhwindow, which carries the window id). Runs the same
// print_glyph -> Classifier -> CellGrid pipeline the view does; adds what the
// renderer doesn't need: an explored mask, status by field name, a message
// ring, and per-window menu buffers.
import type { MenuItemData, ShimEvent } from "../protocol";
import type { ShimReply } from "../session";
import { CellGrid } from "../../../backplane/cell";
import { NETHACK_COLS, NETHACK_ROWS, NetHackClassifier } from "../classifier";

export interface BufferedMenu {
  prompt: string;
  items: MenuItemData[];
  /** The raw build-up events, replayable to the view for display-only menus. */
  events: ShimEvent[];
}

const MAX_MESSAGES = 30;

export class BotModel {
  map = new CellGrid(NETHACK_COLS, NETHACK_ROWS);
  explored = new Uint8Array(NETHACK_COLS * NETHACK_ROWS);
  hp = 0;
  hpmax = 0;
  /** Trimmed hunger text ("Hungry", "Weak", ...); "" when not hungry. */
  hunger = "";
  messages: string[] = [];
  gameOver = false;
  deathText = "";
  menus = new Map<number, BufferedMenu>();
  /** Last observed position of the downstairs on this level, remembered past
   *  an item or monster covering the tile - the live map's '>' can vanish
   *  from view without the stairs having moved. Cleared on level change. */
  stairsDown: { x: number; y: number } | null = null;

  private classifier = new NetHackClassifier();
  private WT: Record<string, number | string> = {};
  private winTypes = new Map<number, number>();
  private fldHp = -1;
  private fldHpMax = -1;
  private fldHunger = -1;

  onReady(constants: Record<string, Record<string, number | string>>) {
    this.classifier.configure(constants["GLYPH"]);
    this.WT = constants["WIN_TYPE"] ?? {};
    // The windowport's status_enablefield is wired to a no-op
    // (genl_status_enablefield in winshim.c) - the shim event never arrives.
    // Field indexes come from the same STATUS_FIELD constants export
    // worker.ts uses for BL_CONDITION.
    const SF = constants["STATUS_FIELD"];
    this.fldHp = Number(SF?.["BL_HP"] ?? -1);
    this.fldHpMax = Number(SF?.["BL_HPMAX"] ?? -1);
    this.fldHunger = Number(SF?.["BL_HUNGER"] ?? -1);
  }

  isMapWin(win: number): boolean {
    return this.winTypes.get(win) === this.WT["NHW_MAP"];
  }

  lastMessage(): string {
    return this.messages[this.messages.length - 1] ?? "";
  }

  observe(ev: ShimEvent, reply?: ShimReply): void {
    switch (ev.name) {
      case "create_nhwindow":
        if (typeof reply === "number") this.winTypes.set(reply, ev.wintype);
        return;
      case "destroy_nhwindow":
        this.winTypes.delete(ev.win);
        this.menus.delete(ev.win);
        return;
      case "print_glyph": {
        this.map.set(ev.x, ev.y, this.classifier.classify(ev.cell));
        this.explored[ev.y * NETHACK_COLS + ev.x] = 1;
        const c = this.map.at(ev.x, ev.y);
        if (c.category === "stairs" && c.ch === ">") this.stairsDown = { x: ev.x, y: ev.y };
        return;
      }
      case "clear_nhwindow":
        if (this.isMapWin(ev.win)) {
          this.map.clear();
          this.explored.fill(0);
          this.stairsDown = null;
        }
        return;
      case "putstr":
        if (this.winTypes.get(ev.win) === this.WT["NHW_MESSAGE"]) this.pushMessage(ev.text);
        return;
      case "raw_print":
        this.pushMessage(ev.text);
        return;
      case "status_update": {
        if (ev.text === null) return;
        if (ev.fldidx === this.fldHp) this.hp = parseInt(ev.text, 10) || 0;
        else if (ev.fldidx === this.fldHpMax) this.hpmax = parseInt(ev.text, 10) || 0;
        else if (ev.fldidx === this.fldHunger) this.hunger = ev.text.trim();
        return;
      }
      case "start_menu":
        this.menus.set(ev.win, { prompt: "", items: [], events: [ev] });
        return;
      case "add_menu": {
        const m = this.menus.get(ev.win);
        if (m) { m.items.push(ev.item); m.events.push(ev); }
        return;
      }
      case "end_menu": {
        const m = this.menus.get(ev.win);
        if (m) { m.prompt = ev.prompt; m.events.push(ev); }
        return;
      }
      case "exit_nhwindows":
        this.gameOver = true;
        this.deathText = ev.text;
        return;
    }
  }

  private pushMessage(text: string) {
    if (!text.trim()) return;
    this.messages.push(text);
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
  }
}
