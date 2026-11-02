# Larn — learned facts

Empty, and empty on purpose — twice over now.

**The third learning run (2026-08-22, master seed 20260823, 200 games).** Its
reflect pass earned 53 facts under the repaired digest: 43 `threat`, 5
`avoid-terrain`, 5 `note`. The evidence ordering was right — `stairs:V`, the
town's volcanic shaft, carried 99 supporting runs against 19 and 7 for the
ordinary exits — and the held-out A/B rejected the set anyway: NO-SHIP, 16 wins
to 31 losses, pooled median score delta 0, control-surface depth delta -1.
Migration was 0 in both directions, so the shaft claim changed nothing about
where the hero went. `compileFacts` reads confidence, not evidence weight, and
all five terrain keys cleared the floor; with every exit avoided the descend
step has no eligible exit and descent falls to the breach step
(`vect-hack-b5f.17`). The decision is
`docs/reports/2026-08-22-larn-r3.md`, the facts are in the history
of this file's JSON sibling at commit `540958f`, and the transcripts are kept
in the private archive, not in this tree.

**Phase 1b's first reflect pass** over the 100-game
training batch of 2026-08-21 (master seed 20260818) earned 52 facts, and the
held-out A/B rejected them: they told the bot not to fight, and a bot that does
not fight earns nothing. The decision is
`docs/reports/2026-08-21-larn-1b-ab.md`, the facts themselves are in
the history of this file's JSON sibling at commit 3317426, and the model
transcripts that produced them are kept in the private archive, one file per
game.
Nothing here was hand-picked or hand-removed: the whole set shipped to the
measurement and the whole set came back.

Every fact added here must carry provenance naming the trajectory and event
range that supports it, in `support` (and `refute`, once play argues the other
way). Seed facts — operational knowledge of how to *operate* Larn, and general
survival common sense — carry `"seed": true`, may name no evidence, and are
reviewable in the commit that adds them; everything else must name a run.
Monster behaviour, item values and level strategy are **not** seed material:
they are what the bot is here to earn.

A fact's `id`, its `confidence` and the three tables the ladder reads are all
derived, never authored: the applier (`src/bot/factDelta.ts`) owns the first
two and `src/bot/kbCompile.ts` the third. Hand-editing this file's JSON sibling
is therefore a way to write something the audit cannot explain — prefer a
delta through the reflect host.
