# The second learning run: a fact set earned with the killer join in place

Date: 2026-08-21. Beads: `vect-hack-b5f.9`. Predecessors:
`docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md` (the
measurement contract, unchanged by this document),
`docs/specs/2026-08-21-larn-engagement-design.md`,
`docs/reports/2026-08-21-larn-engagement.md`.

This is a **pre-registration**, committed before any batch of it runs. It names
the cohorts, the arms and what moves; it changes no rule.

> **ABANDONED, 2026-08-21, before it produced any result.** Read this document
> as a design that was never measured, not as a run with an unpublished
> verdict. Two batches were played — 200 training games on `20260818`, 0
> capped, and the 100-seed held-out control arm on `20260822`, 1 capped — and
> reflection then died at run 67 of 200 when the model server dropped the
> connection (`vect-hack-b5f.13`: the reflect host cannot resume, so 66
> transcripts were unusable). No fact set was earned, `data/kb` was never
> written, and the treatment arm never ran.
>
> The run was abandoned rather than resumed because the tree it froze is no
> longer the tree: `2e5fe6c` merged three Larn bot fixes (`vect-hack-b5f.10`,
> `vect-hack-b5f.11` and the gold-routing correction), two of which change the
> ladder's own decisions. An arm played before them and an arm played after
> them are not comparable, and a control arm is only honest if it is the same
> bot as the treatment.
>
> **What a successor must change.** The held-out master `20260822` is spent:
> seed 1185260916 was used to develop `vect-hack-b5f.10` and
> `vect-hack-b5f.11`, so a comparison on that cohort would read seeds that
> shaped the code. Pick a fresh master, re-check it shares no seed with
> `20260818`, `20260819`, `20260821` or `20260822`, and fix
> `vect-hack-b5f.13` first — a five-hour pass with no resume will lose again.

## The question

The engagement phase closed the consumer defect and re-measured the *1b* fact
set: NO-SHIP, 18 wins to 28 losses, pooled median score delta 0, no pair
censored. Its closing sentence is the question this run answers — whether a
fact set produced *after* the digest defect is fixed wins where that one lost.

## What moves, and what deliberately does not

**Moves: `vect-hack-b5f.4`, the killer join** (commit `bbbc514`). A `threat`
assert or confirm is rejected unless it names the run's `killer`, which
`__wrap_died` supplies as the map glyph of the creature Larn's own epitaph
names, and which `buildLarnDigest` publishes only when the screen drew that
glyph beside the hero. In the 1b set, 5 of 38 threat claims named a bystander;
that claim cannot be made now.

**Does not move: `vect-hack-b5f.6`,** the ladder never reads notes. The volcano
stratum was 41 ties in 42 seeds because the one insight 1a predicted — stop
taking the volcanic shaft — arrived as a `note` and no consumer reads notes.
Folding that fix in would move two variables through one A/B, so it stays out
and the volcano stratum is *expected* to tie again. A prediction recorded before
the run is evidence; the same sentence written afterwards is not.

> **Stale as of the abandonment.** `vect-hack-b5f.6` was fixed after this run
> was abandoned: the reflect prompt now routes a terrain lesson to the
> `avoid-terrain` claim instead of a note, the applier gates that claim on the
> exits the run chose, and the ladder's breach step crosses learned avoidance
> when it is the only route. A successor's
> "what moves" section must be written against that tree, and its volcano
> stratum is no longer expected to tie.

**Does not move: `vect-hack-b5f.8`,** threats are only learnable from the blow
that killed the hero. It is the acknowledged ceiling on how much one run can
teach, not a defect this run repairs.

Everything else is at `816e014`: the engagement consumer, both livelock
breaches, the same ladder, the same cap.

## Cohorts

| cohort | master | use |
| --- | --- | --- |
| training | `20260818` | 200 games, `--kb none`. Reflection reads these and only these. |
| held-out | `20260822` | 100 pairs, control `--kb none` vs treatment `--kb data/kb`. |

`20260822` is fresh. It shares no seed with `20260818`, `20260819` (1b's
evaluation) or `20260821` (engagement's evaluation) out to 5000 each, checked
before this document was committed. A fourth master is required for the same
reason engagement needed a third: re-reading a spent evaluation set is a second
comparison on one cohort.

**Training size rises from 1b's 100 to 200.** The killer gate rejects every
threat claim a run cannot ground, so a fixed number of games now yields fewer
claims. Training batch size is not part of the pre-registered contract; the
100-pair evaluation cohort is, and does not change.

**The wall.** No process in this run may read a held-out trajectory for any
purpose except computing the metrics. Nothing in code enforces it — reflection
is pointed at a batch directory by hand — so it is enforced here and in the
commands recorded in the report.

## The decision rule

Unchanged from the 1b contract, quoted so the verdict cannot be read against a
rule written after the numbers: the KB ships if the pooled median per-seed score
delta is positive, the win count exceeds the loss count, and the control-surface
median depth delta is at least zero. Strata are labelled by the control arm.
Any seed capped in either arm is excluded from the score statistic and the
excluded count is reported. `scripts/dev/kb-ab-report.mjs` is the only reading.

A negative result is published as one. `data/kb` stays empty unless the rule
says otherwise, and no claim is hand-picked out of a losing set.

## The runbook

```bash
node scripts/dev/bot-gym.mjs --game larn --games 200 --seed 20260818 \
  --max-commands 24000 --parallel 6 --timeout 1800 --out .gym/train-r2 --kb none
npm run bot:reflect -- --batch .gym/train-r2            # writes data/kb/larn/facts.json
node scripts/dev/bot-gym.mjs --game larn --games 100 --seed 20260822 \
  --max-commands 24000 --parallel 6 --timeout 1800 --out .gym/eval-r2-control --kb none
node scripts/dev/bot-gym.mjs --game larn --games 100 --seed 20260822 \
  --max-commands 24000 --parallel 6 --timeout 1800 --out .gym/eval-r2-treatment --kb data/kb
node scripts/dev/larn-engagement-report.mjs --batch .gym/eval-r2-control \
  --batch .gym/eval-r2-treatment
node scripts/dev/kb-ab-report.mjs --control .gym/eval-r2-control \
  --treatment .gym/eval-r2-treatment --seed-master 20260822 --cohort 100
```
