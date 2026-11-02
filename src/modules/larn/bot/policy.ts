// The Larn survivor: pure functions over a LarnBotModel. decide() is a
// priority ladder — first matching need wins — over src/bot/pathing.ts.
// This is the seed-policy baseline: survival common sense and how to
// operate the game, nothing learned. The reflect loop (spec, Phase 1)
// parameterizes and then replaces it.
//
// The ladder reads its knobs from the KB's tuning (src/bot/kb.ts) and
// consults the KB's learned tables where Phase 1b will want them. Those
// tables ship empty, and an empty table reproduces today's decisions
// exactly — scripts/test/test-larn-trace.mjs is that promise, executable.
//
// ".ts" import extensions: the headless gym loads this straight from source.
import type { LarnKey } from "../protocol.ts";
import { movementKey } from "../keys.ts";
import { TERRAIN_CATEGORIES } from "../../../backplane/cell.ts";
import { DIRS, farthest, isFrontier, nextStep, posKey, type Dir, type Step } from "../../../bot/pathing.ts";
import type { Kb, PolicyTuning } from "../../../bot/kb.ts";
import type { LarnBotModel } from "./model.ts";
import type { PromptContext } from "./prompts.ts";
import { ITEM_CLASS, type LarnItem } from "../statusRecords.ts";

export interface LarnAction {
  key: LarnKey;
  intent: string;
  /** Keys to feed to the nested reads this command raises, in order, before
   *  the prompt table is consulted. Only `cast` needs it, and it needs it
   *  because cast() reads three bytes of spell code back to back with no text
   *  printed between them (monster.c:251-260) — the prompt table matches TEXT,
   *  and there is none to match on the second and third. */
  follow?: LarnKey[];
}

const STAY: LarnKey = { code: ".".charCodeAt(0), mods: 0 };
/** The glyph Larn draws the town's volcanic shaft as: `data.c objnamelist[]`
 *  index 55, OVOLDOWN (header.h:238).
 *
 *  It is the ONE thing separating a shortcut to the volcano from an ordinary
 *  descent, because `native/main-wasm.c` maps OSTAIRSDOWN (`%`),
 *  OELEVATORDOWN (`^`), OENTRANCE (`E`) and OVOLDOWN (`V`) all to
 *  TERRAIN_STAIRS + KIND_DOWN. Taking it calls newcavelevel(MAXLEVEL) —
 *  internal 11 — from level 0 (object.c:345), so a 10-hp level-1 hero arrives
 *  eleven levels below anything it can survive. That was 50.6% of the
 *  2026-08-28 bench dying in a median of 19 commands
 *  (docs/specs/2026-08-28-larn-descent-readiness.md). */
const SHAFT = "V";
/** Larn's wield command (main.c:729). It never refuses a swap — unlike wear(),
 *  which prints "You're already wearing some armor" and makes an upgrade a
 *  two-command dance with an unarmoured turn in the middle. That asymmetry is
 *  why the probe below does weapons and not armour
 *  (docs/specs/2026-08-28-larn-wield-by-measurement.md). */
const WIELD: LarnKey = { code: "w".charCodeAt(0), mods: 0 };
/** The two suffixes show3() appends (main.c:636-638), mirrored by
 *  status_item_name() in the tap. They are part of the name the player reads,
 *  so an item's identity has to be taken without them: the same dagger is
 *  "a dagger" in the pack and "a dagger (weapon in hand)" once wielded. */
const EQUIPPED_SUFFIX = /\s*\((?:weapon in hand|being worn)\)/g;
/** Item classes wield() refuses outright (ycwi(), main.c:1021-1025). The tap
 *  labels exactly these two, so the candidate filter needs no name table. */
const UNWIELDABLE = new Set<number>([ITEM_CLASS.POTION, ITEM_CLASS.SCROLL]);

/** Larn's cast command (main.c:759). cast() prints "Enter your spell: " and
 *  then reads THREE bytes of spell code with nothing printed between them
 *  (monster.c:251-260), which is why the ladder hands them over as an action's
 *  `follow` rather than leaving them to the text-matching prompt table. */
const CAST: LarnKey = { code: "c".charCodeAt(0), mods: 0 };
/** spelcode[1], data.c:421 — magic missile. The hero knows it from character
 *  creation along with "pro" (create.c:42) and, before vect-hack-h9x.4, had
 *  never cast either in any run ever played. */
const MAGIC_MISSILE = ["m", "l", "e"].map((c) => ({ code: c.charCodeAt(0), mods: 0 }));
/** How far along a ray the ladder will look for something to shoot. godirect()
 *  travels until it hits, so this is the bot's own patience and not a game
 *  rule. */
const CAST_RANGE = 12;

const itemKey = (item: LarnItem) => `${item.letter}:${item.name.replace(EQUIPPED_SUFFIX, "")}`;
const inHand = (item: LarnItem) => item.name.includes("(weapon in hand)");
/** The glyph Larn draws every pile of gold as — OGOLDPILE, OMAXGOLD, OKGOLD
 *  and ODGOLD alike (data.c objnamelist; the "$" in that table is the bank of
 *  Larn, which the exporter reports as terrain and never as an item).
 *
 *  Gold is the one thing the semantic map calls an item that no pack slot ever
 *  holds: all four ids dispatch to ogold() (object.c:46), which adds straight
 *  to c[GOLD] and calls bottomgold() (object.c:1250). It never reaches take(),
 *  so it asks no question and a full pack cannot refuse it. Everything else
 *  the map marks an item arrives at finditem() (object.c:517) or at one of the
 *  four typed prompts, and every one of those ends in take().
 *
 *  Hence the carve-out in the loot step: a pack refusal is a fact about the
 *  PACK, and gold is not in the pack. Without it, one refusal would stop the
 *  hero walking to gold for the rest of the game the moment the KB ever gives
 *  "*" a value. */
const GOLD = "*";
// The rest duty cycle and the stuck counter are tuning, not knowledge: knobs
// the ladder was born with, so they live in data/kb/larn/policy.json (read
// through kb.tuning) and not among the facts a provenance audit walks.

/** May the hero step onto (x, y)? Larn walks floor, doors, stairs and
 *  features (they prompt; the prompt table declines) and onto items; not
 *  into walls, known traps, monsters (that is a fight, chosen on purpose)
 *  or the unseen — nor onto terrain the KB has learned to route around,
 *  which is nothing until the reflect loop fills that set.
 *
 *  The avoid key is "<category>:<ch>", never the bare category: Larn's
 *  volcanic shaft and an ordinary down staircase are both stairs of kind
 *  "down" (native/main-wasm.c:449-454) and differ only in the glyph, so a
 *  key without it could only say "avoid every staircase" — which would
 *  delete descent from the game. */
export function passable(model: LarnBotModel, x: number, y: number, kb: Kb): boolean {
  return walkable(model, x, y) && !avoided(model, x, y, kb);
}

/** passable() with nothing learned: what the map alone allows. Split out so
 *  the breach step can route through a learned avoidance the way it routes
 *  through a known trap — see decide() step 6b, whose contract this makes
 *  true. The invariant is worth naming: NO fact the reflect loop can write can
 *  make a cell permanently unreachable, because the step that fires when
 *  nothing else is reachable does not consult the KB at all. A learned
 *  avoidance is then a preference — take the other way while there is one —
 *  and never a wall (vect-hack-b5f.6). */
function walkable(model: LarnBotModel, x: number, y: number): boolean {
  if (x < 0 || x >= model.map.cols || y < 0 || y >= model.map.rows) return false;
  const c = model.map.at(x, y);
  if (c.hero) return true;
  if (c.category === "item") return c.terrain?.category !== "trap";
  if (c.category === "being") return false;
  if (!TERRAIN_CATEGORIES.has(c.category)) return false;
  return c.category !== "wall" && c.category !== "trap";
}

/** Has the KB learned to route around this cell? Read through an occupant the
 *  way the terrain rules are: an item lying on the volcanic shaft does not
 *  make the shaft something else. */
function avoided(model: LarnBotModel, x: number, y: number, kb: Kb): boolean {
  if (x < 0 || x >= model.map.cols || y < 0 || y >= model.map.rows) return false;
  const c = model.map.at(x, y);
  if (c.hero) return false;
  const under = TERRAIN_CATEGORIES.has(c.category) ? c : c.terrain;
  // The ceiling the hero has grown into, not today's wounds: an avoidance
  // asks whether this character is big enough for what is on the other side,
  // and a hero who is merely hurt should rest, not re-route (kb.avoidTerrain).
  return under !== undefined && kb.avoidTerrain(`${under.category}:${under.ch}`, model.hpmax);
}

/** Should the hero start this fight? Phase 1b asked a different question and
 *  lost an A/B on the difference: it compared a learned threat to a constant
 *  (`fleeThreshold`), so a table of honest 1.0s — a giant ant IS lethal to a
 *  level-1 character — read as "never fight anything". 74 of 100 runs never
 *  swung and the surface stratum lost 475 score points at the median
 *  (docs/reports/2026-08-21-larn-1b-ab.md, vect-hack-b5f.3).
 *
 *  Threat is a claim about a BEING. Engagement is a decision about a FIGHT, so
 *  it is derived here from the being's threat and the hero's own state, and
 *  never stored as a fact.
 *
 *  `capacity` is deliberately not clamped above 1. Most of the rejected claims
 *  carried value 1.0, so a ceiling of exactly 1 makes `threat < capacity` false
 *  for a hero at full health and reproduces the whole regression under a new
 *  formula. The experience term is what lifts a healthy hero over any threat in
 *  0..1, and that is the property it exists for.
 *
 *  Larn has no hunger, so there is no scarcity term pushing the other way: one
 *  hit for hunger|starv|hungry in the whole source and it is flavour text in a
 *  beggar's letter (external/larn/bill.c:97). The mobul clock is the analogue
 *  and it is out of reach — the 1a baseline's median run elapses 2 mobuls of a
 *  300-mobul budget, so a pressure term could not fire. See the spec.
 *
 *  A hero with no hpmax has not had a status record yet; there is nothing to
 *  judge, so fight, which is what the bot did before it learned anything. */
export function engage(
  threat: number | null, hp: number, hpmax: number, xlevel: number, tuning: PolicyTuning,
): boolean {
  if (threat === null) return true;
  if (hpmax <= 0) return true;
  const experience = tuning.engageLevelCap > 0
    ? Math.min(xlevel, tuning.engageLevelCap) / tuning.engageLevelCap * tuning.engageLevelWeight
    : 0;
  return threat < hp / hpmax + experience;
}

/** The nearest being standing on one of the eight rays out of the hero, with
 *  nothing but open floor in between — the only kind of target a Larn missile
 *  can reach, because godirect() travels in a straight line from the caster
 *  (monster.c:37).
 *
 *  Adjacent beings are deliberately excluded: the fight step above already
 *  swings at those, and spending the run's one charge on something already in
 *  melee buys a turn of being hit for damage the dagger was going to do
 *  anyway. This step is the opener before contact.
 *
 *  Returns the direction to shoot, or null. */
export function rayTarget(model: LarnBotModel): Dir | null {
  const hero = model.map.hero;
  if (!hero) return null;
  let best: { d: Dir; range: number } | null = null;
  for (const d of DIRS) {
    for (let step = 1; step <= CAST_RANGE; step++) {
      const x = hero.x + d.dx * step;
      const y = hero.y + d.dy * step;
      if (x < 0 || x >= model.map.cols || y < 0 || y >= model.map.rows) break;
      const c = model.map.at(x, y);
      if (c.category === "being" && !c.hero) {
        // step 1 is adjacent: the fight step's business, not this one.
        if (step > 1 && (best === null || step < best.range)) best = { d, range: step };
        break; // a missile stops at the first thing it meets, seen or not
      }
      // Anything that is not open going is where the missile stops. Unseen
      // included: a cell the screen has not shown is not a clear line.
      if (!walkable(model, x, y)) break;
      // A CLOSED door is walkable — the ladder opens it — but it is not
      // transparent, and godirect() stops the missile at it. Measured in the
      // first 30 games of real casting: "Your missiles hit the door" twice in
      // the first five hits. An open door is fine.
      if (c.category === "door" || c.terrain?.category === "door") break;
    }
  }
  return best?.d ?? null;
}

/** Is this cell a downward exit, and is it the volcanic shaft?
 *
 *  `stairs` may arrive as the cell's own category or as its terrain under an
 *  item or a being, which is why both are asked. */
export function downExit(model: LarnBotModel, x: number, y: number): { shaft: boolean } | null {
  const c = model.map.at(x, y);
  const t = c.category === "stairs" ? c : c.terrain;
  if (t?.category !== "stairs" || t.kind !== "down") return null;
  return { shaft: t.ch === SHAFT };
}

/** May the hero take a downward exit of this kind right now?
 *
 *  This is READINESS, not reachability, and it is the whole of vect-hack-h9x.5.
 *  The shaft is refused below `shaftMinXlevel` because its far side is level 11
 *  whatever the hero's level; an ordinary staircase has a separate, lower bar
 *  which ships neutral (`descendMinHpFraction` 0).
 *
 *  It can never seal a level: the breach steps (decide() 6 and 6b) route on
 *  walkable() and ask this nothing, so a hero who can reach nothing else still
 *  crosses. That is the same contract a learned avoidance lives under
 *  (vect-hack-b5f.6). */
export function readyToDescend(model: LarnBotModel, shaft: boolean, tuning: PolicyTuning): boolean {
  if (shaft) return model.xlevel >= tuning.shaftMinXlevel;
  if (tuning.descendMinHpFraction <= 0 || model.hpmax <= 0) return true;
  return model.hp >= model.hpmax * tuning.descendMinHpFraction;
}

/** A trap the screen has drawn, under whatever is standing on it. passable()
 *  refuses these and must: walking onto a known trap is a cost the ladder
 *  should not pay while anything else is reachable. The breach step is where
 *  "anything else" runs out. */
function knownTrap(model: LarnBotModel, x: number, y: number): boolean {
  if (x < 0 || x >= model.map.cols || y < 0 || y >= model.map.rows) return false;
  const c = model.map.at(x, y);
  return c.category === "trap" || c.terrain?.category === "trap";
}

const MOVE_INTENTS = new Set(["loot", "explore", "descend", "breach", "wander", "shuffle"]);

export class LarnBrain {
  private kb: Kb;
  private blocked = new Set<number>();
  // -1, not 0: the first decide() then resets a brain that has nothing to
  // reset, rather than skipping the reset for the level it started on.
  private lastEpoch = -1;
  private lastPos = -1;
  private lastIntent = "";
  private lastStep = -1;
  private stuck = 0;
  private rests = 0;
  /** Consecutive disengage steps. Bounded by tuning.disengageLimit: Larn's
   *  monsters move, so an unbounded retreat is a livelock with extra steps. */
  private disengages = 0;
  private wanderTarget = -1;
  /** The wield probe (vect-hack-h9x.6). The bot carries no weapon table: it
   *  wields a thing and reads the weapon class Larn prints on the bottom line,
   *  which is the game's own ranking and is on screen. Keyed by letter and the
   *  name with the equipped suffixes stripped, so the same dagger is one entry
   *  whether it is in the pack or in hand. */
  private measuredWc = new Map<string, number>();
  /** The item whose weapon class the NEXT status push will report, or null. */
  private probing: string | null = null;
  /** The letter the "What do you want to wield" prompt is to be answered with.
   *  Read by promptContext(), because prompts.ts stays pure. */
  private wieldLetter: string | null = null;
  /** Keys that were asked for and did not arrive in hand. A weapon Larn will
   *  not let this hero hold (the shield/two-handed-sword case, main.c:1032) is
   *  otherwise an infinite "wield the best" loop. */
  private unwieldable = new Set<string>();
  /** Wield commands spent so far, against tuning.wieldProbes. */
  private wieldSpent = 0;
  /** The direction the missile now in flight was aimed. Read by
   *  promptContext() for dirsub()'s "In What Direction?" (monster.c:1009). */
  private castDir: Dir | null = null;

  constructor(kb: Kb) { this.kb = kb; }

  /** What the prompt table needs to know beyond the text it is matching. It is
   *  built here rather than on the model because both fields are POLICY read
   *  against engine state — the shaft bar is a tuning knob, and the model has
   *  no opinion about knobs. Keeping it here also means the routing bar and the
   *  prompt bar are one function (readyToDescend) and cannot drift apart, which
   *  they must not: routing declines to walk to the shaft, and the prompt
   *  declines it when the hero arrives there for some other reason. */
  promptContext(model: LarnBotModel): PromptContext {
    return {
      packRoom: !model.packFull,
      readyForShaft: readyToDescend(model, true, this.kb.tuning),
      wieldLetter: this.wieldLetter,
      castDirection: movementKey((this.castDir ?? DIRS[0]!).compass, false),
    };
  }

  /** Open with a magic missile rather than closing the distance
   *  (vect-hack-h9x.4). The hero knows the spell from character creation
   *  (create.c:42) and, until this step existed, had never cast it in any run.
   *
   *  Three things it will not do, each for a source reason:
   *
   *  - It will not cast with no charge. cast() prints "You don't have any
   *    spells!" and returns WITHOUT reading the three code bytes
   *    (monster.c:245-248), so a queued "mle" would spill into whatever asked
   *    next. `status.spells` is the engine's own count, republished on every
   *    bottomline(), so nothing here models charge regeneration.
   *  - It will not cast at an adjacent being: that is the fight step's, and
   *    see rayTarget().
   *  - It will not fire at a target it cannot see a clear line to.
   *
   *  The fizzle paths need no handling here and that is worth saying, because
   *  the bead asked for it. speldamage() checks its 1/23 roll and the
   *  intelligence roll BEFORE calling godirect (monster.c:302-305), so a
   *  fizzled cast raises no direction prompt at all — which is exactly why the
   *  direction is answered from the prompt table on sight rather than queued
   *  behind the spell code, where it would leak into the next command. */
  private castStep(model: LarnBotModel): LarnAction | null {
    if (!this.kb.tuning.castAtRange) return null;
    const status = model.status;
    if (!status || status.spells <= 0) return null;
    const dir = rayTarget(model);
    if (!dir) return null;
    this.castDir = dir;
    return { key: CAST, intent: "cast", follow: MAGIC_MISSILE };
  }

  /** Wield the best weapon the hero is carrying, where "best" is whatever Larn
   *  reports the highest weapon class for (vect-hack-h9x.6). Returns null when
   *  there is nothing to do.
   *
   *  Three states, in this order, and the order is what makes it terminate:
   *
   *  1. **Record.** A probe issued last turn has landed; the status push that
   *     followed it carries the resulting `wc`. Read it and file it.
   *  2. **Probe.** Some carried item has never been measured. Wield it.
   *  3. **Restore.** Everything is measured and the best one is not in hand.
   *     Wield it back. If it does not arrive, it is one Larn refuses to give
   *     this hero and it is struck off, so this cannot repeat forever.
   *
   *  Every item is measured at most once per name, and a new item creates a new
   *  key, so the probe is bounded by what the hero picks up. */
  private wieldStep(model: LarnBotModel): LarnAction | null {
    const status = model.status;
    if (!status) return null;
    if (this.wieldSpent >= this.kb.tuning.wieldProbes) return null;

    // 1. Record. Done before the monster check, because the measurement is
    //    already paid for and dropping it would mean paying again later.
    if (this.probing !== null) {
      const measured = this.probing;
      this.probing = null;
      this.wieldLetter = null;
      const held = status.inventory.find(inHand);
      if (held && itemKey(held) === measured) this.measuredWc.set(measured, status.wc);
      else this.unwieldable.add(measured); // asked for, did not arrive
    }

    // Swapping costs a turn, and a turn spent swapping beside a monster is a
    // free round for the monster. Same condition the rest step uses.
    if (this.monsterVisible(model)) return null;

    const candidates = status.inventory.filter(
      (i) => !UNWIELDABLE.has(i.itemClass) && !this.unwieldable.has(itemKey(i)),
    );
    // 2. Probe the first thing never measured.
    const fresh = candidates.find((i) => !this.measuredWc.has(itemKey(i)));
    if (fresh) {
      this.probing = itemKey(fresh);
      this.wieldLetter = fresh.letter;
      this.wieldSpent++;
      return { key: WIELD, intent: "wield-probe" };
    }
    // 3. Restore the best.
    let best: LarnItem | null = null;
    let bestWc = -Infinity;
    for (const item of candidates) {
      const wc = this.measuredWc.get(itemKey(item));
      if (wc !== undefined && wc > bestWc) { bestWc = wc; best = item; }
    }
    if (best && !inHand(best)) {
      this.probing = itemKey(best);
      this.wieldLetter = best.letter;
      this.wieldSpent++;
      return { key: WIELD, intent: "wield-best" };
    }
    return null;
  }

  decide(model: LarnBotModel): LarnAction {
    const hero = model.map.hero;
    if (!hero) return { key: STAY, intent: "wait" };
    const here = posKey(model.map, hero.x, hero.y);

    // The block list is one map's geometry. The engine's own level event is
    // the primary signal that it is stale: Larn keeps the hero's coordinates
    // across stairs (global.c positionplayer), so a descent can look like a
    // one-cell step. The jump heuristic below is the fallback, for a
    // teleport within a level.
    if (model.levelEpoch !== this.lastEpoch) {
      this.lastEpoch = model.levelEpoch;
      this.blocked.clear(); this.stuck = 0; this.wanderTarget = -1;
      this.disengages = 0;
    }
    if (this.lastPos !== -1 && chebyshev(model.map.cols, this.lastPos, here) > 3) {
      this.blocked.clear(); this.stuck = 0; this.wanderTarget = -1;
      this.disengages = 0;
    }
    // Anti-stuck: a move that did not move us marks the cell it aimed at —
    // unless that cell still shows a CLOSED door, which is not a refusal
    // about terrain at all. See closedDoor() below.
    if (MOVE_INTENTS.has(this.lastIntent)) {
      if (here === this.lastPos) {
        if (!closedDoor(model, this.lastStep)) {
          if (++this.stuck >= this.kb.tuning.stuckLimit && this.lastStep !== -1) { this.blocked.add(this.lastStep); this.stuck = 0; }
        }
      } else this.stuck = 0;
    }
    this.lastPos = here;

    const action = this.pick(model, hero);
    this.lastIntent = action.intent;
    if (action.intent !== "rest") this.rests = 0;
    return action;
  }

  private pick(model: LarnBotModel, hero: { x: number; y: number }): LarnAction {
    this.lastStep = -1;
    // 1. Fight an adjacent monster (walking into it attacks). WHICH one, and
    //    whether at all, is engage()'s question — read its header for what
    //    Phase 1b got wrong here. Every adjacent being is ranked by threat and
    //    the least dangerous engageable one is attacked: declining to a whole
    //    group is how a bot gets surrounded.
    //
    //    An unknown threat ranks 0 and ties keep DIRS order, so with an empty
    //    table every rank is 0 and the first DIRS direction wins — which is
    //    exactly the loop this replaced. test-larn-trace.mjs is that promise.
    const adjacent: { d: Dir; threat: number | null }[] = [];
    for (const d of DIRS) {
      const c = model.map.at(hero.x + d.dx, hero.y + d.dy);
      if (c.category === "being" && !c.hero) {
        adjacent.push({ d, threat: this.kb.threat(c.ch, c.color, model.maxDepth) });
      }
    }
    if (adjacent.length > 0) {
      const t = this.kb.tuning;
      const byThreat = adjacent
        .map((a, i) => ({ ...a, i }))
        .sort((a, b) => (a.threat ?? 0) - (b.threat ?? 0) || a.i - b.i);
      const winnable = byThreat.find((a) => engage(a.threat, model.hp, model.hpmax, model.xlevel, t));
      // 1a. Nothing here is worth starting: step away instead. One step, and
      //     only disengageLimit of them in a row. Cornered, or out of
      //     retreats, the ladder swings at the least dangerous of them anyway
      //     — standing next to a monster taking free hits is strictly worse,
      //     and a being the ladder will neither attack nor walk around is a
      //     wall across the corridor, because passable() treats it as one.
      //     That is where 1b's depth loss came from, with no second mechanism.
      if (winnable === undefined && this.disengages < t.disengageLimit) {
        const away = this.retreat(model, hero, adjacent.map((a) => a.d));
        if (away !== null) { this.disengages++; return away; }
      }
      this.disengages = 0;
      return { key: movementKey((winnable ?? byThreat[0]!).d.compass, false), intent: "fight" };
    }
    this.disengages = 0;
    // 1b. Nothing is adjacent. If something is in line at range and there is a
    //     charge, open with a missile instead of walking into its reach
    //     (vect-hack-h9x.4). Above rest for the obvious reason: resting while
    //     a monster closes is how the ladder gets hit for free.
    const cast = this.castStep(model);
    if (cast) return cast;
    // 2. Rest when weak and nothing is in view (Larn regenerates over time).
    //    hp < hpmax * 0.5 is the old `hp * 2 < hpmax` exactly: halving and
    //    doubling are both exact in binary floating point at these magnitudes,
    //    so no integer HP pair can straddle the two forms.
    if (model.hpmax > 0 && model.hp < model.hpmax * this.kb.tuning.restBelowHpFraction
        && !this.monsterVisible(model) && this.rests < this.kb.tuning.restLimit) {
      this.rests++;
      return { key: STAY, intent: "rest" };
    }
    // 2b. Put the best weapon in hand. Beside the rest step rather than above
    //     the fight step: swapping costs a turn (vect-hack-h9x.6), and the
    //     step declines while anything is visible for exactly that reason.
    const wield = this.wieldStep(model);
    if (wield) return wield;
    const rules = { passable: (x: number, y: number) => passable(model, x, y, this.kb), blocked: this.blocked };
    // 3. Loot: walk to an item the KB values (pickup is automatic —
    //    lookforobject() runs on every move, main.c:291, and the prompt table
    //    answers "t" — so this is pure routing). The table is empty until the
    //    reflect loop writes it, so this step never fires today.
    //
    //    A full pack turns most of those targets into a walk that buys a
    //    refusal and changes nothing, so they are off while the engine says
    //    the pack is full (vect-hack-b5f.10). Off wholesale, not cell by cell:
    //    "You can't carry anything else" is a fact about the PACK, and a
    //    per-cell memory of it only sends the hero to the next item to be told
    //    the same thing.
    //
    //    Gold is the exception, and not as a courtesy: it is not carried at
    //    all, so a full pack says nothing about it. See GOLD below.
    const wantsItem = (x: number, y: number) => {
      const c = model.map.at(x, y);
      if (c.category !== "item") return false;
      if (model.packFull && c.ch !== GOLD) return false;
      return (this.kb.itemValue(c.ch) ?? 0) > 0;
    };
    const loot = nextStep(model.map, hero, wantsItem, rules);
    if (loot) return this.walk(model, loot, "loot");
    // 4. Explore the frontier.
    const explore = nextStep(model.map, hero, (x, y) => isFrontier(model.map, x, y, rules.passable), rules);
    if (explore) return this.walk(model, explore, "explore");
    // 5. Descend: walk onto the down stairs / the dungeon entrance; Larn
    //    asks and the prompt table answers "c"/"g". Standing on them already
    //    means we declined once — step off so the next arrival asks again.
    //
    //    A downward exit the hero is not READY for is not a target: the
    //    volcanic shaft drops a level-1 character to internal 11 and was half
    //    of every batch dying in 19 commands (vect-hack-h9x.5). The bar is
    //    readyToDescend(), and it is a preference, never a wall — the breach
    //    steps below ask it nothing.
    const isDown = (x: number, y: number) => {
      const exit = downExit(model, x, y);
      return exit !== null && readyToDescend(model, exit.shaft, this.kb.tuning);
    };
    if (isDown(hero.x, hero.y)) {
      for (const d of DIRS) {
        if (passable(model, hero.x + d.dx, hero.y + d.dy, this.kb)) {
          this.lastStep = posKey(model.map, hero.x + d.dx, hero.y + d.dy);
          return { key: movementKey(d.compass, false), intent: "shuffle" };
        }
      }
    }
    const down = nextStep(model.map, hero, isDown, rules);
    if (down) return this.walk(model, down, "descend");
    // 6. Breach: nothing left to explore and no staircase to walk to, but a
    //    being borders the reachable region. passable() treats a being as
    //    impassable and must — walking into one is an attack, not a step — so
    //    a monster standing in the only corridor seals the hero into a pocket
    //    that exploration and descent can both see past and neither can cross.
    //    The ladder then circles it until the command cap: seed 565999359
    //    reached 24000 commands on depth 1 at full HP with 20 of 1139 cells
    //    reachable, the region bounded by 103 walls and three monsters
    //    (vect-hack-b5f.5). Route to a cell beside one and let step 1 have the
    //    fight; nothing else in the ladder ever chooses to remove that wall.
    const breach = nextStep(model.map, hero, (x, y) => this.bordersEngageable(model, x, y), rules);
    if (breach) return this.walk(model, breach, "breach");
    // 6b. The seal is not always a monster. passable() also refuses a known
    //     trap, so a trap in the only corridor closes a level exactly the same
    //     way: held-out seed 238386701 reached the 24000-command cap with 2 of
    //     1139 cells reachable, the region bounded by 13 walls and one trap.
    //     Crossing it is a real cost; staying sealed in is a certain loss, so
    //     the ladder pays it once nothing else is reachable. Terrain the KB
    //     learned to avoid is crossed here too — an avoided cell that closes
    //     the level is the same dead end under another name, and a learned
    //     avoidance that can strand the bot is worse than none. That is why
    //     this predicate is built on walkable() rather than passable(): it
    //     asks what the MAP allows and consults nothing the reflect loop
    //     wrote, so no fact can seal a level however wrong it is
    //     (vect-hack-b5f.6 — the comment said this before the code did).
    const throughSeal = {
      passable: (x: number, y: number) => walkable(model, x, y) || knownTrap(model, x, y),
      blocked: this.blocked,
    };
    //     Readiness is dropped here for the same reason the KB is: this step
    //     fires only when nothing else is reachable, and a hero sealed into a
    //     pocket whose one exit is a shaft it is not ready for must still take
    //     it. A certain loss now beats a bar that was only ever a preference
    //     (vect-hack-h9x.5, and the b5f.6 contract it borrows).
    const sealed = nextStep(
      model.map, hero,
      (x, y) => downExit(model, x, y) !== null || isFrontier(model.map, x, y, throughSeal.passable),
      throughSeal,
    );
    if (sealed) return this.walk(model, sealed, "breach");
    // 7. Wander to the farthest reachable cell (a fresh view of a done level).
    const here = posKey(model.map, hero.x, hero.y);
    if (this.wanderTarget === here) this.wanderTarget = -1;
    if (this.wanderTarget === -1) this.wanderTarget = farthest(model.map, hero, rules) ?? -1;
    if (this.wanderTarget !== -1) {
      const t = this.wanderTarget;
      const step = nextStep(model.map, hero, (x, y) => posKey(model.map, x, y) === t, rules);
      if (step) return this.walk(model, step, "wander");
      this.wanderTarget = -1;
    }
    return { key: STAY, intent: "wait" };
  }

  /** Is (x, y) next to a being this hero would take on? Engageable, not merely
   *  adjacent: routing the hero back to a monster step 1 will decline is an
   *  oscillation, and disengageLimit cannot end it — that counter resets every
   *  time the hero steps out of reach, which is exactly what a retreat does. */
  private bordersEngageable(model: LarnBotModel, x: number, y: number): boolean {
    for (const d of DIRS) {
      const c = model.map.at(x + d.dx, y + d.dy);
      if (c.category !== "being" || c.hero) continue;
      const threat = this.kb.threat(c.ch, c.color, model.maxDepth);
      if (engage(threat, model.hp, model.hpmax, model.xlevel, this.kb.tuning)) return true;
    }
    return false;
  }

  /** One step away from the beings we declined: the passable, unblocked
   *  neighbour that maximises the minimum Chebyshev distance to them, DIRS
   *  order breaking ties. The bar starts at 1, which is the distance we are
   *  already at, so a step that stays adjacent is not a retreat and null means
   *  cornered. */
  private retreat(model: LarnBotModel, hero: { x: number; y: number }, beings: Dir[]): LarnAction | null {
    const at = beings.map((d) => ({ x: hero.x + d.dx, y: hero.y + d.dy }));
    let best: Dir | null = null;
    let bestDist = 1;
    for (const d of DIRS) {
      const nx = hero.x + d.dx, ny = hero.y + d.dy;
      if (!passable(model, nx, ny, this.kb)) continue;
      if (this.blocked.has(posKey(model.map, nx, ny))) continue;
      let min = Infinity;
      for (const p of at) min = Math.min(min, Math.max(Math.abs(p.x - nx), Math.abs(p.y - ny)));
      if (min > bestDist) { bestDist = min; best = d; }
    }
    if (best === null) return null;
    this.lastStep = posKey(model.map, hero.x + best.dx, hero.y + best.dy);
    return { key: movementKey(best.compass, false), intent: "disengage" };
  }

  private walk(model: LarnBotModel, step: Step, intent: string): LarnAction {
    this.lastStep = posKey(model.map, step.x, step.y);
    return { key: movementKey(step.dir.compass, false), intent };
  }

  private monsterVisible(model: LarnBotModel): boolean {
    for (const c of model.map.cells) if (c.category === "being" && !c.hero) return true;
    return false;
  }
}

/** Does the cell the last step aimed at still show a closed door? That is the
 *  one refusal Larn hands out at random rather than as a fact about terrain.
 *  A closed door asks "(o) try to open it" and then rolls: `rnd(11) < 7` fails
 *  6 times in 11, prints nothing in the ordinary case and puts the hero back
 *  on lastpx/lastpy (external/larn/object.c, OCLOSEDDOOR). Movement alone
 *  cannot separate that from a wall, but the map can — a successful open
 *  writes item[x][y] = OOPENDOOR, so the cell is the whole signal: still a
 *  closed door means the roll failed and the step is worth repeating.
 *
 *  `blocked` is a claim that a cell is impassable terrain, kept for the whole
 *  level, and a die roll is not terrain. Latching on one sealed seed
 *  1185260916 behind its own two doorways for 24000 commands: three unlucky
 *  attempts in a row is (6/11)^3, about one closed door in six
 *  (vect-hack-b5f.11). Retrying is unbounded on purpose — no expiry, no
 *  door-specific counter — because the door opens with probability 5/11 per
 *  attempt and the state that ends the retry is the map's, not a clock's.
 *
 *  The terrain is read through an occupant the way passable() reads it: a
 *  being that stepped into the doorway between the decision and the move is
 *  not terrain either. */
function closedDoor(model: LarnBotModel, key: number): boolean {
  if (key === -1) return false;
  const c = model.map.at(key % model.map.cols, (key / model.map.cols) | 0);
  const under = TERRAIN_CATEGORIES.has(c.category) ? c : c.terrain;
  return under?.category === "door";
}

function chebyshev(cols: number, a: number, b: number): number {
  return Math.max(Math.abs((a % cols) - (b % cols)), Math.abs(((a / cols) | 0) - ((b / cols) | 0)));
}
