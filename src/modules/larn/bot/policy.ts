// The Larn survivor: pure functions over a LarnBotModel. decide() is a
// priority ladder — first matching need wins — over src/bot/pathing.ts.
// Survival common sense and how to operate the game, nothing learned: its
// knobs are the hand-tuned constants in DEFAULT_TUNING, and
// scripts/test/test-larn-trace.mjs pins the keystrokes they produce.
//
// ".ts" import extensions: the headless gym loads this straight from source.
import type { LarnKey } from "../protocol.ts";
import { movementKey } from "../keys.ts";
import { TERRAIN_CATEGORIES } from "../../../backplane/cell.ts";
import { DIRS, farthest, isFrontier, nextStep, posKey, type Dir, type Step } from "../../../bot/pathing.ts";
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

/** The ladder's knobs: constants it was born with and that measurement has
 *  tuned by hand against the bench (docs/BOT.md). Never learned.
 *  scripts/dev/policy-sweep.mjs searches them through the gym's `--tuning`,
 *  which resolveTuning() merges over DEFAULT_TUNING. */
export interface PolicyTuning {
  /** Consecutive rest turns before the ladder moves on anyway. */
  restLimit: number;
  /** Moves in a row that did not move the hero before the cell they aimed at
   *  is blocked for the rest of the level. */
  stuckLimit: number;
  /** Fraction of hpmax below which the hero rests, while nothing is in view. */
  restBelowHpFraction: number;
  /** Experience level at or above which Larn's volcanic town shaft is a route
   *  rather than a hole. It drops the hero to internal 11 whatever their level
   *  (object.c:345), and at level 1 that was half of every batch dying in 19
   *  commands. A bar rather than a ban: the volcano holds the potion the win
   *  condition requires, so "never" would delete the win from the game
   *  (docs/specs/2026-08-28-larn-descent-readiness.md). */
  shaftMinXlevel: number;
  /** Fraction of hpmax at or above which the hero will take an ORDINARY
   *  downward exit. Ships at 0 — no bar — because raising it is a second
   *  variable, and because it cannot exceed restBelowHpFraction without
   *  deadlocking: the rest step stops resting at that fraction, so a higher
   *  descent bar refuses every staircase for the rest of the game. */
  descendMinHpFraction: number;
  /** Most wield commands the bot will spend in one game measuring what it is
   *  carrying (vect-hack-h9x.6). **0 disables the probe**, which is how the
   *  control arm of its A/B is run.
   *
   *  A safety bound, not a tuning target. Measured over 30 real games the bot
   *  spends about 8, or 1.2% of its commands; the bound exists because a
   *  RENAMED item is a new item to the probe, and Larn renames one whenever its
   *  enchantment moves — a rust monster walking a dagger down from -1 to -5
   *  buys five fresh measurements. That is correct (the item really did change)
   *  and it is still worth a ceiling. */
  wieldProbes: number;
  /** Open on a being at range with magic missile instead of closing
   *  (vect-hack-h9x.4). **false disables it**, which is how the control arm of
   *  its A/B is run. The hero knows the spell from character creation
   *  (create.c:42) and the charge count is the engine's to report, so this is
   *  a policy switch and not a budget. */
  castAtRange: boolean;
}

/** What the bot plays with unless a caller overrides a knob. The wield probe
 *  and the missile ship off until they earn their place against the bench
 *  (docs/specs/2026-08-28-larn-wield-by-measurement.md,
 *  docs/specs/2026-08-28-larn-cast-at-range.md). */
export const DEFAULT_TUNING: Readonly<PolicyTuning> = Object.freeze({
  restLimit: 150,
  stuckLimit: 3,
  restBelowHpFraction: 0.5,
  shaftMinXlevel: 8,
  descendMinHpFraction: 0,
  wieldProbes: 0,
  castAtRange: false,
});

/** DEFAULT_TUNING with a partial `override` merged over it — the gym's
 *  `--tuning`, already parsed from JSON. A knob DEFAULT_TUNING does not name,
 *  or a value of another type than the default's, is refused rather than
 *  ignored: a misspelt knob would otherwise play the default and still report
 *  itself as the arm it named. */
export function resolveTuning(override: unknown): PolicyTuning {
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new Error(`a tuning override must be a JSON object, got ${JSON.stringify(override)}`);
  }
  const tuning: Record<string, unknown> = { ...DEFAULT_TUNING };
  for (const [knob, value] of Object.entries(override)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TUNING, knob)) {
      throw new Error(`unknown tuning knob "${knob}"; the knobs are ${Object.keys(DEFAULT_TUNING).join(", ")}`);
    }
    if (typeof value !== typeof tuning[knob]) {
      throw new Error(`tuning knob "${knob}" must be a ${typeof tuning[knob]}, got ${JSON.stringify(value)}`);
    }
    tuning[knob] = value;
  }
  return tuning as unknown as PolicyTuning;
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

/** May the hero step onto (x, y)? Larn walks floor, doors, stairs and
 *  features (they prompt; the prompt table declines) and onto items; not
 *  into walls, known traps, monsters (that is a fight, chosen on purpose)
 *  or the unseen. The breach step (decide() 5b) is the one place that steps
 *  onto a known trap anyway. */
export function passable(model: LarnBotModel, x: number, y: number): boolean {
  if (x < 0 || x >= model.map.cols || y < 0 || y >= model.map.rows) return false;
  const c = model.map.at(x, y);
  if (c.hero) return true;
  if (c.category === "item") return c.terrain?.category !== "trap";
  if (c.category === "being") return false;
  if (!TERRAIN_CATEGORIES.has(c.category)) return false;
  return c.category !== "wall" && c.category !== "trap";
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
      if (!passable(model, x, y)) break;
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
 *  It can never seal a level: the breach steps (decide() 5 and 5b) ask this
 *  nothing, so a hero who can reach nothing else still crosses. */
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

const MOVE_INTENTS = new Set(["explore", "descend", "breach", "wander", "shuffle"]);

export class LarnBrain {
  private tuning: PolicyTuning;
  private blocked = new Set<number>();
  // -1, not 0: the first decide() then resets a brain that has nothing to
  // reset, rather than skipping the reset for the level it started on.
  private lastEpoch = -1;
  private lastPos = -1;
  private lastIntent = "";
  private lastStep = -1;
  private stuck = 0;
  private rests = 0;
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

  /** Knobs `tuning` does not name keep their DEFAULT_TUNING value. */
  constructor(tuning: Partial<PolicyTuning> = {}) { this.tuning = { ...DEFAULT_TUNING, ...tuning }; }

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
      readyForShaft: readyToDescend(model, true, this.tuning),
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
    if (!this.tuning.castAtRange) return null;
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
    if (this.wieldSpent >= this.tuning.wieldProbes) return null;

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
    }
    if (this.lastPos !== -1 && chebyshev(model.map.cols, this.lastPos, here) > 3) {
      this.blocked.clear(); this.stuck = 0; this.wanderTarget = -1;
    }
    // Anti-stuck: a move that did not move us marks the cell it aimed at —
    // unless that cell still shows a CLOSED door, which is not a refusal
    // about terrain at all. See closedDoor() below.
    if (MOVE_INTENTS.has(this.lastIntent)) {
      if (here === this.lastPos) {
        if (!closedDoor(model, this.lastStep)) {
          if (++this.stuck >= this.tuning.stuckLimit && this.lastStep !== -1) { this.blocked.add(this.lastStep); this.stuck = 0; }
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
    // 1. Fight an adjacent monster (walking into it attacks): the first in
    //    DIRS order. Standing next to a monster taking free hits is strictly
    //    worse than swinging, and a being the ladder would neither attack nor
    //    walk around is a wall across the corridor, because passable() treats
    //    it as one.
    for (const d of DIRS) {
      const c = model.map.at(hero.x + d.dx, hero.y + d.dy);
      if (c.category === "being" && !c.hero) return { key: movementKey(d.compass, false), intent: "fight" };
    }
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
    if (model.hpmax > 0 && model.hp < model.hpmax * this.tuning.restBelowHpFraction
        && !this.monsterVisible(model) && this.rests < this.tuning.restLimit) {
      this.rests++;
      return { key: STAY, intent: "rest" };
    }
    // 2b. Put the best weapon in hand. Beside the rest step rather than above
    //     the fight step: swapping costs a turn (vect-hack-h9x.6), and the
    //     step declines while anything is visible for exactly that reason.
    const wield = this.wieldStep(model);
    if (wield) return wield;
    const rules = { passable: (x: number, y: number) => passable(model, x, y), blocked: this.blocked };
    // 3. Explore the frontier. Pickup is automatic — lookforobject() runs on
    //    every move (main.c:291) and the prompt table answers "t" — so items
    //    are collected wherever exploring happens to walk; nothing routes to
    //    one.
    const explore = nextStep(model.map, hero, (x, y) => isFrontier(model.map, x, y, rules.passable), rules);
    if (explore) return this.walk(model, explore, "explore");
    // 4. Descend: walk onto the down stairs / the dungeon entrance; Larn
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
      return exit !== null && readyToDescend(model, exit.shaft, this.tuning);
    };
    if (isDown(hero.x, hero.y)) {
      for (const d of DIRS) {
        if (passable(model, hero.x + d.dx, hero.y + d.dy)) {
          this.lastStep = posKey(model.map, hero.x + d.dx, hero.y + d.dy);
          return { key: movementKey(d.compass, false), intent: "shuffle" };
        }
      }
    }
    const down = nextStep(model.map, hero, isDown, rules);
    if (down) return this.walk(model, down, "descend");
    // 5. Breach: nothing left to explore and no staircase to walk to, but a
    //    being borders the reachable region. passable() treats a being as
    //    impassable and must — walking into one is an attack, not a step — so
    //    a monster standing in the only corridor seals the hero into a pocket
    //    that exploration and descent can both see past and neither can cross.
    //    The ladder then circles it until the command cap: seed 565999359
    //    reached 24000 commands on depth 1 at full HP with 20 of 1139 cells
    //    reachable, the region bounded by 103 walls and three monsters
    //    (vect-hack-b5f.5). Route to a cell beside one and let step 1 have the
    //    fight; nothing else in the ladder ever chooses to remove that wall.
    const breach = nextStep(model.map, hero, (x, y) => bordersBeing(model, x, y), rules);
    if (breach) return this.walk(model, breach, "breach");
    // 5b. The seal is not always a monster. passable() also refuses a known
    //     trap, so a trap in the only corridor closes a level exactly the same
    //     way: held-out seed 238386701 reached the 24000-command cap with 2 of
    //     1139 cells reachable, the region bounded by 13 walls and one trap.
    //     Crossing it is a real cost; staying sealed in is a certain loss, so
    //     the ladder pays it once nothing else is reachable.
    const throughSeal = {
      passable: (x: number, y: number) => passable(model, x, y) || knownTrap(model, x, y),
      blocked: this.blocked,
    };
    //     Readiness is dropped here too: this step fires only when nothing
    //     else is reachable, and a hero sealed into a pocket whose one exit is
    //     a shaft it is not ready for must still take it. A certain loss now
    //     beats a bar that was only ever a preference (vect-hack-h9x.5).
    const sealed = nextStep(
      model.map, hero,
      (x, y) => downExit(model, x, y) !== null || isFrontier(model.map, x, y, throughSeal.passable),
      throughSeal,
    );
    if (sealed) return this.walk(model, sealed, "breach");
    // 6. Wander to the farthest reachable cell (a fresh view of a done level).
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

/** Is (x, y) next to a being? Step 1 attacks whatever is adjacent, so a cell
 *  beside one is where the breach step hands a sealing monster to the fight. */
function bordersBeing(model: LarnBotModel, x: number, y: number): boolean {
  for (const d of DIRS) {
    const c = model.map.at(x + d.dx, y + d.dy);
    if (c.category === "being" && !c.hero) return true;
  }
  return false;
}

function chebyshev(cols: number, a: number, b: number): number {
  return Math.max(Math.abs((a % cols) - (b % cols)), Math.abs(((a / cols) | 0) - ((b / cols) | 0)));
}
