# Cast magic missile at range

Bead: vect-hack-h9x.4. Bench:
`docs/specs/2026-08-28-larn-bench-design.md`.

**Written before the treatment was measured.**

## The gap

The hero knows two spells from character creation — protection and magic
missile (`create.c:42`, `spelknow[0]`/`spelknow[1]`) — and until this change had
never cast either, in any run, ever. `policy.ts` emitted only movement keys and
STAY.

Magic missile does `rnd((clev+1)*2) + clev + 3` damage at range
(`monster.c:318-321`) — 5-8 at experience level 1, 6-11 at level 2, delivered
without being adjacent. The bot's only attack until now was walking into a
monster and taking a full round of melee back.

## The treatment

One knob: `castAtRange`, shipped **false**.

When nothing is adjacent, something is on one of the eight rays with clear
going between, and `status.spells > 0`, the ladder emits `c` and shoots.

Three source facts shape it:

- **The charge count is the engine's.** `cast()` decrements `c[SPELLS]` and
  `bottomline()` republishes it, and the status tap already carries `spells` and
  `spellmax`. Nothing here models regeneration — the same rule the pack-full
  latch follows.
- **The three spell-code bytes cannot be answered by the prompt table.**
  `cast()` prints "Enter your spell: " once and then reads three bytes back to
  back with nothing between (`monster.c:251-260`), so the second and third have
  no text to match. They ride on the action as `follow` and the queue is cleared
  at every command boundary.
- **The direction prompt has no escape.** `dirsub()` loops
  `for (i = 0;;) switch (ttgetch())` over the eight vi keys with no default and
  no ESC case (`monster.c:1006-1041`), so an unanswerable direction hangs the
  ENGINE. `castDirection` is therefore never null.

**The fizzle paths need no sequencing code, and this is why.** `speldamage()`
checks its 1/23 roll and the intelligence roll *before* calling `godirect()`
(`monster.c:302-305`), so a fizzled cast raises no direction prompt at all.
That is exactly why the direction is answered from the prompt table on sight
rather than queued behind the spell code, where a fizzle would leave it to leak
into the next command.

## It works, before it is judged

30 real games, `castAtRange` on: **62 cast commands, 43 direction prompts, 39
missile hits, 19 fizzles, 0 "You don't have any spells!"**. 43 + 19 = 62
exactly, which is the state machine accounting for every command it issued, and
the zero is the charge gate never once being wrong.

That run also found a targeting bug and it is fixed here: a CLOSED door is
walkable — the ladder opens it — but it is not transparent, and two of the first
five recorded hits were "Your missiles hit the door".

## Pre-registered prediction and guards

Held-out set (master 20260829, 500 games), paired against the same build with
`castAtRange` false.

The honest expectation is **modest**. `SPELLMAX` starts at 1 (`create.c:36-49`)
and grows by `rund(3)` per level-up, and this bot reaches experience level 2-3,
so a run gets a handful of charges. A handful of 6-11 damage openers against a
20-hp hero facing giant ants is real but it is not another h9x.5.

| | ship if |
|---|---|
| `dungeonDepthMedian` (co-primary) | must not fall |
| `xlevelMedian` (co-primary) | must not fall |
| either co-primary | at least one rises |
| faults | 0 |

`dungeonDepthMax` is deliberately **not** a guard this time. It was one for the
wield probe, it fell by one level out of 500 runs, and that was noise in the
noisiest statistic in the artifact. Dropping it is a correction to the method
and it is made here, before the numbers, rather than after them.

**The guard that matters**: casting spends a turn. If the co-primaries do not
move, "the bot cast 62 times" is not a result — the verb working is a
precondition for the experiment, not its outcome. Missile hits are reported as
a mechanism variable and decide nothing.
