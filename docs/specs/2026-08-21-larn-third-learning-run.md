# The third learning run: a fact set earned with both digest fixes in place

Date: 2026-08-21. Bead: `vect-hack-b5f.16`. Predecessors:
`docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md` (the
measurement contract, unchanged by this document),
`docs/specs/2026-08-21-larn-second-learning-run.md` (abandoned
before it produced a result),
`docs/reports/2026-08-21-larn-engagement.md`,
`docs/reports/2026-08-21-larn-note-routing.md`.

This is a **pre-registration**, committed before any batch of it runs. It names
the cohorts, the arms, the gate and what moves; it changes no rule.

## The question

Phase 1b's fact set lost its held-out A/B twice: once as shipped
(`2026-08-21-larn-1b-ab.md`) and once re-measured after the consumer defect was
closed (`2026-08-21-larn-engagement.md`, NO-SHIP, 18 wins to 28 losses). Both
post-mortems named the digest, not the ladder: the model blamed bystanders for
deaths, and the one insight the phase predicted arrived as a `note`, which
compiles into nothing.

Both defects are now fixed. This run asks whether a fact set earned under the
repaired digest and prompt beats `--kb none` where the earlier sets lost.

## What moves

Everything here is at `a8862ca` and was merged after the second run was
abandoned.

- **`vect-hack-b5f.4`, the killer join** (`bbbc514`). A `threat` assert or
  confirm is rejected unless it names the run's `killer` — the map glyph of the
  creature Larn's own epitaph names, published only when the screen drew that
  glyph beside the hero.
- **`vect-hack-b5f.6`, note routing** (`d3a1343`). The prompt states the
  routing rule before it lists the kinds, the run block names the keys the run
  can ground (`runGrounds()`), and the applier gates `avoid-terrain` on that
  same derivation. Measured on the 1b cohort: 12 of 12 sampled shaft runs now
  file an accepted `stairs:V`, against a baseline of 0 of 53
  (`2026-08-21-larn-note-routing.md`).
- **The two ladder livelock fixes and gold routing** (`2e5fe6c`). Both arms of
  this run's A/B play the same tree, which is what the second run could no
  longer promise.
- **`vect-hack-b5f.13`, reflect resume** (`a8862ca`). A dropped socket is
  retried, and a killed pass reuses a recorded reply when the prompt and the
  trajectory sha256 both match. The second run died at reflection 67 of 200 and
  lost all 66 finished reflections.

Two variables move through this A/B rather than one. That is deliberate: the
second run's design held `vect-hack-b5f.6` out so exactly one moved, and it was
abandoned before it measured anything. Re-splitting the two fixes across two
five-hour passes buys attribution the epic does not need — both are digest
repairs, and neither has a plausible reading in which it hurts.

## What deliberately does not move

- **`vect-hack-b5f.8`** — a threat is only learnable from the blow that killed
  the hero. The acknowledged ceiling on how much one run can teach.
- **`vect-hack-b5f.14`** — the model files an `avoid-terrain` claim for the
  ordinary exit it descended before dying, not only for the shaft. This run
  does not fix it; it **measures** it, under the gate below, because fixing it
  by teaching the applier to tell a shaft from a staircase would be the run
  writing the lesson it exists to measure.
- **`vect-hack-b5f.7`** (threat ids carry an uninformative colour),
  **`vect-hack-b5f.12`** (unbounded trapped-door retry) and
  **`vect-hack-b5f.15`** (item-value claims are ungrounded and ungated).

## Cohorts

| cohort | master | use |
| --- | --- | --- |
| training | `20260823` | 200 games, `--kb none`. Reflection reads these and only these. |
| held-out | `20260824` | 100 pairs, control `--kb none` vs treatment `--kb data/kb`. |

Both masters are fresh. Neither shares a seed with `20260818`, `20260819`,
`20260821` or `20260822` out to 5000 each, nor with the other, checked before
this document was committed. The training master is fresh as well as the
held-out one: the note-routing fix was developed by re-asking the `20260818`
training reflections, so that master is spent for prompt development, and a
prompt tuned on the digests it now reflects on is a training-set overfit even
though it cannot touch the held-out verdict.

**Training size stays at 200,** the second run's figure, for the same reason:
the killer gate rejects every threat claim a run cannot ground, so a fixed
number of games yields fewer claims than 1b's 100 games did. Training batch
size is not part of the pre-registered contract; the 100-pair evaluation cohort
is, and does not change.

**The wall.** No process in this run may read a held-out trajectory for any
purpose except computing the metrics. Nothing in code enforces it — reflection
is pointed at a batch directory by hand — so it is enforced here and in the
commands recorded in the report.

## The gate: what the compiled avoid table must show

`vect-hack-b5f.14`'s acceptance criterion, discharged here. After reflection
writes `data/kb/larn/facts.json` and **before either evaluation arm is played**,
the compiled tables (`compileFacts`, floor `0.6` from `policy.json`) are printed
and published, together with the set of exit keys the training batch actually
grounded (`runGrounds()` over the 200 training runs).

- **Distinguishes** — `stairs:V` is in `avoidTerrain` and at least one grounded
  ordinary exit key is not. The learned distinction is worth something.
- **Does not distinguish** — either `stairs:V` is absent (the note-routing fix
  did not survive at 200 runs), or every grounded exit key is present (the
  ladder's descend step never fires and the breach step picks the exit, which
  may be the shaft).

This gate is a **finding, not a stop**. The A/B is played either way, because
the A/B answers whether the fact set helps and the gate answers why. Recording
that choice here is what stops it from being made after the numbers arrive.

## The decision rule

Unchanged from the 1b contract, quoted so the verdict cannot be read against a
rule written after the numbers: the KB ships if the pooled median per-seed score
delta is positive, the win count exceeds the loss count, and the control-surface
median depth delta is at least zero. Strata are labelled by the control arm.
Any seed capped in either arm is excluded from the score statistic and the
excluded count is reported. `scripts/dev/kb-ab-report.mjs` is the only reading.

A negative result is published as one. `data/kb` stays empty unless the rule
says otherwise, and no claim is hand-picked out of a losing set.

**If reflection earns no facts at all,** there is no treatment and no A/B: the
run is published as a null result naming the claim counts and the rejections
that produced it.

## The runbook

```bash
node scripts/dev/bot-gym.mjs --game larn --games 200 --seed 20260823 \
  --max-commands 24000 --parallel 8 --timeout 1800 --out .gym/train-r3 --kb none
npm run bot:reflect -- --batch .gym/train-r3            # writes data/kb/larn/facts.json
node scripts/dev/kb-compiled-report.mjs --kb data/kb --batch .gym/train-r3   # the gate, before the arms
node scripts/dev/bot-gym.mjs --game larn --games 100 --seed 20260824 \
  --max-commands 24000 --parallel 8 --timeout 1800 --out .gym/eval-r3-control --kb none
node scripts/dev/bot-gym.mjs --game larn --games 100 --seed 20260824 \
  --max-commands 24000 --parallel 8 --timeout 1800 --out .gym/eval-r3-treatment --kb data/kb
node scripts/dev/larn-engagement-report.mjs --batch .gym/eval-r3-control \
  --batch .gym/eval-r3-treatment
node scripts/dev/kb-ab-report.mjs --control .gym/eval-r3-control \
  --treatment .gym/eval-r3-treatment --seed-master 20260824 --cohort 100
```
