// A self-playing NethackHandler decorator: display events flow through to
// the wrapped view (and feed the bot's world model), input events are answered
// by the policy. Wire it in main.ts with ?bot; nothing else references it.
//
// Menu windows are buffered rather than forwarded: a menu the bot answers
// (select_menu) is never shown, one the engine only displays is replayed to
// the view first. Blocking displays are forwarded non-blocking - the view's
// blocking path waits for a keypress that will never come.
import type { ShimEvent } from "../protocol";
import type { ShimReply, NethackHandler } from "../session";
import { BotModel } from "./model";
import { BotBrain, k } from "./policy";
import { answerMenu, answerYn, extCmdIndex } from "./prompts";

const INPUT_EVENTS = new Set([
  "nhgetch", "nh_poskey", "yn_function", "getlin", "get_ext_cmd",
  "select_menu", "message_menu", "askname",
]);
const MENU_BUILD = new Set(["start_menu", "add_menu", "end_menu"]);

export class BotPlayer implements NethackHandler {
  private model = new BotModel();
  private brain = new BotBrain();
  private keys: number[] = [];
  private pendingExt = "";
  private announcedDeath = false;

  constructor(private view: NethackHandler, private delayMs = 150) {}

  onReady(constants: Record<string, Record<string, number | string>>) {
    this.model.onReady(constants);
    this.view.onReady?.(constants);
  }

  onNotice(text: string) {
    this.view.onNotice?.(text);
  }

  /** Forwarded like onReady/onNotice: a decorator that swallows teardown
   *  leaves the wrapped view's listeners installed (vect-hack-a8r). */
  dispose(): void { this.view.dispose?.(); }

  async handle(ev: ShimEvent): Promise<ShimReply> {
    // Menu build-up: buffer in the model, never forward.
    if (MENU_BUILD.has(ev.name)) {
      this.model.observe(ev);
      return null;
    }
    // Input events: observe, pace, answer. Never forward - the view blocks.
    if (INPUT_EVENTS.has(ev.name)) {
      this.model.observe(ev);
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      return this.answer(ev);
    }
    // Display-only menu: replay the buffered build-up so the view can show it.
    if (ev.name === "display_nhwindow") {
      const buffered = this.model.menus.get(ev.win);
      if (buffered) for (const e of buffered.events) await this.view.handle(e);
      const reply = await this.view.handle({ ...ev, blocking: false });
      this.model.observe(ev, reply as ShimReply);
      return reply as ShimReply;
    }
    // Everything else: forward, then observe (create_nhwindow needs the id).
    const reply = await this.view.handle(ev);
    this.model.observe(ev, reply as ShimReply);
    if (ev.name === "exit_nhwindows" && !this.announcedDeath) {
      this.announcedDeath = true;
      console.info("[bot] game over:", this.model.deathText);
    }
    return reply as ShimReply;
  }

  private answer(ev: ShimEvent): ShimReply {
    // A queued keystroke script (e.g. open-door + direction, or kick +
    // direction) answers single-key prompts in order, like a human typing -
    // a direction prompt mid-script must consume the queued key, not a
    // fresh rule-table/brain answer, or the queued key leaks into the next
    // nh_poskey as a bogus move. message_menu is never the target of a
    // queued script - draining there would burn a script key on a stray
    // message prompt, so it keeps its own plain rule-table answer below.
    if (
      (ev.name === "yn_function" || ev.name === "nhgetch" || ev.name === "nh_poskey") &&
      this.keys.length > 0
    ) {
      return this.keys.shift()!;
    }
    switch (ev.name) {
      case "askname":
        return "Bot";
      case "getlin":
        return null; // cancel: the bot never has a line to type
      case "yn_function":
        return answerYn(ev.query, ev.choices, ev.def);
      case "message_menu":
        return 0; // dismissed, nothing selected
      case "get_ext_cmd": {
        const idx = extCmdIndex(ev.commands, this.pendingExt);
        this.pendingExt = "";
        return idx;
      }
      case "select_menu": {
        const buf = this.model.menus.get(ev.win);
        return answerMenu(buf?.prompt ?? "", buf?.items ?? [], ev.how);
      }
      case "nhgetch":
      case "nh_poskey": {
        if (this.keys.length === 0) {
          const action = this.brain.decide(this.model);
          this.keys.push(...action.keys);
          if (action.extCmd) this.pendingExt = action.extCmd;
        }
        return this.keys.shift() ?? k("s");
      }
      default:
        return null;
    }
  }
}
