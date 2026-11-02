# Descent by readiness: the shaft is not an exit like any other

Bead: vect-hack-h9x.5. Bench: `docs/specs/2026-08-28-larn-bench-design.md`.

**Written before the treatment was measured.** The threshold, the guards and the
sample below are fixed here first, and every guard is reported whichever way it
lands (`~/AGENTS.md`, Measurement).

## The loss

The bench baseline, 2026-08-28, 500 games, `--kb none`:

```
CO-PRIMARY  dungeon depth median 0   xlevel median 1
            dungeon max 5 · shaft rides 50.6% · commands median 54.5
```

Half of every batch steps into the town's volcanic shaft. `fillroom(OVOLDOWN)`
puts it on level 0 only (`create.c:404`), and taking it calls
`newcavelevel(MAXLEVEL)` — internal 11 (`object.c:345`), where monsters are
generated for that depth (`global.c:203-219`). A 10-hp level-1 character
arrives eleven levels below anything it can survive and dies in a median of 19
commands with score 0.

To the ladder it is an exit like any other: `isDown()` (policy.ts step 5) asks
for `stairs`/`kind: "down"` and the shaft answers yes, because
`native/main-wasm.c` maps `OSTAIRSDOWN`, `OELEVATORDOWN`, `OVOLDOWN` and
`OENTRANCE` all to `TERRAIN_STAIRS` + `KIND_DOWN`. They differ only in the
glyph: `data.c objnamelist[]` gives index 13 `%` (staircase), 14 `^`
(elevator), 54 `E` (dungeon entrance), 55 `V` (the shaft).

## Why a rule and not a fact

Four learning runs have identified the shaft and none has acted on it. r3's flat
avoid table walled every exit at once; r4c's threshold table avoided the shaft
and the ordinary staircase equally at hpmax 10. Both times descent fell through
to the breach step, and both times migration was 0 over 100 pairs. The KB
vocabulary compiles to a routing veto that walls everything or nothing.

So readiness becomes a ladder rule with a tunable bar, and what the learning
loop is later asked is not "is this exit bad" but "where is the bar" — a knob
h9x.11's policy search can optimise directly.

## The treatment

One variable. Two knobs are added to `PolicyTuning`; only the first has a
non-neutral default, so this experiment changes exactly one thing.

- **`shaftMinXlevel: 8`** — the shaft is refused below experience level 8, in
  routing (the descent step does not target it) and at the prompt (`(c) climb
  down` is answered `i`). Both halves are needed: routing alone still rides it
  when the hero is standing on it for another reason.
- **`descendMinHpFraction: 0`** — the separate, lower bar the bead asks for on
  ordinary stairs, shipped **neutral**. The mechanism exists for the policy
  search; raising it here would make the run a two-variable experiment. It also
  cannot be raised past `restBelowHpFraction` (0.5) without deadlocking: the
  rest step stops resting at 0.5, so a descent bar above it would refuse every
  staircase for the rest of the game.

Why 8 and not "never": the shaft is the only route to the volcano, and the
volcano holds the potion the win condition requires (`create.c:269-276`). A bar
that reads "never" would delete the win from the game. 8 is above anything this
bot has ever reached (best xlevel ever recorded: 5), so the measured effect of
this change is expected to be a near-total refusal — and when a later change
makes level 8 reachable, the route opens by itself rather than needing this file
edited.

**The invariant that must survive.** No readiness bar may seal a level. The
breach steps (policy.ts 6 and 6b) route on `walkable()` and consult neither the
KB nor readiness, so a hero who can reach nothing else still crosses. The shaft
is never a level's only exit — the town also holds the dungeon entrance — but
the invariant is asserted rather than assumed.

## Pre-registered prediction and guards

Read on the **held-out** set (master 20260829, 500 games), paired against a
control on the same seeds. The bench set (20260828) is for iterating.

| | baseline | ship if |
|---|---|---|
| `shaftRideRate` | 50.6% | **< 5%** |
| `dungeonDepthMedian` (co-primary) | 0 | **>= 1** |
| `xlevelMedian` (co-primary) | 1 | **>= 1**, and must not fall |
| `dungeonDepthMax` (guard) | 5 | **>= 5** — must not fall |
| `commandsMedian` (mechanism) | 54.5 | expected to rise sharply |
| faults | 0 | **0** |

**The guard that matters, stated because it is the one that could embarrass
this change**: a bot that stops descending is not an improvement. If shaft rides
fall to 0 and `dungeonDepthMedian` does **not** rise, the change bought
survival time and no progress, and it does not ship on that result — it is
reported as a failure and the bar goes back to the drawing board.

`commandsMedian` rising is *not* evidence of success on its own, for the same
reason: a hero who lives longer in the town has not moved toward the Eye.
