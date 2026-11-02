# Wield the best weapon, measured rather than tabulated

Bead: vect-hack-h9x.6 (the wield half). Bench:
`docs/specs/2026-08-28-larn-bench-design.md`.

**Written before the treatment was measured.**

## The gap

`LarnBotModel` records the inventory the status tap reports and `policy.ts`
never reads it. The bot fights every game in the leather armour and the dagger
it was created with (`create.c:44-46`), while Larn's automatic pickup fills its
pack with gear it never puts on. `test-larn-status-tap.mjs` prints one such run
verbatim: after 257 commands the hero holds `b) a dagger (weapon in hand)` and
`g) a dagger + 2`, and dies wielding the worse one.

The 500-game h9x.5 batch says this matters. Its 477 deaths are almost entirely
melee, to ordinary dungeon-level-1-to-3 monsters — 79 giant ants, 70 quasits,
59 rust monsters, 34 zombies, 28 troglodytes, 26 hobgoblins.

## The approach: ask the engine, do not tabulate

The obvious implementation is a ranking table over Larn's weapon names. This
spec does not do that, for two reasons: it is a second copy of a game rule, and
h9x.15 has already claimed the "learn the ranking from the DND store's own
prices" design.

Instead the bot **tries a weapon and reads the number the game prints**. The
status tap already reports `wc` — Larn's own weapon class for whatever is in
hand — beside the inventory, and `wc` is on the bottom line the player reads.
So:

1. For each carried item that is not a potion or a scroll, wield it once.
2. Read `wc` from the next status push.
3. Keep whichever measured highest; re-wield it if the last probe was worse.

No weapon table exists anywhere in the bot. What ranks the weapons is Larn.

Three source facts make this cheap and safe:

- **`wield()` never refuses a swap** (`main.c:1013-1044`): it sets `c[WIELD]`
  and returns. Unlike `wear()`, which prints "You're already wearing some
  armor", there is no take-off step and no unarmoured turn. Armour is therefore
  **out of scope here** and stays with h9x.6's remaining half.
- **The two classes it does refuse are exactly the two the tap already names.**
  `ycwi()` rejects `OPOTION` and `OSCROLL`; `ITEM_CLASS.POTION` and
  `ITEM_CLASS.SCROLL` are how the tap labels them. So the candidate filter needs
  no name matching at all.
- **The prompt is text-identifiable.** `whatitem()` prints
  `"\nWhat do you want to wield [* for all] ? "` (`main.c:1290`), and answers
  `.` to mean "nothing", so a probe can always be abandoned.

What is currently in hand is also on screen: `show3()` appends
`" (weapon in hand)"` to the item it is wielding (`main.c:636`), and the tap's
item names are exactly what `show3()` would print.

## Where it goes in the ladder

Beside the rest step, not above the fight step. Swapping a weapon costs a turn,
and doing it with a monster adjacent hands the monster a free round. The step
therefore fires only when no monster is visible — the same condition the rest
step already computes.

## What this is also an instance of

vect-hack-h9x.14: a verb the bot never tries generates no data to learn from.
This is deliberate exploration with a measured payoff, and the measurement is
the game's own.

## Pre-registered prediction and guards

Read on the **held-out** set (master 20260829, 500 games), paired against a
control on the same seeds — the control being the same build with the probe
disabled.

The honest expectation is **small**. The hero starts with a dagger, and how
often it finds a better weapon in the two or three dungeon levels it now
reaches is unknown; the h9x.5 batch is not instrumented for it. This is not
another 50%-of-the-corpus change and must not be reported as one.

| | ship if |
|---|---|
| `dungeonDepthMedian` (co-primary) | must not fall |
| `xlevelMedian` (co-primary) | must not fall |
| either co-primary | at least one rises |
| `dungeonDepthMax` (guard) | must not fall |
| faults | 0 |

**The guard that matters here**: the probe spends commands. If it spends them
and neither co-primary moves, it is a cost with no benefit and does not ship —
a rise in `wc` is *not* the objective and is not admissible as the result. The
report must state the measured `wc` distribution as a mechanism variable and
the co-primaries as the verdict.

**The failure mode to watch**: a probe loop. If the "re-wield the best" step and
the "try the next" step disagree, the bot alternates forever and the run caps.
A rise in `capped` beyond the h9x.5 batch's 23/500 is the symptom, and the unit
tests pin the state machine against it.
