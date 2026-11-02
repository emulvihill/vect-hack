// Hit inference (spec 2026-08-06): Angband's EVENT_MESSAGE arrives with a
// typed messageType (list-message.h positions, pinned 4.2.6 submodule), but
// no victim position — that is inferred from the last direction the view
// sent (melee) or the last ranged effect cell (missiles/bolts). An
// ambiguous case answers null: no pulse, never a guessed one. Pure
// functions; the view owns the bookkeeping.
//
// MON_HIT is the one type that also reads the message TEXT (vect-hack-xqg),
// which is a deliberate crossing of the typed-vs-text line the spec drew
// between this file and the NetHack one. The line was a statement about what
// each engine affords, not a prohibition, and here the typed signal is simply
// not a discriminator: MON_HIT is a blow-METHOD type, so mon-blows.c emits it
// from display_blow_message_vs_player() AND from
// display_blow_message_vs_monster() — a monster hitting another monster,
// reachable through the command-monster mechanic (cmd-cave.c,
// monster_attack_monster). Nothing else in the event tells the two apart, so
// without the text "The kobold hits the orc." reddens the player's @. The
// governing rule decides it: a MON_HIT whose text does not name the player is
// not an ambiguous case, it is a known-not-the-hero one, and drawing nothing
// is what this file does with those. What it costs is written on
// PLAYER_TARGET below.
import { STEP_OF } from "../../ui/gaze";
import { KC_MOD_KEYPAD, KEYPAD_DIGITS } from "./keys";
import type { AngbandKey } from "./protocol";

/** The list-message.h positions this file acts on (enum from 0). */
export const MSG = {
  HIT: 2, MISS: 3, MON_HIT: 34, SHOOT_HIT: 85,
  HIT_GOOD: 141, HIT_GREAT: 142, HIT_SUPERB: 143,
  HIT_HI_GREAT: 144, HIT_HI_SUPERB: 145,
} as const;

export interface Dir { dx: number; dy: number }
export interface Point { x: number; y: number }

/** KEYPAD_DIGITS is in the same clockwise-from-north compass order as gaze's
 *  STEP_OF, so the digit's index is the delta's index and the decode can never
 *  drift from what movementKey encodes. A fresh object per call: STEP_OF is a
 *  shared table and a caller must not be able to corrupt it. Run/shift is
 *  still the same direction; anything that is not a keypad direction answers
 *  null. */
export function angbandKeyDir(key: AngbandKey): Dir | null {
  if (!(key.mods & KC_MOD_KEYPAD)) return null;
  const i = KEYPAD_DIGITS.indexOf(String.fromCharCode(key.code));
  if (i < 0) return null;
  const [dx, dy] = STEP_OF[i]!;
  return { dx, dy };
}

/** Melee-only message types: only hero + lastDir can be the victim. The
 *  ranged crit table (constants.txt ranged-critical-level) tops out at
 *  HIT_SUPERB, so the HI_ tiers never come off a bow or a thrown object. */
const MELEE_HITS: ReadonlySet<number> = new Set([
  MSG.HIT, MSG.HIT_HI_GREAT, MSG.HIT_HI_SUPERB,
]);

/** Types the engine emits for melee crits AND ranged crits (plus melee
 *  SHOOT_HIT under the O-combat birth option): the last key disambiguates. */
const AMBIGUOUS_HITS: ReadonlySet<number> = new Set([
  MSG.HIT_GOOD, MSG.HIT_GREAT, MSG.HIT_SUPERB, MSG.SHOOT_HIT,
]);

/**
 * Whether a MON_HIT blow landed on the player rather than on another monster.
 *
 * Only the HIT method carries MSG_MON_HIT (blow_methods.txt), and it has one
 * action message, `act:hits {target}`. mon-blows.c expands `{target}` to the
 * literal "you" for the player (BLOW_TAG_TARGET, midx <= 0) and to
 * monster_desc() of the target otherwise — "the orc", "it", never the word
 * "you". So this is exactly the vs-player/vs-monster split, read off the one
 * place the two messages differ.
 *
 * What it costs, stated plainly. It is a text test in the typed Module, and it
 * leans on upstream data ("hits {target}") as well as upstream code — but on
 * the same pinned 4.2.6 submodule the typed list-message.h positions already
 * lean on, so the pin covers both. If upstream ever gives HIT an action
 * message with no target tag, both directions of the blow read alike again and
 * the hero stops pulsing on a real hit: a lost flash, which is the side this
 * file has always erred on. `\byou\b` and not a looser match so the possessive
 * "your" and a name like "young blue dragon" cannot pass for a target.
 */
const PLAYER_TARGET = /\byou\b/i;

/** Victim cell for a typed message, or null for "no pulse". `lastDir` must
 *  be fresh (cleared by any non-direction key) and `lastEffect` must belong
 *  to the command in flight (cleared on every key send) — the view owns
 *  that bookkeeping. `text` is read for MON_HIT alone (see the header). */
export function inferAngbandHit(
  messageType: number, text: string, hero: Point | null, lastDir: Dir | null,
  lastEffect: Point | null,
): Point | null {
  if (!hero) return null;
  if (messageType === MSG.MON_HIT) return PLAYER_TARGET.test(text) ? hero : null;
  const melee = lastDir ? { x: hero.x + lastDir.dx, y: hero.y + lastDir.dy } : null;
  if (MELEE_HITS.has(messageType)) return melee;
  if (AMBIGUOUS_HITS.has(messageType)) return melee ?? lastEffect;
  return null;
}
