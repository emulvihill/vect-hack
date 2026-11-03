# The Larn bot, the gym, and the bench

Demoted from `AGENTS.md` (vect-hack-2dr). AGENTS.md keeps the command names
and the invariants; this file keeps the reasoning, most of which is a record of
a measurement that came out the other way.

The invariants AGENTS.md still states:

- **No readiness bar can seal a level.** The breach steps that fire when
  nothing else is reachable ask `readyToDescend()` nothing.
- **The bot learns nothing.** Its knobs are hand-tuned constants,
  `DEFAULT_TUNING` in `src/modules/larn/bot/policy.ts`. The LLM learning
  apparatus that once wrote facts for it is retired
  (`docs/decisions/2026-11-03-retire-bot-learning.md`).
- **Report `npm run bench:larn` beside `scripts/dev/bench-pair.mjs`, always.**
- `scripts/dev/policy-sweep.mjs` refuses `--set held-out`.

Specs, newest last:

- `docs/specs/2026-08-17-self-teaching-bot-design.md` (Phase 0/1a: the gym)
- `docs/specs/2026-08-18-bot-phase1a-larn-baseline-design.md`
- `docs/specs/2026-08-28-larn-bench-design.md`
- `docs/specs/2026-08-28-larn-descent-readiness.md`
- `docs/specs/2026-08-28-larn-wield-by-measurement.md`
- `docs/specs/2026-08-28-larn-cast-at-range.md`

## The survivor ladder (`?bot`, `LarnBotPlayer`)

For `?game=larn`, `?bot` (same pacing flags) hands the game to
`src/modules/larn/bot/LarnBotPlayer.ts` — a survivor ladder over the semantic
map that answers Larn's own prompts. It fights whatever is adjacent, the first
being in DIRS order: declining a fight Larn's monsters will follow only buys
them free hits. `passable()` refuses a being and a known trap, so either can
seal a level into a pocket the ladder circles until the command cap; the
breach step is what removes that wall — route beside a monster and let the
fight step have it, or cross the trap once nothing else is reachable. The
anti-stuck memory that names those walls latches on the MAP, not on movement:
a step that did not move the hero blocks the cell it aimed at for the level,
unless that cell still shows a *closed* door, which is Larn refusing at random
rather than terrain refusing at all (`rnd(11) < 7`, object.c OCLOSEDDOOR — it
prints nothing and a success is visible only as `OOPENDOOR`). Three unlucky
rolls used to seal a door forever, one closed door in six. Carrying capacity
is the engine's to report, never ours to model: `LarnBotModel.packFull`
latches on Larn's own "You can't carry anything else" (global.c:481), and the
prompt table then answers items with `(i) ignore`. Pickup is automatic and
nothing routes to an item, so items are collected wherever exploring walks.
The latch clears when the status tap's `<slots>:<xlevel>` pair moves, because
take()'s limit is `15 + (LEVEL >> 1)`; that formula is deliberately not copied
into the bot, so a pack that is still full simply answers with one more
refusal and re-latches.

### The headless gym

`npm run bot:headless -- --game larn`
plays that bot with no browser: `scripts/dev/bot-gym.mjs` runs
`scripts/dev/bot-gym-larn.mjs` once per game (one process each, `--parallel` at
a time, `--timeout` seconds each), which boots the WASM engine in Node with
session-only storage and writes `<out>/<id>/trajectory.jsonl.gz` (every event and
key), `<out>/<id>/summary.json` (`RunSummary`: outcome, seed, deepest level,
level, hp, commands, Larn's own score, epitaph, last messages, and a
game-specific `details.larn` — gold, mobuls, conditions, inventory — that
reaches the file but never the CSV) and one row in `<out>/scoreboard.csv`. The
summary is rewritten as a `running` snapshot every 200 commands, so a killed
child still leaves its numbers. Outcomes: `died`,
`won`, `capped` (`--max-commands`), `timeout`, `fatal`; `died`/`won` are game
results and the rest are harness artifacts, never folded into a loss rate.
`depth` is Larn's own
level number (H=0, 1-10, V1-V3=11-13). `--seed <master>` makes a batch
reproducible — game i always plays `childSeed(master, i)` — and
`scripts/dev/baseline-report.mjs` turns one such batch into the committed
baseline artifacts (per-seed CSV, re-run manifest, report) under
`docs/reports/`. `--tuning '<json>'` plays
the batch under a partial override of `DEFAULT_TUNING` (`resolveTuning()`
refuses a knob it does not have, so a typo cannot play the defaults under the
arm's name), and every summary records the override it played under as
`tuning` — `{}` for the bot as shipped. The game-free half lives
in `src/bot/` (trajectory log, scoreboard, canonical record, run digest, grid
pathing); every other Module's gym child follows the same contract
(`scripts/dev/bot-gym-utils.mjs`).

### History

The ladder was the seed policy of a self-teaching bot: in Phases 1 and 2 an
LLM reflected on finished games and wrote facts — threats, terrain to avoid,
items worth walking to — that the ladder read. Both phases closed with zero
facts shipped, because every earned fact set lost depth on held-out seeds,
and the apparatus was retired on 2026-11-03
(`docs/decisions/2026-11-03-retire-bot-learning.md`). What survives of Phase 2
is the bench, its paired diagnostic, the knob sweep, and the shaft bar below.
The specs under `docs/specs/` remain the record of the rest.

### The bench, and what a knob has to earn

The bot is read against **one frozen number**, `npm run bench:larn`
(`docs/specs/2026-08-28-larn-bench-design.md`): co-primary median
deepest DUNGEON depth and median xlevel over a committed 500-seed set, with a
separate held-out master for verdicts. Depth is two numbers, not one — the
town's volcanic shaft drops a level-1 hero to internal 11 without walking a
single dungeon level, so pooling the chains reported the 2026-08-28 baseline as
depth 5 when the honest co-primary is **dungeon depth median 0, xlevel median
1, 50.6% shaft rides**. Every report before that spec quoted the pooled number.
**vect-hack-h9x.5 then moved it**: `readyToDescend()` refuses the shaft below
`shaftMinXlevel`, in routing AND at the prompt, and over 500 held-out seeds
dungeon depth median went 1→2, xlevel 1→2, shaft rides 49.4%→0 and commands
63.5→598 (`docs/specs/2026-08-28-larn-descent-readiness.md`). No
readiness bar can seal a level: the breach steps ask it nothing. Every verb
since is a **knob that ships off until it earns its place** — `wieldProbes`
(measured null, h9x.6) and `castAtRange` (h9x.4) — each with a pre-registered
bar, a paired same-build control, and a test pinning that the knob at its
shipped value makes the code inert. A verb that works is a precondition, never
the result. **Report `npm run bench:larn` beside
`scripts/dev/bench-pair.mjs`, always**: dungeon depth runs 0-10 and its median
ties two thirds of any comparison, so the co-primary alone reads "no effect"
where it means "none I can see" — the paired per-seed sign test is what tells
those apart, and it is a sensitivity check and never a ship rule
(vect-hack-h9x.2). `scripts/dev/policy-sweep.mjs` searches a knob over the bench
set, one `--tuning` arm per value, and refuses `--set held-out`: searching a
seed set is what burns it, so the winner is validated once against held-out by
hand.
