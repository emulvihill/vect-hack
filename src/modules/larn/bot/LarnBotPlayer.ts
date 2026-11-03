// A self-playing LarnHandler decorator: display events flow through to the
// wrapped view (and feed the bot's world model); every key request is
// answered here — a poll with nothing, a nested prompt (cmd=0) from the
// prompt table over the text the engine printed since the last key, a
// command boundary (cmd=1) from the brain. Wire it in main.ts with ?bot for
// ?game=larn; the headless gym wraps it in a LarnRecorder.
//
// ".ts" import extensions: the headless gym loads this straight from source.
import type { LarnEvent, LarnKey } from "../protocol.ts";
import type { LarnHandler } from "../session.ts";
import { LarnBotModel } from "./model.ts";
import { LarnBrain, type PolicyTuning } from "./policy.ts";
import { answerPrompt } from "./prompts.ts";

export class LarnBotPlayer implements LarnHandler {
  /** The bot's world model; the gym reads snapshot() from it. */
  readonly model = new LarnBotModel();
  private brain: LarnBrain;
  private view: LarnHandler;
  private delayMs: number;

  /** `tuning` overrides the ladder's knobs (policy.ts DEFAULT_TUNING); only
   *  the gym's --tuning passes one. */
  constructor(view: LarnHandler, delayMs = 150, tuning: Partial<PolicyTuning> = {}) {
    this.view = view;
    this.brain = new LarnBrain(tuning);
    this.delayMs = delayMs;
  }

  onReady(): void { this.view.onReady?.(); }
  onNotice(text: string): void { this.view.onNotice(text); }

  /** Forwarded like onReady/onNotice: a decorator that swallows teardown
   *  leaves the wrapped view's listeners installed (vect-hack-a8r). */
  dispose(): void { this.view.dispose?.(); }

  handle(ev: LarnEvent): void {
    this.model.observe(ev);
    this.view.handle(ev);
  }

  /** The engine's own end (VectLarn.quit) — the gym calls this. */
  onQuit(): void { this.model.onQuit(); }

  /** Keys the last command owes to the nested reads it raises, in order.
   *
   *  Only `cast` fills this. cast() prints "Enter your spell: " once and then
   *  reads three bytes back to back (monster.c:251-260), so the second and
   *  third reads see no new text and the prompt table — which matches text —
   *  has nothing to go on. Draining a queue is the only honest answer.
   *
   *  It is cleared at every COMMAND boundary, which is the safety property.
   *  cast() returns without reading anything at all when the hero has no
   *  charge ("You don't have any spells!", monster.c:245-248); the ladder will
   *  not cast in that state, but if a queue ever did survive a command it
   *  would answer the next prompt with a spell-code letter, and nothing
   *  downstream would say why. */
  private pending: LarnKey[] = [];

  async nextKey(wait: boolean, cmd: boolean): Promise<LarnKey | null> {
    if (!wait) return null; // a poll: no key
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (!cmd && this.pending.length > 0) {
      const owed = this.pending.shift()!;
      this.model.keyAnswered(false);
      return owed;
    }
    if (cmd) this.pending = [];
    const action = cmd ? this.brain.decide(this.model) : null;
    const key = action
      ? action.key
      : answerPrompt(this.model.textSinceLastKey, this.brain.promptContext(this.model));
    if (action?.follow) this.pending = [...action.follow];
    this.model.keyAnswered(cmd);
    return key;
  }
}
