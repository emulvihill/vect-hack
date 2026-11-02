// Rule table for the questions Larn asks through direct ttgetch() reads
// (getKey with cmd=0): the text the engine printed since the bot's last key
// names the choice. Every rule is operational knowledge of Larn's prompts
// (object.c lookforobject and friends, help.c retcont, global.c more) plus
// survival common sense — an unknown container is left alone, as an unknown
// potion is carried, not drunk, while a closed door is opened because
// everything behind it is otherwise unreachable. The two share the
// phrase "(o) try to open it", so the chest rule is matched first by its own
// wording. Nothing here knows what a monster or an item is worth: that is the
// reflect loop's to learn (spec, seed policy).
//
// Two rules need more than the text they match, and both ask the same kind of
// question: "is the hero in a position to say yes?". Taking an item needs a
// free pack slot, which only the engine knows; climbing the volcanic shaft
// needs an experience level the hero probably does not have. Those live in
// PromptContext, and a rule whose gate is false simply falls through to the
// "(i) ignore" out that iopts() offers on every one of these prompts.
//
// ".ts" import extensions: the headless gym loads this straight from source.
import type { LarnKey } from "../protocol.ts";
import { KC_ESCAPE } from "../protocol.ts";

export const key = (ch: string): LarnKey => ({ code: ch.charCodeAt(0), mods: 0 });

/** What an answer needs beyond the text. Both fields are POSITIVE — "yes, you
 *  may" — so a rule's gate reads the same way as the rule: the gate must be
 *  true for the answer to be given. */
export interface PromptContext {
  /** Is there a free pack slot? The engine's own refusal is what latches this
   *  (LarnBotModel.packFull); take()'s limit is deliberately not recomputed
   *  here, because a second copy of a game rule drifts. */
  packRoom: boolean;
  /** May the hero take the volcanic shaft (object.c:320-345, OVOLDOWN)?
   *
   *  The ladder declining to ROUTE to it is not enough. The shaft sits in the
   *  town among the buildings the explore and wander steps cross, so the hero
   *  arrives on it for other reasons and is asked anyway — and answering "c"
   *  is a one-way trip to internal 11. That was 50.6% of the 2026-08-28 bench
   *  dying in a median of 19 commands (vect-hack-h9x.5). Supplied by the
   *  ladder's readyToDescend(). */
  readyForShaft: boolean;
  /** The pack letter to answer `whatitem()` with, or null. Set by the ladder's
   *  wield probe the same turn it emits `w`, so this is never a guess about
   *  which item is meant (vect-hack-h9x.6).
   *
   *  Null falls through to the ESC default, and ESC is the only right answer:
   *  whatitem() also accepts `.`, but wield()'s `while (1)` treats `.` as
   *  "ask again" (main.c:1015-1044) and would prompt for ever. Only `\33`
   *  returns. */
  wieldLetter: string | null;
  /** The direction key to answer dirsub()'s "In What Direction?" with
   *  (monster.c:1006-1041).
   *
   *  Never null, and that is a safety property rather than a convenience:
   *  dirsub loops `for (i = 0;;) switch (ttgetch())` over the eight vi keys
   *  and has NO escape case, so an ESC there spins the engine for ever while
   *  the driver keeps feeding it. Every reachable answer must be one of
   *  h j k l y u b n. */
  castDirection: LarnKey;
}

/** `[pattern, answer, gate]`. The answer is a literal key, or a function of the
 *  context for the one prompt whose answer is not fixed — the item letter. A
 *  function returning null means "no answer", and the prompt falls through. */
const RULES: [RegExp, string | ((c: PromptContext) => string | null), (keyof PromptContext)?][] = [
  // dirsub() (monster.c:1009). Answered FIRST and unconditionally: it has no
  // escape case, so anything but one of the eight vi keys spins the engine.
  [/in what direction/i, (c) => String.fromCharCode(c.castDirection.code)],
  [/return to continue/i, "\n"],               // retcont(): only LF advances
  [/press space to continue/i, " "],           // more()
  [/dungeon entrance[\s\S]*\(g\) go inside/i, "g"],
  // The only "(c) climb down" Larn prints, and the one prompt that can end a
  // run outright. Gated, and it declines by falling through to "(i)".
  [/\(c\) climb down/i, "c", "readyForShaft"],
  [/\(d\) go down/i, "d"],                     // ostairs(): the ordinary down staircase
  [/\(s\) stay here/i, "s"],                   // ostairs() going up: decline
  [/chest[\s\S]*\(o\) try to open it/i, "i"],  // ochest(): an unknown container; leave it alone
  [/\(o\) try to open it/i, "o"],              // a closed door (object.c OCLOSEDDOOR): open it
  // whatitem() (main.c:1290), raised by wield among others. The letter comes
  // from the ladder step that asked the question this same turn.
  [/what do you want to wield/i, (c) => c.wieldLetter, "wieldLetter"],
  [/\(t\) take it/i, "t", "packRoom"],
  [/\(i\) (ignore|stay)/i, "i"],               // up stairs, buildings, home, altar, fountain, throne, doors
];

/** The key for the prompt whose text is `text`; ESC when no rule matches
 *  (Larn reads the raw byte 27 as cancel wherever it prompts, and a store
 *  screen leaves on it). */
export function answerPrompt(text: string, context: PromptContext): LarnKey {
  for (const [re, answer, gate] of RULES) {
    if (gate && !context[gate]) continue;
    if (!re.test(text)) continue;
    const ch = typeof answer === "string" ? answer : answer(context);
    if (ch !== null) return key(ch);
  }
  return { code: KC_ESCAPE, mods: 0 };
}
