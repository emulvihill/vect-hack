// One finished Larn game reduced to its RunDigest — the only thing reflection
// sees (spec: 2026-08-19-bot-phase1b-larn-reflect-design.md, "The digest").
//
// The whole trajectory is replayed through a fresh LarnBotModel, so every
// observation here comes from the same public projection the bot itself played
// on: the classified map and the status tap, never engine state. Nothing is
// read that the screen did not draw.
//
// Three things are easy to get wrong and worth stating:
//
//   - The lines come off disk, where TrajectoryLog's `plainArrays` replacer
//     has already turned every typed array into a plain one. A `map` record
//     batch and a `status` record therefore have to be rebuilt as Int32Array /
//     Uint8Array before the model sees them; hand the plain arrays over and the
//     classifier decodes nothing and the digest comes out empty.
//   - A descent is attributed to the cell the hero stood on in the last frame
//     BEFORE the level changed, and it is detected on the status push that
//     reports the new depth. That is what makes the town's volcanic shaft
//     (`V`) distinguishable from an ordinary staircase (`%`) after the fact —
//     the single most learnable fact in the 1a baseline.
//   - Everything is sampled per FRAME, not per command boundary. The spec says
//     "over the final few frames" and means it: a death happens after the last
//     command, so a boundary-sampled digest is blank in the runs it most needs
//     to describe.
//
// All three were wrong in the first cut of this file and were caught only by
// running it against real recorded runs (vect-hack-b5f.2.2, fixtures under
// scripts/test/fixtures/reflect/batch/). None of the three timings is a
// detail:
//
//   - Detecting the change at the next command boundary loses the descent
//     entirely when the run ends on the new level, which is exactly the short
//     shaft death the phase is trying to learn from: fixture run 0002 dies at
//     depth 11 four commands in and never asks for another command. The status
//     push is the earliest and the only guaranteed sighting of a new depth.
//   - Reading the exit off the last command boundary names the wrong cell,
//     because stepping onto an exit is what raises Larn's own "Do you (c)
//     climb down" prompt: the frame showing the hero on the exit falls between
//     the last command and the prompt answer, so the last command boundary
//     still has the hero on the cell they came from. Fixture run 0001 read as
//     `$` (the bank they stepped off) instead of the `E` entrance they left
//     by. A wrong glyph is worse than none — it teaches the bot to route
//     around terrain that never hurt it.
//   - Sampling at boundaries left fixture run 0002 — killed by a xvart — with
//     no adjacent being recorded at all, because the frame showing the xvart
//     beside the hero is the last one the game ever drew. `threat` is one of
//     only three claim kinds the policy can act on and the killer's glyph is
//     its whole grounding, so that blindness lands where it costs most.
//
// A fall the hero did not choose keeps whatever the screen drew under them,
// and an exit the screen never drew records "" rather than a guess.
//
// ".ts" import extensions: a node host loads this straight from source.
import type { Cell } from "../../../backplane/cell.ts";
import { TERRAIN_CATEGORIES } from "../../../backplane/cell.ts";
import {
  DIGEST_LIMITS,
  type AdjacentBeing,
  type DescentTaken,
  type KillerSighting,
  type RunDigest,
  type TerrainStep,
} from "../../../bot/digest.ts";
import type { RunSummary } from "../../../bot/scoreboard.ts";
import type { LarnEvent } from "../protocol.ts";
import { LarnBotModel } from "./model.ts";

/** One trajectory line as TrajectoryLog wrote it (minus its sequence number). */
export interface TrajectoryLine {
  name: string;
  ev: unknown;
  reply: unknown;
}

const words = (v: unknown): Int32Array => new Int32Array((v ?? []) as ArrayLike<number>);
const bytes = (v: unknown): Uint8Array => new Uint8Array((v ?? []) as ArrayLike<number>);

/** A recorded line back into the event the worker posted. Only the two events
 *  carrying packed records need rebuilding; the rest are plain JSON already. */
function reviveEvent(name: string, ev: unknown): LarnEvent {
  const o = (ev ?? {}) as Record<string, unknown>;
  if (name === "map") return { name: "map", records: words(o.records) };
  if (name === "status") return { name: "status", record: words(o.record), names: bytes(o.names) };
  return { ...o, name } as LarnEvent;
}

/** Keep the last `cap` entries; the oldest falls off the front. */
function push<T>(ring: T[], item: T, cap: number): void {
  ring.push(item);
  if (ring.length > cap) ring.shift();
}

/** The ground under the hero, without a timestamp: one sighting can serve both
 *  a terrain step and a descent, which stamp it differently. */
interface HeroGround {
  category: string;
  ch: string;
  kind: string;
}

/** The terrain under the hero, or null when the screen has not drawn it. The
 *  hero glyph overwrites the grid cell, so the terrain is the underlay the
 *  classifier attached to it — and an underlay outside TERRAIN_CATEGORIES is
 *  no terrain at all, the same rule the Backplane's terrainOf() applies. A
 *  hero who just landed on an unlit cell is standing on something the screen
 *  has not shown; reporting the "unseen" placeholder as ground would put a NUL
 *  glyph in the digest and, worse, offer it as an exit. */
function heroTerrain(model: LarnBotModel): HeroGround | null {
  const at = model.map.hero;
  if (!at) return null;
  const cell = model.map.at(at.x, at.y);
  const under: Cell | undefined = TERRAIN_CATEGORIES.has(cell.category) ? cell : cell.terrain;
  if (!under || !TERRAIN_CATEGORIES.has(under.category)) return null;
  return { category: under.category, ch: under.ch, kind: under.kind ?? "" };
}

/** The beings in the eight cells around the hero — glyph and colour only. */
function heroAdjacent(model: LarnBotModel): AdjacentBeing[] {
  const at = model.map.hero;
  if (!at) return [];
  const out: AdjacentBeing[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const cell = model.map.at(at.x + dx, at.y + dy);
      if (cell.category === "being" && !cell.hero) {
        out.push({ ch: cell.ch, color: cell.color, atCommand: model.commands });
      }
    }
  }
  return out;
}

/** The killer, or null — the whole of the b5f.4 join, in one place.
 *
 *  Three gates, each of which the bug walked through:
 *
 *    - the run must have ENDED in a death. `death` events are emitted on
 *      entry to died(), which returns when life protection spends a charge,
 *      so a glyph can outlive the death it described. A capped, timed-out or
 *      won run has no killer whatever the last event said.
 *    - the engine must have named a being. A trap, poison, a quit and a
 *      creature the player never saw all report "".
 *    - the screen must have DRAWN that being beside the hero. This is what
 *      keeps the digest inside what the player saw: the engine says which of
 *      the sightings was fatal, and a glyph that never appeared in one is not
 *      a sighting to report. The last matching sighting wins — it is the one
 *      closest to the blow. */
function resolveKiller(outcome: string, ch: string, adjacent: AdjacentBeing[]): AdjacentBeing | null {
  if (outcome !== "died" || ch === "") return null;
  for (let i = adjacent.length - 1; i >= 0; i--) {
    if (adjacent[i]!.ch === ch) return { ...adjacent[i]! };
  }
  return null;
}

/** Commands a being may go unseen and still be in the same fight. A hero who
 *  backs off a cell and is pursued drops out of adjacency for a frame or a
 *  command; a streak that breaks there restarts the capacity measurement at
 *  the mid-fight reading, which is the degeneration vect-hack-b5f.20 exists
 *  to fix. Past two commands of absence the hero disengaged, and a later
 *  meeting with the same glyph is a different fight — possibly a different
 *  individual, which the glyph cannot distinguish. */
const ENGAGEMENT_GAP = 2;

/** One being's current engagement: the peak living reading seen while it
 *  stood beside the hero, and the command it was last seen at. */
interface Engagement {
  capacity: { hp: number; hpmax: number } | null;
  lastSeen: number;
}

/** The higher of two readings by hp fraction; a reading beats no reading. */
function peakReading(
  a: { hp: number; hpmax: number } | null,
  b: { hp: number; hpmax: number } | null,
): { hp: number; hpmax: number } | null {
  if (a === null) return b;
  if (b === null) return a;
  const frac = (c: { hp: number; hpmax: number }): number => (c.hpmax > 0 ? c.hp / c.hpmax : 0);
  return frac(b) > frac(a) ? b : a;
}

/** The killer with the capacity its final engagement beat attached — the
 *  streak map's entry for its key, which the most-recent-streak-wins rule
 *  in the build loop guarantees is the fatal fight and not an earlier
 *  meeting. */
function killerWithCapacity(
  sighting: AdjacentBeing | null,
  engagements: Map<string, Engagement>,
): KillerSighting | null {
  if (sighting === null) return null;
  return { ...sighting, capacity: engagements.get(`${sighting.ch}|${sighting.color}`)?.capacity ?? null };
}

export function buildLarnDigest(lines: Iterable<TrajectoryLine>, summary: RunSummary): RunDigest {
  const model = new LarnBotModel();
  const finalTerrain: TerrainStep[] = [];
  const finalAdjacent: AdjacentBeing[] = [];
  const descents: DescentTaken[] = [];
  /** The ground under the hero in the last frame that drew them. */
  let heroStep: HeroGround | null = null;
  /** heroStep as the level changed: the exit the hero left by. */
  let exitStep: HeroGround | null = null;
  /** The last depth the status line actually showed; null under TELEFLAG, so
   *  a level the screen refuses to name never reads as a transition. */
  let lastDepth: number | null = null;
  /** The glyph the last `death` event named, "" for none. A trajectory
   *  recorded before the engine reported this never sets it, which is the
   *  same answer as a death no being caused — see resolveKiller. */
  let deathCh = "";
  /** The last hit points the status line showed while they were still above
   *  zero. Larn's own death drives hp to zero or below and the summary keeps
   *  that number, so without this the digest can say how the run ended and
   *  not what the hero could take going into it (vect-hack-b5f.17). */
  let hpBeforeDeath: number | null = null;
  /** The ceiling that reading was measured against, from the same status
   *  line: hpmax can grow mid-run, so the pair has to travel together. */
  let livingHpmax: number | null = null;
  /** Each adjacent being's current engagement, keyed by `ch|color` — the
   *  most recent streak wins, which is what makes the killer's entry its
   *  FINAL fight rather than an earlier meeting with the same glyph
   *  (vect-hack-b5f.20). */
  const engagements = new Map<string, Engagement>();
  const livingReading = (): { hp: number; hpmax: number } | null =>
    hpBeforeDeath === null || livingHpmax === null ? null : { hp: hpBeforeDeath, hpmax: livingHpmax };

  for (const line of lines) {
    if (line.name === "getKey") {
      // Mirror LarnBotPlayer exactly: a non-blocking poll is answered with no
      // key at all, so it is neither a command boundary nor a spent prompt.
      // Nothing is sampled here — see the map branch for why.
      const { wait, cmd } = (line.ev ?? {}) as { wait?: boolean; cmd?: boolean };
      if (!wait) continue;
      model.keyAnswered(!!cmd);
      continue;
    }

    // A level event clears the grid, so the exit has to be taken from the
    // frame before it rather than looked up afterwards. It also ends every
    // engagement: the beings drawn on the new level are different individuals
    // under the same glyphs, and a town meeting must not ride into a dungeon
    // fight's capacity (vect-hack-b5f.20).
    if (line.name === "level") {
      exitStep = heroStep;
      heroStep = null;
      engagements.clear();
    }
    if (line.name === "death") deathCh = String((line.ev as { ch?: unknown })?.ch ?? "");
    model.observe(reviveEvent(line.name, line.ev));
    // Frames, not command boundaries. A death happens after the last command
    // by definition, so sampling at boundaries is blind in exactly the runs
    // the threat table is meant to be learned from: fixture run 0002's xvart
    // is adjacent in a frame no command ever follows, and its epitaph names
    // it. A model shown no monster either says nothing about one or says
    // something out of its own priors about Larn — which is the leak the probe
    // exists to reject, so half the fact model would arrive dead.
    if (line.name === "map") {
      heroStep = heroTerrain(model);
      if (heroStep) push(finalTerrain, { ...heroStep, atCommand: model.commands }, DIGEST_LIMITS.terrain);
      for (const being of heroAdjacent(model)) {
        push(finalAdjacent, being, DIGEST_LIMITS.adjacent);
        const key = `${being.ch}|${being.color}`;
        const fight = engagements.get(key);
        if (fight !== undefined && model.commands - fight.lastSeen <= ENGAGEMENT_GAP) {
          fight.lastSeen = model.commands;
          fight.capacity = peakReading(fight.capacity, livingReading());
        } else {
          engagements.set(key, { capacity: livingReading(), lastSeen: model.commands });
        }
      }
    }
    if (line.name === "status") {
      if (model.hp > 0) {
        hpBeforeDeath = model.hp;
        livingHpmax = model.hpmax;
        // The flush order is map first, status second, and an unchanged
        // status is suppressed — so a reading that changed alongside the
        // frame that opened an engagement arrives after the sighting. Raising
        // still-engaged fights here closes that seam; the peak ignores a
        // post-blow reading, which only ever came out lower.
        for (const fight of engagements.values()) {
          if (model.commands - fight.lastSeen <= ENGAGEMENT_GAP) {
            fight.capacity = peakReading(fight.capacity, livingReading());
          }
        }
      }
    }
    if (line.name === "status" && model.depth !== null) {
      if (lastDepth !== null && model.depth !== lastDepth) {
        push(descents, {
          // The classified underlay the screen drew under the hero, which is
          // what makes `stairs:V` derivable as an avoid-terrain key without
          // anyone assuming Larn's exits are stairs (vect-hack-b5f.6). An
          // undiscovered trap door reports the floor it drew, not the trap.
          category: exitStep?.category ?? "",
          ch: exitStep?.ch ?? "",
          kind: exitStep?.kind ?? "",
          fromDepth: lastDepth,
          toDepth: model.depth,
          xlevel: model.xlevel,
          // The last LIVING hit points, not the reading on this status line.
          // A hero who dies immediately after the drop — fixture run 0002 is
          // dead four commands in — has the death's own hp on the very line
          // that reports the new depth, and "-16 of 10" is not a capacity
          // anything was chosen with. hpmax is unaffected either way, which
          // is why the threshold is built from it.
          hp: hpBeforeDeath ?? model.hp,
          hpmax: model.hpmax,
          atCommand: model.commands,
        }, DIGEST_LIMITS.descents);
        // Spent: a later transition must name its own exit or none at all.
        exitStep = null;
      }
      lastDepth = model.depth;
    }
  }

  const larn = summary.details?.larn as { mobulsElapsed?: number } | undefined;
  return {
    game: summary.game,
    seed: summary.seed,
    outcome: summary.outcome,
    cause: summary.cause,
    depth: summary.depth,
    xlevel: summary.xlevel,
    hp: summary.hp,
    hpmax: summary.hpmax,
    hpBeforeDeath,
    commands: summary.commands,
    mobulsElapsed: larn?.mobulsElapsed ?? 0,
    lastMessages: summary.lastMessages.slice(-DIGEST_LIMITS.messages),
    finalAdjacent,
    killer: killerWithCapacity(resolveKiller(summary.outcome, deathCh, finalAdjacent), engagements),
    finalTerrain,
    descents,
  };
}
