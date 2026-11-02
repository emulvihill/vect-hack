# Larn engagement: a threat value is not a melee veto

Date: 2026-08-21. Beads: `vect-hack-b5f.3` (the engagement seam),
`vect-hack-b5f.5` (the livelock). Parent epic: `vect-hack-b5f`. Predecessor
spec: `docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md`.
Evidence: `docs/reports/2026-08-21-larn-1b-ab.md`.

## Why this exists

Phase 1b built the learning circuit and it worked: digests were built from what
the screen drew, 105 reflections were transcribed, the ablation probe found no
laundered prior, and the pre-registered rule read the result and said no. The
knowledge base lost its A/B and `data/kb/larn/facts.json` went back to empty.

The report names the seam that lost it. The reflect model was asked how
dangerous a being is and answered honestly — a giant ant *is* lethal to a
level-1 character with 10 HP — so 28 of 38 threat claims came back at 1.0 and
all but two cleared `fleeThreshold` (0.7). The ladder reads that table as an
instruction never to fight. Melee attempts per 100 commands fell from 4.07 at
the control median to 0.00, 74 of 100 treatment runs never swung at anything,
and the surface stratum lost 475 score points at the median.

This spec fixes the consumer, not the facts. The facts were mostly true.

## The three defects, and why one fix is not enough

**1. The veto seam.** `src/modules/larn/bot/policy.ts:123-126` declines melee on
`threat >= fleeThreshold` alone. It consults nothing about the hero — not HP,
not experience level, not whether retreat exists. Lowering the threshold is
explicitly ruled out: it moves the same cliff.

**2. The refusal is also a wall.** `passable()` (policy.ts:45) treats a being
cell as impassable, which is correct for routing — walking into a monster is an
attack, not a step. But a monster the ladder will not attack and cannot route
around is a permanent block across a corridor. The report's depth collapse
needs no second mechanism.

**3. There is no third option.** Step 1 declines and falls through to
loot/explore/descend, so the bot stands in a fight doing something unrelated.
The report measured this directly and it is the sharpest number in it: exactly
78 runs in *each* arm were attacked, so the treatment did not avoid fights. Of
those 78, 53 never swung back under the KB against 8 in the control. The
treatment stood in fights and did not fight.

## What was checked in the source before the design was fixed

**Larn has no hunger.** A scarcity term that raises risk tolerance as the hero
starves would be the natural companion to a capacity term, and in NetHack,
Angband and Moria it would be. Larn has no food, no nutrition and no starvation
clock: one case-insensitive hit for `hunger|starv|hungry` across the whole
source, and it is flavour text in a beggar's letter (`external/larn/bill.c:97`).

**Larn's scarcity is the mobul clock, and it is out of reach.** `TIMELIMIT`
is 30000 gltime — 300 mobuls — and the deadline is tested when the hero brings
the potion home (`external/larn/object.c:1280`). `mobulsLeft` already reaches
the bot through the status tap (`src/modules/larn/statusRecords.ts:81`), so a
pressure term would cost no plumbing. It would also never fire: the 1a baseline
has a median of **2** mobuls elapsed, an upper quartile of 5.25 and a maximum of
31, against that 300-mobul budget
(`docs/reports/2026-08-18-larn-baseline.md`). The bot dies roughly a
hundred times sooner than the clock matters, and a term that cannot fire is an
assertion that cannot fail.

So there is no pressure term in this design. **"Scarcity raises risk tolerance"
is recorded here as a meta-tier candidate** for the cross-engine consolidation
at the end of the epic, where the engines that have a hunger clock will
instantiate it.

## The design

### Engagement is derived, threat stays learned

`threat` keeps its meaning: a claim about a being, earned from evidence, in
0..1. The ladder stops comparing it to a constant and compares it to what the
hero can absorb.

```
capacity = hp / hpmax + experience
experience = min(xlevel, engageLevelCap) / engageLevelCap * engageLevelWeight
engage = threat < capacity
```

`capacity` is deliberately **not clamped above 1**. 28 of the 38 claims in the
rejected set carried value 1.0, so a capacity ceiling of exactly 1 would make
`threat < capacity` false for a healthy hero and reproduce the whole regression
under a new formula. The experience term is what lifts a full-HP hero above any
threat in 0..1, and it earns its place by doing so.

Three properties follow, and each kills part of the failure:

- **An empty KB changes no decision.** `threat === null` engages, as today.
  `scripts/test/test-larn-trace.mjs` must stay byte-identical, and it is the
  gate on this claim.
- **A hero at full HP fights anything.** With `xlevel >= 1`, capacity exceeds 1
  and no threat in 0..1 can veto. The 1b failure mode becomes unreachable by
  construction, not by tuning.
- **There is no cliff to move.** `fleeThreshold` is deleted from
  `data/kb/larn/policy.json` rather than re-tuned.

`hpmax <= 0` — before the first status record — engages. An unknown hero
behaves as the bot behaved before it learned anything.

### Choosing among several adjacent beings

The ladder evaluates every adjacent being rather than the first one found. It
fights the engageable one of least threat; only when **none** is engageable does
it decline. Declining to a group is how a bot gets surrounded.

Ordering must not disturb the empty-KB identity: rank by `threat ?? 0`, ties
broken by `DIRS` index. With every threat null all ranks are 0 and the first
`DIRS` direction wins, which is exactly today's loop.

### Declining produces an action, never a fall-through

A new ladder step sits between fight and rest: **disengage**. It takes the
passable, unblocked neighbouring cell that maximises the minimum Chebyshev
distance to the declined beings, `DIRS` order breaking ties.

**Cornered means fight.** If no such cell exists, the ladder attacks the
least-threatening adjacent being anyway. Being hit for free is strictly worse
than swinging. This is also what dissolves defect 2: a being is never merely
declined, so it can never become a permanent wall.

**Retreat is bounded.** `disengageLimit` consecutive disengage steps and the
ladder fights regardless. Larn monsters move, so an unbounded retreat is a
livelock with extra steps. The counter resets on any non-disengage intent and
on a level change.

### Tuning, not knowledge

`data/kb/larn/policy.json` loses `fleeThreshold` and gains:

| knob | value | meaning |
|---|---|---|
| `engageLevelCap` | 10 | xlevel at which the experience term saturates |
| `engageLevelWeight` | 0.5 | how much saturated experience adds to capacity |
| `disengageLimit` | 4 | consecutive retreats before the ladder fights anyway |

These are knobs the ladder is born with, not claims about Larn, so they stay
out of `facts.json` and out of the provenance audit — the rule `src/bot/kb.ts`
exists to enforce.

## The livelock (b5f.5)

Six runs in the 1b held-out A/B reached the 24000-command cap still on depth 1,
at full HP and xlevel 3. Doubling the cap from 12000 did not move the count,
which is what separates a livelock from a slow game. The treatment made it five
times likelier, but one control run proves it exists in the seed bot too.

**It is in scope because it confounds the measurement.** A ladder that sometimes
declines melee re-opens exactly this loop, and an A/B run over a live livelock
cannot attribute its capped runs.

**Method: reproduce, then fix what the reproduction shows.** The bead names the
seeds — control 565999359, treatment 81342652, 926755374, 872056713, 445946575,
9654602, all `childSeed(20260819, i)`. One is replayed with the intent sequence
instrumented, and the actual cycle is identified before a line of fix is
written. No fix is pre-specified here, because a fix chosen before the
reproduction would be a guess dressed as a design.

## The measurement contract

**Pre-registered and binding.** Written before any batch of this phase runs.

### Stage 1 — the training-seed regression fixture

The 1b fact set is the cheapest available falsification of the new consumer,
and it is already known to reproduce the entire regression deterministically.
It is restored from commit `3317426` as a **test fixture**, never as active
knowledge, and run against the new ladder.

- **Cohort:** training master `20260818`, 100 games, cap 24000 — the conditions
  the isolation in `vect-hack-b5f.3`'s notes used.
- **Arms:** the seed KB (control) and the restored 1b fact set (treatment).
- **Gate**, against the numbers that isolation published:
  - melee attempts per 100 commands at the treatment median returns to within
    20% of the control median (control was 4.47, treatment 0.00);
  - runs that never swung: treatment no worse than control + 5 (was 27 -> 79);
  - capped runs: treatment no worse than control + 2 (was 0 -> 9).

Failing this gate stops the phase. It costs training seeds only, so it may be
re-run while iterating.

### Stage 2 — a fresh held-out A/B

Only after stage 1 passes.

- **Cohort:** a new held-out master, `20260821`. It shares no seed with
  `20260818` or `20260819` out to 5000 each, checked with `childSeed` before
  this spec was committed. A new master is required because `20260819` was
  already spent evaluating 1b, and re-reading it would be a second comparison
  on one evaluation set.
- **Arms, strata, exclusions and the decision rule** are unchanged from the 1b
  contract, read by `src/bot/abReport.ts` through
  `scripts/dev/kb-ab-report.mjs`. That rule is not re-opened here.
- **The treatment's knowledge is the 1b fact set, unchanged.** Same facts, new
  consumer, so the experiment isolates the thing this phase changed. Re-earning
  a fresh KB would move two variables and answer a muddier question.
- **Reflection reads no held-out trajectory.** As in 1b, nothing in code
  enforces this; it is the runbook's wall.

### A committed metric

The 1b report's melee figures were derived by hand and no script in
`scripts/dev/` reproduces them. A gate whose metric cannot be re-run is not a
gate. `scripts/dev/larn-engagement-report.mjs` replays a batch's trajectories
through a fresh `LarnBotModel` and reports, per run and as a distribution:
melee attempts, melee per 100 commands, runs that never swung, runs that were
attacked, blows taken, and capped runs.

Melee is inferred the way the report inferred it: a movement key whose target
cell held a being in the frame before the key. The trajectory records events and
replies but not intents (`src/modules/larn/bot/recorder.ts`), so replay is the
only source, and this script is where that inference lives once.

## Tests

- **`scripts/test/test-larn-trace.mjs` unchanged and passing.** The empty-KB
  identity. If it fails, the change altered a decision it promised not to.
- **`engage()` as a pure function**, in `scripts/test/larn-bot-policy.test.ts`:
  null threat engages; full HP engages against 1.0; half HP declines 0.9 and
  engages 0.4; `hpmax = 0` engages; a high xlevel lifts capacity over a threat
  a low xlevel declines.
- **The ladder's composition**: a declined being with an open cell produces
  `disengage` and not a fall-through to explore; a declined being in a dead end
  produces `fight`; two adjacent beings of different threat, one engageable,
  produce `fight` against the weaker; `disengageLimit + 1` consecutive declines
  produce `fight`.
- **The all-below-floor inertness case** already in that suite stays, rewritten
  for the new knobs.
- **`npm test`** in full, since `policy.json`'s shape changes and the bot
  substrate is loaded from source by the node gym.

## Out of scope

- **`vect-hack-b5f.4`** — the digest cannot join a killer to a glyph, so 5 of 38
  claims blamed a bystander. It changes the facts; this spec changes their
  consumer. Folding it in would move two variables through one A/B.
- **`vect-hack-b5f.6`** — notes are written and never read.
- **A pressure/scarcity term**, for the reason given above; recorded as a
  meta-tier candidate instead.
- **Any flee routine beyond one step.** Disengage moves one cell and is
  bounded. A real retreat with a destination is 1c's business, if the numbers
  ask for it.
