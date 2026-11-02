// What must match when the same seed is played twice, and nothing else.
//
// A scoreboard row cannot be compared whole: id embeds a timestamp and a pid,
// startedAt/endedAt are wall-clock, and event counts move with harness-only
// emissions (a status push added in a later task is not a gameplay change).
// The canonical record is the game — the seed it grew from, how it ended, and
// how far the bot got. Game-free: every engine's summary reduces the same way.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import type { RunSummary } from "./scoreboard.ts";

export interface CanonicalRecord {
  game: string;
  seed: number;
  outcome: string;
  depth: number;
  xlevel: number;
  hp: number;
  hpmax: number;
  commands: number;
  score: number;
  cause: string;
  /** The engine's last messages. Gameplay-derived and deterministic under a
   *  fixed seed, and the one field thin runs differ on: a command-capped game
   *  has no epitaph and barely moves depth, so without this two different
   *  dungeons reduce to the same record. Unlike `events` it does not move when
   *  the harness learns to emit a new event type. */
  lastMessages: string[];
}

export function canonicalRecord(s: RunSummary): CanonicalRecord {
  return {
    game: s.game, seed: s.seed, outcome: s.outcome, depth: s.depth, xlevel: s.xlevel,
    hp: s.hp, hpmax: s.hpmax, commands: s.commands, score: s.score ?? 0, cause: s.cause,
    lastMessages: s.lastMessages,
  };
}

/** One diffable line per game, seed first so a sorted file reads as a seed list. */
export function canonicalLine(s: RunSummary): string {
  const r = canonicalRecord(s);
  return [r.seed, r.game, r.outcome, r.depth, r.xlevel, r.hp, r.hpmax, r.commands, r.score,
    JSON.stringify(r.cause), JSON.stringify(r.lastMessages)].join(" ");
}
