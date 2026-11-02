# Larn bench: the number Phase 2 is read against

Bead: vect-hack-h9x.1. Parent: vect-hack-h9x.
Written 2026-08-28, **before** the first bench run, per the Measurement rule in
`~/AGENTS.md` ("write the verdict before the run").

## Why score cannot be the objective

Larn's own score is dominated by gold and the end-of-game bonus (`scores.c`),
not by depth or experience. It is also absent from a run the harness cut short,
which is why `kb-ab-report.mjs` drops capped pairs. Eric's stated goal is "reach
the Eye, or get as deep as possible while gaining as much experience as
possible". Score does not measure that.

## The misleading number this replaces

`RunSnapshot.depth` is `maxDepth`: the largest level number the status tap ever
showed. Larn's `levelname[]` (`data.c`) is `" H"`, `" 1".." 9"`, `"10"`,
`"V1".."V3"` — internal 0, 1-10, 11-13. The town holds a volcanic shaft that
drops straight to internal 11, bypassing the entire dungeon chain
(`create.c:396-410`).

So a hero who steps into the shaft on command 3 and dies on command 19 scores
`depth 11`, and a hero who fought down five staircases scores `depth 5`. The
pooled median over the 1000-game batch `.gym/bughunt-01` is **5** — a number
that describes neither population. Every report to date has quoted it.

## The metrics

Read over a whole batch, never per run.

**Co-primary.** Both must be reported; a change is an improvement only if it
raises one without lowering the other beyond the noise band below.

- `dungeonDepthMedian` — median over the batch of the deepest **dungeon-chain**
  level reached (internal 0-10). A shaft ride contributes the dungeon depth the
  hero actually walked, which for a rider who never took a staircase is 0.
- `xlevelMedian` — median experience level reached.

**Reported, never primary.** These explain a move in the co-primaries; none of
them decides anything on its own.

- `volcanoDepthMedian` / `volcanoDepthMax` — deepest volcano-chain level (11-13).
- `shaftRideRate` — fraction of runs that ever stood on internal >= 11.
- `dungeonDepthMax` — deepest dungeon level any run reached. The Eye is at 10.
- `commandsMedian` — the mechanism variable: survival time.
- `scoreMedian` — kept because it is continuous and moves before a win rate does.
- The outcome histogram, `died`/`won`/`capped`/`timeout`/`fatal`.

`fatal` and `timeout` are harness artifacts and are excluded from every metric,
but a batch with **any** fatal is not a valid bench run: it is a bug report.

## The seed sets

Frozen constants, committed in `scripts/dev/bench-larn.mjs`. Two runs a week
apart are comparable only because these never move.

| Set | Master | Games | Purpose |
|---|---|---|---|
| bench | `20260828` | 500 | Iterating. Run it as often as you like. |
| held-out | `20260829` | 500 | Deciding. Run it once per shipped change. |

The wall between them is the runbook's, not the code's — nothing stops a
reflection pass or a policy search from reading held-out seeds, and nothing
ever will. If a change was tuned against the held-out set, that set is burned
and this spec must be amended with a new master.

`--kb none` is the default arm. A bench run under a knowledge base must name it,
and the artifact records the hash, because a row that cannot say what the bot
knew is not evidence about knowing it.

## Wall-clock budget

Timed from one unit, not inherited (AGENTS.md: a stale per-item cost makes a
slow batch look hung). The 1000-game `.gym/bughunt-01` batch at `--parallel 8`
took **9m50s** wall — 0.59 s/game. A 500-game bench at `--parallel 16` on 24
cores should land near **2-3 minutes**; the bench prints its own elapsed time
and the first run's figure is recorded in the artifact.

Budget for growth: a bot that survives 10x longer costs roughly 10x the wall
clock. If a bench run ever exceeds **15 minutes**, cut the cohort and amend this
spec rather than quietly waiting.

## The decision rule, pre-registered

A Phase 2 change ships only if, on the **held-out** set, all three hold:

1. `dungeonDepthMedian` rises by **>= 1 whole level**, or holds while
   `xlevelMedian` rises by **>= 1**.
2. Neither co-primary falls at all.
3. `fatal == 0` and `timeout == 0`.

Medians over 500 games of a heavy-tailed metric are noisy, so the paired test in
`src/bot/abReport.ts` remains the arbiter where a paired comparison is possible
(same seed, both arms). The rule above is the screen; the paired report is the
verdict. Note that vect-hack-h9x.2 is open against that report's tie-poisoned
pooled median — until it is fixed, a tie-heavy comparison is read with
suspicion and the raw pair CSV is inspected by hand.

## The baseline

Filled in by the first `npm run bench:larn` run on this spec's own seed sets,
and never edited afterwards. Every later change is read against these numbers.

<!-- BASELINE START -->
`npm run bench:larn`, 2026-08-28, master 20260828, 500 games, `--kb none`,
`--max-commands 3000`, `--parallel 16`. Played in **47.2 s**.

```
games 500 (500 played) — died 483, capped 17
  CO-PRIMARY  dungeon depth median 0   xlevel median 1
  reported    dungeon max 5 · volcano median 11 max 12
              shaft rides 50.6% · commands median 54.5
              score median 42 (over 483 scored runs)
```

Artifact: `.gym/bench-bench/bench.json`.

**Read the co-primary out loud.** The median Larn game this bot plays never
walks a single dungeon level. Half of them (50.6%) step into the town's
volcanic shaft and die; most of the rest die on the town level or on dungeon
level 1. The deepest dungeon level any of 500 games reached is 5, and the Eye
is at 10.

That "0" is the number Phase 2 exists to move, and it is the number the old
pooled `depth` column reported as **5** on the same population.

`volcanoDepthMedian` is taken over every played run, not over the riders only —
a non-rider contributes 0 — so a median of 11 is another way of saying that
more than half the batch rode the shaft.
<!-- BASELINE END -->

For context, the pre-existing 2026-08-24 figures over 200 games (master
20260825, `.gym/timing-probe`) that this bench supersedes: 48% shaft rides
dying in a median of 19 commands, surface runs at median depth 2 and xlevel 2,
deepest staircase level ever reached 5.

## Amendment, same day: the co-primary is a median of a small integer

Measured after the first two treatments were judged by this spec, and recorded
here because it is a limitation of the instrument rather than of either
treatment.

Dungeon depth runs 0 to 6. A median of a small integer over 500 games is a very
coarse reading: a change can help a hundred seeds by a level each and leave the
median exactly where it was. Both verbs measured under this spec did precisely
that. Paired seed by seed, control against treatment on the same 500 held-out
seeds:

| | up | down | tied | mean delta | sign test |
|---|---:|---:|---:|---:|---:|
| cast, dungeon depth | 98 | 76 | **326** | +0.080 | p = 0.095 |
| cast, xlevel | 90 | 77 | 333 | +0.052 | p = 0.314 |
| wield, dungeon depth | 98 | 84 | **318** | +0.050 | p = 0.299 |
| wield, xlevel | 86 | 85 | 329 | +0.026 | p = 0.939 |

Two thirds of every comparison is an exact tie. Neither verb reaches
significance and neither ships — the decisions under the pre-registered rule
stand, and these numbers do not overturn them. But "the median did not move" was
never the same statement as "nothing happened", and this spec was written as
though it were.

**So the paired per-seed comparison is now a REQUIRED diagnostic** beside the
co-primaries in every Phase 2 report: up/down/tied counts, the mean delta, and a
sign test over the untied pairs. It does not become the ship rule — a
statistically detectable gain of 0.08 dungeon levels is not progress toward the
Eye, and goal-alignment is why the medians are primary. It is what stops a
report saying "no effect" when what it measured was "no effect this instrument
can see".

This is the same disease `vect-hack-h9x.2` already names on the A/B report's
pooled median — tie poisoning — arriving independently on the new bench. The
two should be fixed together.

## Acceptance

- This spec is committed before the first run. ✔ (that is this file)
- `npm run bench:larn` runs green, prints the metrics, and writes a
  machine-readable artifact.
- The depth metric distinguishes a shaft ride from a staircase descent, shown by
  a test that **fails on the old pooled `depth` column** and passes on the new
  pair.
