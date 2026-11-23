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
 * applies to their sum. Every second of that sum is a frame-rate sample, but
 * not every second is watched for stalls: the check arms START_MS into each
 * game (see stallWatch). A hang is still caught: a game ends only on one of the
 * engine's own end tells, a hung engine sends none, so its game is not
 * restarted; it spends its budget, the check arms and fires. A quiet gap
 * inside a game that ends before START_MS is not caught: that game is never
 * watched, and a run of short games watches less of its play. The report says
 * how much was watched next to the worst stall.
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
 * The stall check's state over a run: the longest stretch with no map batch
 * (`worstMs`), how long the check was armed (`watchedMs`), and the current
 * stretch. A worst stall of 0 s means nothing unless something was watched.
 */
export function stallWatch() {
  return { worstMs: 0, watchedMs: 0, stalledFor: 0 };
}

/**
 * One sample of one game. `armed` is the gate's rule (the game is START_MS
 * old), `quiet` that no map batch arrived since the last sample. An unarmed
 * sample resets the stretch rather than leaving it unrecorded, or birth-time
 * quiet leaks across the boundary and reports a stall on a healthy run; every
 * game opens unarmed, so no stretch runs from one game into the next.
 */
export function watchSample(watch, armed, quiet, sampleMs) {
  watch.stalledFor = armed && quiet ? watch.stalledFor + sampleMs : 0;
  if (!armed) return;
  watch.watchedMs += sampleMs;
  watch.worstMs = Math.max(watch.worstMs, watch.stalledFor);
}

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
