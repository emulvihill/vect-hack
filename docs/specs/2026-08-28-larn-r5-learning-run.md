# r5: the first learning run over a corpus that isn't half write-offs

Beads: vect-hack-h9x (epic), vect-hack-b5f (the loop this continues).
Bench: `docs/specs/2026-08-28-larn-bench-design.md`.

**Written before the reflection pass was run.**

## Why run the loop again after Phase 1 closed it

Phase 1 shipped zero facts in four runs and was closed on 2026-08-24
(`docs/reports/2026-08-24-larn-phase1-closing.md`). This is not a
re-run of the same experiment; the input has changed in a way that goes to the
heart of why it failed.

**Before vect-hack-h9x.5, half of every training batch was a hero who fell down
the volcanic shaft and was killed in a couple of dozen commands by something
it never saw.** Those runs teach nothing: `runGrounds()` gives a run its
killer as a subject only when the screen drew that glyph beside the hero, so
half the corpus could ground no threat claim at all. What was left was
`avoid-terrain` about the shaft — the one claim the vocabulary could carry and
the ladder could not act on, which is precisely what r3 and r4c foundered on.

The r5 corpus is different by construction. 150 games, master **20260830**,
under the shipped policy (`shaftMinXlevel` 8, `wieldProbes` 0): 142 died, 8
capped, **0 shaft rides**, median 586 commands. Deaths are melee to ordinary
monsters on dungeon levels 1-3 — giant ants (17), quasits (15), rust monsters
(13), orcs (9), zombies (9) — and the hero is nearly always adjacent to its
killer when it dies, so the killer join lands.

In one word: the corpus can now ground threat claims, and threats are the kind
the ladder's `engage()` actually reads.

## The pass

- Batch: `.gym/train-r5`, 150 games, master 20260830.
- Brain: `--brain claude` (`claude-opus-5`, effort `high`), through the CLI's own
  login. **Timed from one unit before sizing, per `~/AGENTS.md`**: 21.6 s for one
  run including its ablation probe, so 150 runs is under an hour. The local
  brain was timed first and rejected — `qwen38-q5` had not finished a single
  reflection after 11 minutes, against AGENTS.md's documented 1.5 min/run. That
  documented figure is stale; see vect-hack-h9x.21.
- Write target: `.gym/train-kb`, **not** `data/kb`. The shipped KB now refuses a
  write without `--ship` (vect-hack-h9x.16), which is what makes this safe to
  run unattended.
- The ablation probe gates the batch as always: a claim that survives its own
  death being removed fails the whole pass before a byte is written, except the
  admitted `avoid-terrain` kind.

## The verdict, pre-registered

Paired A/B on the **held-out** set (master 20260829, 500 games), control
`--kb none` against treatment `--kb .gym/train-kb`, read through
`scripts/dev/kb-ab-report.mjs` and the bench.

The KB ships into `data/kb` only if, on held-out:

1. `dungeonDepthMedian` does not fall, **and**
2. `xlevelMedian` does not fall, **and**
3. at least one of the two rises, **and**
4. `faults == 0`.

**The guard that matters, and it is the one Phase 1 kept tripping.** A learned
`threat` table makes `engage()` decline fights. A bot that declines more fights
survives longer and descends less, so `commandsMedian` rising while
`dungeonDepthMedian` holds or falls is the SIGNATURE OF THE FAILURE, not
evidence of success. It is reported prominently either way, and it does not
buy a ship.

**Second guard, on the facts rather than the play.** If the pass produces
`avoid-terrain` claims about `stairs:%` or `stairs:E` — the ordinary descents,
which are now the only exits the bot chooses — that is the loop learning "do
not descend" from a corpus in which every death follows a descent. The A/B
would catch it as a depth regression, but the fact set is inspected for it
directly and the report says how many such claims were filed whatever the A/B
said.

## Attribution arms — diagnostics, not a second chance at the ship rule

Added while the pass was still running, after 13 of 150 reflections showed the
second guard firing: 7 `avoid-terrain` claims filed, of which **4 are
`stairs:%` and 2 are `stairs:E`** — the ordinary staircase and the dungeon
entrance, the only descents the bot now takes.

So the run will be split by claim kind with `scripts/dev/kb-split.mjs` and each
kind benched on the held-out set, exactly as r4c did: `threat`-only and
`avoid-terrain`-only beside the full set.

**This does not change the ship rule.** The rule above is about the FULL fact
set on held-out, it was written before the pass, and a kind that wins on its own
does not earn a ship for a KB that loses as a whole. The split exists to say
WHY, because "the KB lost" without attribution is what four Phase 1 runs already
produced and it is not worth a fifth. Reported as diagnosis, decided by the rule.

## What a null result means this time

If the corpus change was the binding constraint, this run moves the numbers. If
it does not, the evidence is much stronger than Phase 1's that the fact
vocabulary itself is the limit — which is what vect-hack-h9x.12 proposes to
replace, and this run is the last cheap test before paying for that.

Either way `data/kb` stays empty unless the rule above is met. Empty by
decision is the convention r3 and r4c established and it is what makes "empty"
mean anything.
