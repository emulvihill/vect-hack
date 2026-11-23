// The borg gate's play accounting, tested where the gate itself cannot be: it
// needs a GPU and a dev server, so `npm test` never runs it (vect-hack-t4ja).
//
// The bead's red: the borg's character died after 9 s, or 85 s, and the gate
// failed for that alone — a verdict about Angband's dice, not the renderer. An
// ended game now starts another, and the verdict rests on the play measured
// across all of them. `playGames` takes the one real game as a parameter, so
// these fakes stand in for a page and a borg.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_GAMES, MIN_PLAY_MS, playGames, playProblems, stallWatch, watchSample,
} from "../../browser-check/angband-borg-gate-utils.mjs";

const GATE_MS = 600000;
const DIED = { tell: "You die." };

/** A fake game per entry, in order: `ms` of play, ended or not. Past the list,
 *  every game plays out whatever budget it is given. */
function games(script: { ms: number; ended: boolean }[]) {
  const budgets: number[] = [];
  const playGame = async (budgetMs: number) => {
    const next = script[budgets.length] ?? { ms: budgetMs, ended: false };
    budgets.push(budgetMs);
    return { playedMs: next.ms, ended: next.ended ? DIED : null };
  };
  return { playGame, budgets };
}

describe("the borg gate's games", () => {
  it("starts another game when one ends, and adds their play up", async () => {
    const fake = games([{ ms: 9000, ended: true }, { ms: 85000, ended: true }]);
    const run = await playGames(fake.playGame, GATE_MS);
    expect(run.games.length).toBe(3);
    expect(run.playedMs).toBe(GATE_MS);
    // Each game is handed what is left of the gate's play, not a fresh window.
    expect(fake.budgets).toEqual([GATE_MS, GATE_MS - 9000, GATE_MS - 94000]);
  });

  it("never fails a run for a game that ended early", async () => {
    const run = await playGames(games([{ ms: 9000, ended: true }]).playGame, GATE_MS);
    expect(run.games[0].ended).toEqual(DIED);
    expect(playProblems(run)).toEqual([]);
  });

  it("does not restart a game that stopped without an end", async () => {
    // A hang or an engine notice is the gate's business, not the dice's: the
    // run stops there and the gate reports it, rather than burying it under a
    // fresh game.
    const run = await playGames(games([{ ms: 30000, ended: false }]).playGame, GATE_MS);
    expect(run.games.length).toBe(1);
    expect(playProblems(run)[0]).toMatch(/only 30s of play measured over 1 game,/);
  });

  it("stops at the cap on games, and says what it measured", async () => {
    // A build whose every game ends at once must not start games for ever.
    const fake = games(Array.from({ length: 100 }, () => ({ ms: 1000, ended: true })));
    const run = await playGames(fake.playGame, GATE_MS);
    expect(run.games.length).toBe(MAX_GAMES);
    expect(playProblems(run)).toEqual([
      `only ${MAX_GAMES}s of play measured over ${MAX_GAMES} games, the most one run may start;`
        + ` this gate needs ${MIN_PLAY_MS / 1000}s`,
    ]);
  });

  it("gives a verdict at the cap when the capped games measured enough", async () => {
    // The shortest death seen, every game: the cap still leaves enough play.
    const run = await playGames(games(Array.from({ length: 100 }, () => ({ ms: 9000, ended: true }))).playGame, GATE_MS);
    expect(run.games.length).toBe(MAX_GAMES);
    expect(playProblems(run)).toEqual([]);
  });
});

describe("the borg gate's stall watch", () => {
  it("counts only the time the check was armed, summed over games", () => {
    // The check arms START_MS into each game. A game that ends before that is
    // never watched, and the report must say so rather than print a bare
    // "worst stall 0s" as though it had looked.
    const watch = stallWatch();
    const sample = (armed: boolean, quiet: boolean) => watchSample(watch, armed, quiet, 1000);
    for (let s = 0; s < 50; s++) sample(false, true); // game 1: died at 50 s
    expect(watch).toMatchObject({ worstMs: 0, watchedMs: 0 });
    for (let s = 0; s < 60; s++) sample(false, s % 2 === 0); // game 2: warm-up
    for (let s = 0; s < 30; s++) sample(true, s >= 10 && s < 15); // then 30 s watched, 5 s quiet
    expect(watch).toMatchObject({ worstMs: 5000, watchedMs: 30000 });
  });

  it("starts every game's stall count from zero", () => {
    // A game always opens unarmed, which resets the count: quiet at the end of
    // one game and the start of the next is not one stall.
    const watch = stallWatch();
    for (let s = 0; s < 20; s++) watchSample(watch, true, true, 1000);
    watchSample(watch, false, true, 1000);
    for (let s = 0; s < 20; s++) watchSample(watch, true, true, 1000);
    expect(watch).toMatchObject({ worstMs: 20000, watchedMs: 40000 });
  });
});

describe("the borg gate script", () => {
  const source = readFileSync(new URL("../../browser-check/angband-borg-check.mjs", import.meta.url), "utf8");

  it("plays its games through playGames and judges their play with playProblems", () => {
    // Correct accounting the gate never calls would pass the half above and
    // fail the nightly run exactly as before.
    expect(source).toMatch(/await playGames\(playGame, GATE_MS\)/);
    expect(source).toMatch(/playProblems\(run\)/);
  });
});
