// The pure half of the borg gate (angband-borg-check.mjs): how many games a run
// plays and whether their play adds up to a verdict. Split out for the same
// reason fp-gate-utils.mjs was: a gate script does its work at import time, so
// nothing inside one can be unit tested.
// scripts/test/tooling/angband-borg-gate.test.ts is what tests this file.

/**
 * How much play, summed over every game of a run, the gate's verdict must rest
 * on. Fixed before the death times were measured (pre-registered,
 * vect-hack-zt7), from the gate's own constants: START_MS (60 s) of warm-up,
 * during which a stall is not counted, and 60 one-second samples beyond it —
 * enough for the p05 the gate reports to be a percentile rather than a synonym
 * for the single worst sample.
 *
 * It used to be the floor for ONE game, so a borg that died at 9 s failed the
 * run (vect-hack-t4ja). A death is Angband working correctly, and it says
 * nothing about the client, so an ended game now starts another and the floor
 * applies to their sum. Every second of that sum is a frame-rate sample; the
 * warm-up is per game, so a run of short games arms the stall check for less
 * of it. That forgives no stall: a game ends only on one of the engine's own
 * end tells, a hung engine sends none, and so a hang is never restarted — it
 * is sampled until the stall check fires.
 *
 * Without this floor the gate could not fail: a run whose games all ended at
 * once would measure nothing and still pass, and an assertion that cannot fail
 * is worse than no assertion (vect-hack-azf).
 */
export const MIN_PLAY_MS = 120000;

/**
 * The most games one run may start: the bounded stop for a build whose every
 * game ends at once. Twenty of the shortest game seen so far (9 s) still
 * measure 180 s, past MIN_PLAY_MS, so dice alone do not reach it.
 */
export const MAX_GAMES = 20;

/**
 * Play games until `gateMs` of play has been measured or `maxGames` have been
 * started. `playGame(budgetMs)` plays one game on a fresh page for at most
 * `budgetMs` of play and resolves `{ playedMs, ended }`, where `ended` is the
 * end tell it saw, or null. Only an ended game is a reason to start another:
 * one that stopped any other way (its budget spent, an engine notice, a page
 * error) is the last of the run.
 */
export async function playGames(playGame, gateMs, maxGames = MAX_GAMES) {
  const games = [];
  let playedMs = 0;
  while (playedMs < gateMs && games.length < maxGames) {
    const game = await playGame(gateMs - playedMs);
    games.push(game);
    playedMs += game.playedMs;
    if (!game.ended) break;
  }
  return { games, playedMs };
}

/** The run's one problem with its play, if any: too little of it to judge. */
export function playProblems({ games, playedMs }, maxGames = MAX_GAMES) {
  if (playedMs >= MIN_PLAY_MS) return [];
  const n = games.length;
  return [`only ${(playedMs / 1000).toFixed(0)}s of play measured over ${n} game${n === 1 ? "" : "s"}`
    + `${n >= maxGames ? ", the most one run may start;" : ","} this gate needs ${MIN_PLAY_MS / 1000}s`];
}
