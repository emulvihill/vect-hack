# The r4c evaluation: what the admitted-prior fact set does

Date: 2026-08-24. Beads: `vect-hack-b5f.23` (the decision this run follows),
`vect-hack-b5f.21` (the defect it expects to lose to). Predecessors:
`docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md` (the
measurement contract, unchanged), `2026-08-22-larn-fourth-learning-run.md`,
`docs/reports/2026-08-24-larn-r4-claude-brain.md`.

**This is a pre-registration, committed before either arm is played.**

## Why it is not the registered r4

The registered fourth run asks for 200 training games reflected under the local
Brain. This run played **100** games of that same training master `20260825`
under the **Claude** Brain, and then admitted a class of probe leak the
registered run would have refused (`vect-hack-b5f.23`, decided 2026-08-24). It
is a different experiment and is named `r4c` so no later reader can mistake it
for the registered one, which remains available to run as written.

**The registered held-out master `20260826` is deliberately NOT used here**, so
running r4 as registered later stays possible. This run uses a fresh master.

## Cohorts

| cohort | master | use |
| --- | --- | --- |
| training | `20260825` | 100 games, `--kb none`. Already played; reflection read these and only these. |
| held-out | `20260827` | 100 pairs, control `--kb none` vs treatment `--kb data/kb`. |

`20260827` is disjoint from `20260818`, `20260819`, `20260821`, `20260822`,
`20260823`, `20260824`, `20260825` and `20260826` over the first 5000 children
of each, checked before this document was committed.

**The wall.** No process may read a held-out trajectory except the metric
scripts. Nothing in code enforces it; it is enforced here and in the commands
recorded in the report.

## What is being evaluated

`data/kb`, 56 facts, tables hash `06e67de3`: 27 `threat`, 24 `note`,
5 `avoid-terrain`. The compiled avoid table, published before either arm exists:

| key | threshold | usable from | grounded by |
| --- | --- | --- | --- |
| `stairs:V` | 10 | `hpmax` 11 | 48 runs |
| `stairs:E` | 10 | `hpmax` 11 | 52 runs |
| `feature:P` | 10 | `hpmax` 11 | 2 runs |
| `trap:^` | 20 | `hpmax` 21 | 8 runs |
| `stairs:%` | 38 | `hpmax` 39 | 40 runs |

**Four of five probes admitted a `stairs:V` prior.** Under the b5f.23 decision
the terrain half of this table may rest on the model's knowledge of roguelikes
rather than on the bot's play. Whatever this A/B returns, it cannot separate
"the loop learned" from "the model was told" for any terrain claim.

## The prediction, written before the arms are played

`vect-hack-b5f.21` says this table is inverted: it walls the ordinary staircase
for every hero the bot grows into (`hpmax` 39 needed; the training batch topped
out at 43, and typical deaths are far below) while opening the volcanic shaft
the moment `hpmax` exceeds 10. **The expectation is therefore a LOSS**, and the
expected mechanism is surface-stratum runs detouring around `stairs:%`.

Recording the prediction is what makes the result informative either way: a
loss confirms b5f.21 in behaviour rather than in theory, and a win means the
mechanism is not what two independent readings said it was, which would be worth
more than the ship.

## The decision rule for shipping

Unchanged and quoted, so the verdict cannot be read against a rule written after
the numbers: the KB ships if the pooled median per-seed score delta is positive,
the win count exceeds the loss count, and the control-surface median depth delta
is at least zero. Strata are labelled by the control arm. Any seed capped in
either arm leaves the score statistic and the excluded count is reported.
`scripts/dev/kb-ab-report.mjs` is the only reading.

## The interim goal

Carried over unchanged from the registered r4, and reported whichever way it
lands: at least 25% of the treatment arm's shaft riders last >= 50 commands
after the drop, with a guard that at least 10 runs still ride it. Baseline is
0 of 54. `scripts/dev/larn-shaft-survival.mjs` is the only reading.

**Neither number ships the KB on its own.** The A/B rule above is the ship
decision; the survival target measures whether the loop is progressing.
