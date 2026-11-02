# r4c attribution: which half of the fact set carried the win

Date: 2026-08-24. Bead: `vect-hack-b5f.24`. Predecessor:
`docs/reports/2026-08-24-larn-r4c.md`.

**Pre-registration, committed before either new arm is played.**

## The question

r4c measured one improvement — surface runs surviving 1019 commands against
475, `hpmax` 23.5 against 17.5, paired median score +30 over 52 seeds — and
cannot say what produced it. The mechanism runs through `avoid-terrain`
(`stairs:%` walled at `hpmax` 38 acting as a descent brake), and that is the
claim kind whose ablation-probe leaks are ADMITTED under `vect-hack-b5f.23`;
4 of 5 probes in the batch restated `stairs:V` with the death removed. The
`threat` half is clean: a threat leak still fails a batch and none did.

So the one thing Phase 1 has ever measured as a gain may be a transcript of
what a frontier model already knew about roguelikes. This run decides it.

## The arms

All four arms are paired on ONE seed list, held-out master `20260827`, cohort
100 — the same cohort the r4c A/B used, so the control and full-KB arms are
reused rather than replayed.

| arm | knowledge | tables hash | status |
| --- | --- | --- | --- |
| control | none | `""` | already played (`.gym/eval-r4c-control`) |
| full | all 56 facts | `06e67de3` | already played (`.gym/eval-r4c-treatment`) |
| threat-only | 27 threat + 24 note | `6c99f95c` | to be played |
| terrain-only | 5 avoid-terrain + 24 note | `8526b5ee` | to be played |

Both new KBs are derived by `scripts/dev/kb-split.mjs` from the committed
`2026-08-24-larn-r4c-facts.json`. The meta tier and `policy.json` are copied
identically into every arm, so nothing but the surviving claim kinds differs.
`note` facts are in BOTH halves because they compile into nothing — including
them in neither would make the two halves not sum to the whole.

## What each outcome means, stated before the numbers exist

Read on the same statistic the r4c report led with: the paired surface-stratum
median score delta against the control arm, plus commands survived and `hpmax`,
strata frozen from the control arm as always.

- **Terrain-only reproduces the gain, threat-only does not.** Phase 1's single
  measured win is prior-driven. The `b5f.23` hole is doing the work, the fact
  loop earned nothing, and Phase 1 closes having demonstrated that its
  mechanism did not fire.
- **Threat-only reproduces the gain, terrain-only does not.** The loop earned
  it under a gate that never fired. That is Phase 1's first real result and the
  threat vocabulary is worth carrying into Phase 2.
- **Both reproduce it.** The halves are redundant; attribution is unresolved
  and the honest report says so rather than picking the flattering half.
- **Neither reproduces it.** The gain needs both halves together, or it was
  noise in the first place. The second reading is live and must be checked:
  52 surface pairs is a small sample and the r4c pooled median was 0.

## What this run does not decide

Nothing about shipping. `data/kb` is empty by the r4c NO-SHIP decision and
stays empty whatever this returns. This is an attribution measurement, and its
result is published either way.
