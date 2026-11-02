# The fourth learning run: past the first stage

Date: 2026-08-22. Bead: `vect-hack-b5f.18`. Predecessors:
`docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md` (the
measurement contract, unchanged by this document),
`docs/specs/2026-08-21-larn-third-learning-run.md`,
`docs/reports/2026-08-22-larn-r3.md`.

This is a **pre-registration**, committed before any batch of it runs. It adds
one measurement and changes no existing rule.

## The question

The third run earned the right lesson and could not act on it. `stairs:V`
carried 99 supporting runs against 19 and 7 for the ordinary exits, and the
compiled table avoided all five keys equally, so descent fell to the breach
step and nothing moved: 0 migration, 52 of 54 volcano pairs tied.

This run asks whether a vocabulary that can say *how big the hero has to be*
turns that same lesson into behaviour.

## What moves

**The power threshold** (`c5eebfd`). Danger is now relative to what the hero
can take, and the digest records what that was:

- every descent carries the hit points it was taken with;
- every death carries `hpBeforeDeath`, the last living reading, because Larn
  drives hp below zero on the way out and the end-of-game number says how the
  run ended rather than what the hero could take going into it;
- a `threat`'s value is the hp fraction the killer's final engagement beat
  (see the addendum below — originally the fraction still held when the blow
  landed), and an
  `avoid-terrain`'s is the capacity the exit was taken with — both measured by
  the applier from the run, never stated by the model;
- both ratchet upward on a max: a death above the bar moves it, a death below
  it cannot lower it;
- the compiled avoid table is a threshold per key, and `passable()` asks it
  with the hero's own `hpmax`.

## What deliberately does not move

`vect-hack-b5f.8` (a threat is only learnable from the killing blow),
`vect-hack-b5f.7`, `vect-hack-b5f.12`, `vect-hack-b5f.15`. The ladder is
otherwise the tree the third run played.

## Cohorts

| cohort | master | use |
| --- | --- | --- |
| training | `20260825` | 200 games, `--kb none`. Reflection reads these and only these. |
| held-out | `20260826` | 100 pairs, control `--kb none` vs treatment `--kb data/kb`. |

Both are fresh: neither shares a seed with `20260818`, `20260819`, `20260821`,
`20260822`, `20260823` or `20260824` out to 5000 each, nor with the other,
checked before this document was committed.

**The wall.** No process may read a held-out trajectory except the metric
scripts. Nothing in code enforces it; it is enforced here and in the commands
recorded in the report.

## The interim goal, and why it is new

Depth cannot see the volcano stratum — every run in it reaches 11 — and score
barely can, which is how 52 of 54 pairs tied while the two arms were genuinely
different bots. **Surviving the drop is the number that moves when the bot gets
past the first stage.**

Measured on the third run's held-out cohort, before this target was chosen, and
identical in both arms:

| measure | baseline |
| --- | --- |
| rode the shaft | 54 of 100 |
| median commands survived after the drop | 4 |
| longest survival | 36 |
| lasted ≥ 50 commands | 0 of 54 |
| capacity at the drop | `hpmax` 10, max 10 |

Every one of the 108 rides happened at `hpmax` 10. The character has never once
grown before taking that drop, so "survive the volcano" and "wait until you are
big enough" are one lesson seen from two ends.

**The target.**

- **Primary.** At least 25% of the treatment arm's shaft riders last ≥ 50
  commands after the drop. Baseline 0 of 54.
- **Guard.** At least 10 runs must still ride it. A bot that stops descending
  altogether would otherwise report a perfect rate over a handful of runs, and
  never descending is not progress.
- **Reported, not pass/fail.** The rider count and the median `hpmax` at the
  drop. Both routes to the primary are real progress — coping with depth 11, or
  waiting until the character can — and these two numbers say which one
  happened rather than letting either masquerade as the other.

`scripts/dev/larn-shaft-survival.mjs` is the only reading, run over both arms.

## The decision rule for shipping

Unchanged, and quoted so the verdict cannot be read against a rule written
after the numbers: the KB ships if the pooled median per-seed score delta is
positive, the win count exceeds the loss count, and the control-surface median
depth delta is at least zero. Strata are labelled by the control arm. Any seed
capped in either arm leaves the score statistic and the excluded count is
reported. `scripts/dev/kb-ab-report.mjs` is the only reading.

**The interim goal does not ship the KB.** It is a separate measurement of
whether the loop is progressing, published whichever way it lands. A fact set
that hits the survival target and fails the A/B is a fact set that does not
ship — and a finding worth more than either number alone.

## Addendum, 2026-08-22: the threat instant, fixed before reflection ran

A targeted review of the learning strategy found a defect in the vocabulary
this run was registered to test (`vect-hack-b5f.20`): a threat's value was
measured as `hpBeforeDeath` over `hpmax` — the last living reading before the
fatal blow. Nearly every Larn melee death is a multi-blow grind, so a being
that beat a full-health hero down 10→7→3→dead read 0.1, "finished a hero
already lost", and the threat table would have converged low with `engage()`
never declining — the mirror image of 1b's all-1.0 table. The fix: the killer
carries the capacity its final engagement beat — the peak living reading seen
while it stood beside the hero, adjacency gaps of at most two commands, reset
on a level change — and the applier measures against that.

This changed a measurement instrument after the training batch was played, so
the reasons it is not results-shopping are recorded, the same three as r3's
ablation fix: the defect is provable from the code and Larn's own combat
shape, not from any number this run produced — the reflection pass was stopped
before its first byte was read; the fix keeps the instrument able to read low
(a being seen killing only a dying hero still reads low); and the wrong
choices are pinned by tests shown failing under sabotage — the last-reading
rule, a run-wide streak, a strict streak, a first-reading peak and a missing
level reset each fail the capacity suite by name. The digest and prompt
changed, so the aborted pass's transcripts cannot be reused (the resume record
re-asks on any prompt change) and reflection restarts from zero. The exit
threshold's provenance-not-consequence limit (`vect-hack-b5f.21`) is known,
measured by the pre-A/B compiled-table gate, and deliberately not changed by
this addendum.

## The runbook

```bash
node scripts/dev/bot-gym.mjs --game larn --games 200 --seed 20260825 \
  --max-commands 24000 --parallel 8 --timeout 1800 --out .gym/train-r4 --kb none
node scripts/dev/bot-reflect.mjs --batch .gym/train-r4 \
  --archive docs/reports/2026-08-22-larn-r4-training
node scripts/dev/kb-compiled-report.mjs --kb data/kb --batch .gym/train-r4
node scripts/dev/bot-gym.mjs --game larn --games 100 --seed 20260826 \
  --max-commands 24000 --parallel 6 --timeout 1800 --out .gym/eval-r4-control --kb none
node scripts/dev/bot-gym.mjs --game larn --games 100 --seed 20260826 \
  --max-commands 24000 --parallel 6 --timeout 1800 --out .gym/eval-r4-treatment --kb data/kb
node scripts/dev/larn-shaft-survival.mjs --batch .gym/eval-r4-control \
  --batch .gym/eval-r4-treatment
node scripts/dev/larn-engagement-report.mjs --batch .gym/eval-r4-control \
  --batch .gym/eval-r4-treatment
node scripts/dev/kb-ab-report.mjs --control .gym/eval-r4-control \
  --treatment .gym/eval-r4-treatment --seed-master 20260826 --cohort 100 \
  --out docs/reports/2026-08-22-larn-r4-ab
```
