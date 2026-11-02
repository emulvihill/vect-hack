// The run digest: everything reflection is allowed to see about one finished
// game (spec: docs/specs/2026-08-19-bot-phase1b-larn-reflect-
// design.md, "The digest"). Game-free — each Module builds its own from its
// trajectory and summary (Larn: src/modules/larn/bot/digest.ts).
//
// This shape is the enforceable boundary of the black-box rule, so every field
// has to answer one question: did the game's own screen show it? The 1a status
// tap already holds itself to that discipline upstream — it exports "LV: ?" as
// an unknown depth, conditions as presence rather than countdowns, and the
// rounded mobul clock rather than raw gltime — and a digest that reached around
// it for raw engine state, an unidentified item's true type or a monster's
// identity beyond the glyph and colour drawn would make everything learned
// downstream unattributable. Adding a field here means making that argument.
//
// The lists are capped rather than complete: a batch of reflections has to stay
// cheap, and the builder truncates to fit rather than emitting an oversized
// prompt.
//
// Beside the shape, this file answers one derived question: which subjects a
// run may ground a policy claim on at all (runGrounds, at the bottom). It is
// derived here rather than in either consumer because BOTH read it — the
// prompt offers those subjects and the applier accepts those subjects — and a
// second implementation of the rule would let the two disagree.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).

/** One level transition, keyed by the exit the hero was standing on when the
 *  descent was answered — NOT the cell they landed on. Larn draws its four
 *  downward exits as four different characters (`%` staircase, `^` down
 *  elevator, `E` dungeon entrance, `V` volcanic shaft; objnamelist,
 *  external/larn/data.c:179), and the classifier carries that character
 *  through to the Cell, so the shaft is distinguishable from a staircase here
 *  even though the exporter collapses all four to KIND_DOWN. Without this
 *  field a model can see that the bot died at depth 11 and nothing about how
 *  it got there. `kind` is "" for a fall the hero did not choose — a trap door
 *  showed the screen nothing but floor, and inventing an exit would be a lie. */
export interface DescentTaken {
  /** The classified terrain category of that exit, so the `avoid-terrain`
   *  claim key — `"<category>:<ch>"`, the key `passable()` reads — can be
   *  derived from a descent without anyone guessing at it (vect-hack-b5f.6).
   *  It is the same classified underlay `finalTerrain` already publishes,
   *  sampled at the moment the level changed rather than at a later frame, so
   *  it shows nothing the digest was not already showing.
   *
   *  It is what the SCREEN DREW, never the hidden thing underneath: a hero
   *  who falls through an undiscovered trap door was standing on drawn floor,
   *  and this says `floor`. That is what keeps an unchosen fall out of
   *  AVOIDABLE_CATEGORIES — see runGrounds. */
  category: string;
  ch: string;
  kind: string;
  fromDepth: number;
  toDepth: number;
  xlevel: number;
  /** What the hero could take when they stepped onto this exit: hit points
   *  and the ceiling they were measured against, read from the same status
   *  line that reported the new depth. An exit is not dangerous or safe on its
   *  own — the volcanic shaft is lethal to a 10-hp character and ordinary to a
   *  large one — so the capacity at the moment of the choice is what makes a
   *  learned avoidance a threshold rather than a veto (vect-hack-b5f.17). */
  hp: number;
  hpmax: number;
  atCommand: number;
}

/** A being next to the hero at a command boundary: the glyph and colour the
 *  screen drew, never a monster identity. The killer is usually standing next
 *  to the corpse. */
export interface AdjacentBeing {
  ch: string;
  color: number;
  atCommand: number;
}

/** The terrain under the hero at a command boundary. */
export interface TerrainStep {
  category: string;
  ch: string;
  kind: string;
  atCommand: number;
}

/** The being that landed the fatal blow, as the screen drew it — the join
 *  between `cause` and `finalAdjacent` that the digest could not make for
 *  itself (vect-hack-b5f.4). `cause` names the killer in prose ("killed by a
 *  giant ant") and `finalAdjacent` lists glyphs; with nothing tying the two, a
 *  reflecting model reads adjacency as causation and blames whatever stood
 *  nearby. Measured on the 2026-08-21 training batch: 5 of 38 earned threat
 *  facts named a bystander, one of them on a run an arrow trap killed, where
 *  no being was responsible at all.
 *
 *  **Why this is inside the black-box rule.** The engine supplies only which
 *  of the beings ALREADY IN `finalAdjacent` struck the blow; the builder
 *  publishes a killer only when that glyph was drawn beside the hero in the
 *  final frames. No monster name, no identity, and no glyph the screen did not
 *  show reaches the digest — a killer the player never saw (blind, invisible,
 *  killed from off-screen) comes out null, and so does a death no being
 *  caused. What is new is the attribution among things already shown, which is
 *  what the message log gives a human player and what the digest was missing.
 *
 *  This is the narrow reading, and it was contested: an adversarial review
 *  argued that any native join is out of bounds however it is fenced, because
 *  the screen never drew the sentence "this glyph is the one the epitaph
 *  names" (docs/DECISIONS.md, 2026-08-21). The alternative on the table was to
 *  drop per-being threat claims outright.
 *
 *  null is the honest majority case, and every reader must treat it as "this
 *  run may teach nothing about any being": a survived, capped or won run, a
 *  death no being caused, a killer never drawn, and a trajectory recorded
 *  before the engine reported this all arrive here the same way. */
export interface KillerSighting extends AdjacentBeing {
  /** The most the hero was seen holding while this being stood beside them,
   *  within its final engagement — or null when the screen never showed a
   *  living reading there. This is the instant a threat's value is measured
   *  at, and the instant is the whole question (vect-hack-b5f.20): nearly
   *  every Larn melee death is a multi-blow grind, so the last reading before
   *  the fatal blow says only what the finisher finished, and a being that
   *  beat a full-health hero down over several blows would read as one that
   *  kills the already-dying. An engagement is adjacency with gaps of at most
   *  two commands — a hero who backs off a cell and is pursued is still in
   *  the same fight — reset on a level change, because the beings drawn on
   *  the new level are different individuals under the same glyph. The peak
   *  rather than the engagement's first reading, because a hero who heals
   *  mid-fight and still dies was beaten at the healed capacity. Both numbers
   *  are screen readings from the same status line, so the pair stays inside
   *  the black-box rule. */
  capacity: { hp: number; hpmax: number } | null;
}

export interface RunDigest {
  game: string;
  seed: number;
  outcome: string;
  cause: string;
  depth: number;
  xlevel: number;
  hp: number;
  hpmax: number;
  /** The last hit points the screen showed while the hero was still alive,
   *  or null if none were ever seen. `hp` above is the end-of-game number and
   *  a death drives it to zero or below, which says how the run ended and
   *  nothing about what the hero could take going into it. Context, not the
   *  threat measurement: a threat is measured against `killer.capacity`, the
   *  fight's peak, because this reading is only what the fatal blow finished
   *  (vect-hack-b5f.20). */
  hpBeforeDeath: number | null;
  commands: number;
  mobulsElapsed: number;
  lastMessages: string[];
  /** Beings next to the hero over the last frames. */
  finalAdjacent: AdjacentBeing[];
  /** Which of them killed the hero, or null. Always one of `finalAdjacent`. */
  killer: KillerSighting | null;
  /** Terrain the hero stood on over the last frames. */
  finalTerrain: TerrainStep[];
  /** Every level transition, exit char included. */
  descents: DescentTaken[];
}

export const DIGEST_LIMITS = { messages: 10, adjacent: 12, terrain: 12, descents: 20 } as const;

/** Terrain categories an `avoid-terrain` claim may name.
 *
 *  A route is made of ground. Floor, corridor and doorways are the cells every
 *  path runs through, so a table row saying "avoid the floor" does not make
 *  the bot careful — it makes the consumer's passability test false everywhere
 *  and the level unwalkable. A wall is refused already, so naming one states
 *  nothing. What is left is terrain a route can decline and still be a route:
 *  the exits, the hazards, the fixtures.
 *
 *  This is the game-free half of the argument, which is why it lives here.
 *  Whether a particular avoidance is WISE is the A/B's question; whether it
 *  can be honoured at all is this one's. */
export const AVOIDABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "stairs", "trap", "water", "lava", "feature",
]);

/** The being a `threat` claim from this run may name. */
export interface KillerIdentity {
  ch: string;
  color: number;
}

/** What this one run may ground a policy claim on.
 *
 *  Two consumers read it and they must not drift: the prompt offers exactly
 *  these subjects (reflect.ts) and the applier accepts exactly these subjects
 *  (factDelta.ts). One derivation, from the digest, so a subject the model was
 *  invited to claim cannot be one the applier then rejects.
 *
 *  **Exits the hero chose — not ground they happened to be standing on.**
 *  `finalTerrain` says where the hero was in the last frames, which is not
 *  evidence about the ground: a hero dies on the floor of the room the fight
 *  was in. A descent is the other thing entirely — the hero stepped onto that
 *  exit and the run shows where it put them. So `descents` is the whole source
 *  of terrain subjects, and `stairs:V` — the volcanic shaft that drops a
 *  level-1 hero into the volcano — is the case this exists for.
 *
 *  A fall the hero did not choose grounds nothing, and needs no rule of its
 *  own: a trap door the screen never drew reports the floor it drew instead,
 *  and `floor` is not in AVOIDABLE_CATEGORIES. A trap the screen DID draw
 *  stays admissible, because stepping onto a drawn trap was a decision. */
export interface RunGrounds {
  killer: KillerIdentity | null;
  /** The `{category, ch}` pairs an `avoid-terrain` claim may name, in the
   *  order the hero met them, deduplicated — each with the capacity the hero
   *  had when they took it. `power` is what the applier turns into the
   *  threshold on the fact; the model is never asked for one. */
  terrain: { category: string; ch: string; power: number }[];
  /** What the killer beat: the most the hero was seen holding during the
   *  killer's final engagement, over the ceiling it was measured against, in
   *  0..1 — or null when the run named no killer or the screen never showed a
   *  live hp while it stood there. This is the number a threat's value is
   *  raised to — a being that beat a hero from full health is worth more than
   *  one that finished a dying one, however low the reading the fatal blow
   *  itself landed on (vect-hack-b5f.20). */
  killedAtCapacity: number | null;
}

export function runGrounds(d: RunDigest): RunGrounds {
  const terrain: { category: string; ch: string; power: number }[] = [];
  const seen = new Set<string>();
  for (const step of d.descents) {
    if (step.ch === "" || !AVOIDABLE_CATEGORIES.has(step.category)) continue;
    const key = terrainKey(step);
    if (seen.has(key)) continue;
    seen.add(key);
    // The ceiling, not the current reading: an exit's threshold is a claim
    // about the size of character it needs, and how hurt that character
    // happened to be on the way in is the ladder's business (it rests), not
    // the knowledge base's.
    terrain.push({ category: step.category, ch: step.ch, power: step.hpmax });
  }
  return {
    killer: d.killer === null ? null : { ch: d.killer.ch, color: d.killer.color },
    terrain,
    killedAtCapacity: capacityAtDeath(d),
  };
}

/** The hp fraction the killer's final engagement beat, or null when this run
 *  cannot say. Null for a run with no killer — nothing died to a being — and
 *  for one whose screen never showed a live hp during that engagement,
 *  because a capacity nobody observed must not be invented as 0, which would
 *  read as "this being kills only the already-dying". Read from the killer's
 *  own engagement rather than from `hpBeforeDeath`: the last living reading
 *  is what the fatal blow finished, not what the fight began with
 *  (vect-hack-b5f.20). */
function capacityAtDeath(d: RunDigest): number | null {
  const c = d.killer?.capacity ?? null;
  if (c === null || c.hpmax <= 0) return null;
  return Math.max(0, Math.min(1, c.hp / c.hpmax));
}

/** The key the compiled avoid table is read by, and the one thing that must
 *  agree between a claim, a subject and the consumer's lookup. */
export function terrainKey(t: { category: string; ch: string }): string {
  return `${t.category}:${t.ch}`;
}
