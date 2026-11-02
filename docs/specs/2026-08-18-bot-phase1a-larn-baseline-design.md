# Phase 1a — the measurable Larn baseline: status tap, world model, KB skeleton

Date: 2026-08-18. Bead: `vect-hack-b5f` (the Phase 1 epic). Parent spec:
`docs/specs/2026-08-17-self-teaching-bot-design.md`.

## Why this exists

The parent spec's Phase 1 bundles the KB store, the LLM `Brain`, per-run
reflection, periodic consolidation, a curriculum, a learned-reflex A/B, and a
Larn win rate. That is a research program, not one spec. It is also unmeasurable
today: Phase 0 shipped the gym but no batch has ever been run, so `.gym/` holds
no scoreboard and there is no slope for the loop to improve.

Phase 1 is therefore split into four sub-projects, each with its own
spec -> plan -> implementation cycle:

| Sub-project | Delivers |
|---|---|
| **1a (this spec)** | Seeded, fast, reproducible games; a native status tap; an enriched world model; the KB skeleton; a committed baseline report. |
| 1b | The KB writer: per-run LLM reflection and periodic consolidation, measured as a slope over batches. |
| 1c | In-run `Brain` directives on the slow timescale, and the curriculum over Larn's sub-goals. |
| 1d | The first learned-reflex experiment, promoted only on an A/B win. |

**1a changes no behavior.** Its whole job is to make improvement measurable and
to give 1b somewhere to write. A run of the bot after 1a should make the same
decisions it makes today, cell for cell.

## Scope

1a delivers four things in this order, then a pilot batch and a report. The
order matters: seeding first is what makes the behavior-equivalence test of step
3 possible at all.

1. **Seeded, fast games.** Folds in two beads already filed as children of the
   epic: `vect-hack-1x5` (deterministic seeding, whose proposed seam this spec
   corrects) and `vect-hack-9mo` (headless throughput, which must not be the
   whole-function no-op it asks for). Without the first, N games are not N
   samples; without the second, throughput pays for sleeps no one watches.
   Pre-1a action traces are recorded here, while the policy is still untouched.
2. **A native status tap** pushed from `lflush()`, beside the map export.
3. **An enriched world model**, taking its state from the tap instead of
   scraping tty rows 17 and 18, and keeping Larn's Score.
4. **The KB skeleton**: `data/kb/{larn,meta}/`, a game-free loader, the seed, the
   policy tuning split out from knowledge, and the learned tables declared empty
   but consulted.

Out of scope: any LLM, any fact the reflect loop would write, any change to how
the survivor ladder decides, and `vect-hack-pkz` (the shipped trap-subtype leak,
whose fix would change what the renderer draws).

## Seeding and the clock

Larn has two random sources and one seeding site. `newgame()` calls
`time(&initialtime)` and then seeds both — `seedrand(initialtime)` for the
`randx` LCG behind `rnd()`/`rund()`, and `srandom(initialtime)` for libc
`random()` (`external/larn/io.c:211-218`, `header.h:435-439`, `data.c:166`).
`random()` has exactly one consumer, `fortune.c:93`.

`vect-hack-1x5` proposes `--wrap=srandom/seedrand`. That cannot work as written:
`seedrand` is a macro, not a linkable symbol.

**The seam is `--wrap=newgame`.** `__wrap_newgame()` calls `__real_newgame()`,
then — only when the harness installed a seed — assigns `randx` and calls
`srandom(seed)`. `newgame` is a real symbol (`extern.h:118`, `io.c:211`), called
once from `main.c:138`, and `--wrap` is already this build's idiom
(`scripts/build/larn-wasm.mk:98-101` wraps `read`, `exit`, `died`, `savegame`,
`yylex` and more).

Wrapping `time()` instead would be wrong twice over. `time()` has non-seeding
consumers — the score file (`scores.c:688`) and diagnostics (`diag.c:226`) — so
a wrap contaminates values Larn persists. And `gltime` is a **turn counter
incremented by gameplay** (`regen.c:40`), not a wall-clock derivative: it becomes
reproducible because the decisions are reproducible, not because time is frozen.

One wasm artifact, not two: the seed arrives through an exported
`larn_set_seed()` that the gym calls and the browser never does, so an ordinary
game keeps its real `initialtime` and its real timestamps.

**Scope of the guarantee: fresh games only.** Larn saves neither `randx` nor
libc `random()` state, so a restored save cannot be bit-reproducible. Nothing in
1a depends on that; the gym plays fresh games.

The gym gains `--seed <n>` and derives each child's seed deterministically from
it. Each run records the seed it actually used.

## Throughput without changing observations

`vect-hack-9mo` asks for a no-op `nap()`. Taken literally that is a trap:
`nap()` calls `lflush()` **and then** `usleep()` (`external/larn/nap.c:17-23`).
Replacing the function wholesale drops display flushes, which drops events the
world model is built from, which can change decisions — silently corrupting the
baseline the speed-up exists to produce.

Only `usleep()` may be suppressed, and only in gym mode. The check: for a fixed
seed set, delay-on and delay-off must produce the same canonical action trace.

## The native status tap

The tap is **pushed from native code**, not pulled from the host. `lflush()`
builds the public status projection and invokes a `VectLarn.statusBatch`
callback, exactly as the map export invokes `mapBatch`.

That shape is forced by two facts. The headless gym does not use `worker.ts` at
all — it reimplements the `globalThis.VectLarn` bridge itself
(`scripts/dev/bot-gym-larn.mjs:61-93`), so a tap the worker called on `flush`
would never fire in the very runner the baseline is measured with. And calling a
wasm export from inside the shim bridge is a known hazard in this repo: the
ordinary async bridge answers on a microtask and Asyncify starts a real unwind
that exits the export early, having done half its work. Pushing from `lflush()`
avoids re-entering the module from its own callback.

A new `src/modules/larn/statusRecords.ts` mirrors the word layout, as
`mapRecords.ts` mirrors the map export; the two stay in lockstep and a test
enforces it. C writes the Int32 record plus a raw UTF-8 blob; **TypeScript
decodes the names**, following the same precedent. The dirty check that
suppresses unchanged pushes must compare the complete serialized record,
inventory bytes included.

### What it exports, and why each field is legitimate

The map export is deliberately faithful to what the player can see — it refuses
to become an oracle during blindness (`main-wasm.c:215-224`). The status tap
inherits that discipline, and the projection is defined by **what the screen
prints**, not by what the C state holds:

- **The scalars `bot_linex()` prints** (`display.c:66-95`): spells current/max,
  AC, WC, experience level, experience, HP current/max, the six stats with STR
  as `STRENGTH + STREXTRA` the way the engine displays it, and gold.
- **The dungeon level as the screen shows it.** When `TELEFLAG` is set the
  status line prints `LV: ?` (`display.c:84-91`); exporting the flag alongside
  the true level would hand the bot the depth the screen is hiding. The tap
  exports an unknown sentinel in that case.
- **The 17 `botside()` condition flags as presence, not counters**
  (`display.c:177-220`). The player sees the label "Hasted"; they never see the
  remaining turns. Exporting `c[HASTESELF]` would hand the bot a number the
  screen withholds, so the tap exports 0 or 1.
- **The clock as `qshowstr()` prints it**, not raw. The screen shows
  `(gltime + 99) / 100 + 1` elapsed and `(TIMELIMIT - gltime) / 100` remaining
  (`main.c:361`). The tap exports those two rounded values. Raw `gltime` is
  finer-grained than anything the player can read; if the harness wants it for
  evaluation, it goes in privileged telemetry that never enters a trajectory or
  reaches KB reflection.
- **Inventory: the public `show3()` projection, reproduced.** Exactly 26 slots
  (`iven[26]`, `data.c:127`). Identification is *not* `know[][]` — that is map
  visibility (`header.h:341`). A potion or scroll is identified when
  `potionname[ivenarg[k]]` / `scrollname[ivenarg[k]]` is non-empty
  (`main.c:594-604`); `show3()` itself is a terminal writer, so the tap
  reproduces its output rather than calling it. Raw `ivenarg` and the raw
  potion/scroll subtype are never exported. Each slot carries its letter, a
  **coarse public class** (potion, scroll, weapon, armor, …) — not the native
  object id — and the rendered name.

This is the field where cheating would be easiest and most fatal to the premise:
identification is something 1b has to learn from play. Two tests guard it — a
parity fixture set covering unknown and known potions and scrolls, enchantment
suffixes, and wielded/worn markers; and an assertion that for an unidentified
item the true type string appears nowhere in the emitted payload.

### A known leak this boundary does not yet close

`larn_map_info` already exports more than the screen shows: `OTELEPORTER`,
`OTRAPARROW`, `ODARTRAP` and `OTRAPDOOR` all render as `^` (`data.c:179`), but
the export gives each its own kind (`main-wasm.c:405-425`). A bot can tell a
dart trap from a trap door without triggering one. Filed as **`vect-hack-pkz`**
and deliberately left out of 1a, which promises no behavior change: collapsing
the kinds changes what the renderer draws, and that ruling comes first.

## World model and run records

`LarnBotModel` takes its state from the `status` event, and `parseStatus()`'s
regexes over rows 17 and 18 are removed. One source of truth, and the brittle
half of the model goes away. Adding the event is a protocol change: the
`LarnEvent` union, the recorder and the player all learn about it.

The score-line text path stays: the epitaph is printed text at death, not engine
state. It gains one thing — **Larn's own Score**, which `diedsub()` prints and
`causeOfDeath()` currently matches and discards. Score is the continuous metric
that can show improvement while the win rate is still zero, and throwing it away
would have left the baseline much blinder than it needs to be.

The shared records stay game-neutral, which the first draft of this spec got
wrong by piling Larn's inventory, gold and mobuls into `RunSnapshot`:

- **`RunMeta` gains `seed`** — it is run metadata, not game state.
- **`RunSnapshot` gains `score`** — every engine in the campaign has one.
- **Everything Larn-specific goes in a typed `details` extension**
  (`details.larn`: mobuls elapsed and remaining, gold, the inventory list),
  carried in `summary.json` and not in the CSV.
- **`SCOREBOARD_COLUMNS` gains `seed` and `score` only.** "Gametime" is not
  added: it has no consistent cross-engine meaning, and Larn's clock is already
  in `details.larn`.

## The knowledge base skeleton

```
data/kb/meta/facts.md      cross-game principles + process lessons (NL)
data/kb/meta/facts.json    the structured half
data/kb/larn/facts.md
data/kb/larn/facts.json
data/kb/larn/policy.json   baseline policy tuning (not knowledge)
```

Plain git-trackable files, per the parent spec: diffable, so the LLM's future
edits are reviewable like code.

**Facts and tuning are separate things.** `REST_LIMIT`, `STUCK_LIMIT` and the
half-HP rest threshold are baseline policy configuration — knobs the ladder was
born with — not claims about Larn that anything learned. They live in
`policy.json`. `facts.json` holds only things that could in principle be earned
or refuted by play. Conflating the two would make the provenance audit
meaningless on day one.

Every fact carries `id`, its text or value, `confidence`, `provenance`, and
`updated`. Provenance names the trajectory hash and the event range that
supports it, not just a run id — a bare id proves nothing, and `.gym/` is
outside git and can disappear. A loader check validates that referenced
evidence exists.

**What that claim is worth, honestly.** Provenance is an audit trail, not
enforcement. A model with tool access could read the engine's tables and attach
invented evidence, and its pretrained knowledge cannot be erased. The defensible
claim is narrower and worth stating plainly: *no curated engine tables enter
through system-controlled channels, and reflection input is restricted to public
trajectories.* The seed commit is reviewable; that is the enforceable part.

`src/bot/kb.ts` is game-free — types, validation, and the merge of the meta tier
over the engine tier. It takes content that is handed to it and **never touches
the filesystem**: the browser bot shares this code, so a Node-only `fs`
dependency would break it. The gym child reads the files and passes the text in.
It obeys the `src/bot/` source-load rules (relative `.ts` specifiers,
erasable-only TypeScript) because node loads it straight from source.

The learned tables — monster threat keyed by `(ch, color, depth)`, item value,
terrain avoidance — ship declared, consulted, and empty, with their neutral
lookup behavior and precedence defined explicitly.

### The empty-table invariant, and how it is actually proved

A unit test asserting "the lookup returns null" is tautological: it tests the
refactor against itself, not against the stateful brain that exists today. Both
reviewers independently said so, so the ordering of the work is part of the
design:

1. Land deterministic seeding, touching no policy code.
2. Record canonical action traces over a fixed seed set — the pre-1a behavior,
   captured as data.
3. Land the status tap, the model change and the KB refactor.
4. Replay the same seeds and compare command by command, ignoring the newly
   added status events and metadata.

That is a real regression test, and it only became possible because 1a adds
seeding first. It is also the reason the seeding work must come first in the
plan rather than wherever it is convenient.

## The baseline

**100 games is a pilot, not a promotion baseline.** No variance figure for this
bot exists yet, so no sample size can be justified in advance; the first batch
exists to measure that variance. The arithmetic is worth stating up front: at 0
wins in 100 games the two-sided 95% binomial upper bound on the win rate is
still about 3.6%, so a later "small but real" improvement would be
indistinguishable from noise. Anyone reading the report needs to know that
before quoting it.

What the batch produces:

- **Canonical per-seed outcomes, committed as data** — not only prose. Paired
  per-seed comparison is the whole statistical advantage of deterministic
  seeding, and an aggregate Markdown table cannot support it.
- **The reproducibility manifest**: the seed list, command and timeout limits,
  the git commit, the wasm artifact checksum, Node and Emscripten versions, and
  the concurrency the batch ran at.
- **Distributions with confidence intervals**, not bare point estimates: score,
  depth, commands survived, mobuls consumed, and the death-cause histogram.
- **Outcomes separated by kind.** `died` and `won` are game results; `capped`,
  `timeout` and `fatal` are harness results and must never be counted as losses.
- **Throughput as p50/p95 per game at a stated concurrency.** "Wall-clock per
  game" is ambiguous under parallel load.

Two seed cohorts are drawn and frozen now: a **training** cohort that later
phases may reflect on, and a **held-out evaluation** cohort they may not. Mixing
them would let 1b learn its own test set.

The prose report lands at `docs/reports/2026-08-18-larn-baseline.md`
beside the data.

**A baseline supports a difference, not a slope.** The parent spec's success
signal is a rising slope over runs; that needs repeated held-out evaluation
batches across training checkpoints, which is 1b's harness to build. 1a
establishes the first point and the method.

## Tests and gates

- **Unit** — status record decode against fixtures; the identification parity
  fixtures (unknown/known potions and scrolls, enchantment suffixes, worn and
  wielded markers) plus the "true type never appears" assertion; the KB loader
  (schema, provenance required, missing evidence rejected).
- **ABI** — the tap's C word layout matches `statusRecords.ts`.
- **Behavioral equivalence** — the recorded pre-1a action traces replay
  identically after the refactor (the four-step ordering above).
- **Delay equivalence** — `usleep`-suppressed and normal runs produce the same
  canonical trace for a fixed seed set.
- **Reproducibility** — two batches over the same seed list produce identical
  **canonical gameplay records**: seed, outcome, depth, score, command count,
  public clock, cause, and an action digest. Ids, timestamps, durations and
  event counts are excluded, because they cannot match. The gate runs on
  command-capped fixtures so a timeout can never make it flap.
- **Unchanged** — the Larn persistence suite (seeding must not reach saves or
  scores) and the vectorview suite (the browser `?bot` shares the model).

## Acceptance

1. A seeded batch is reproducible on the canonical gameplay record defined
   above.
2. The pre-1a action traces replay identically after the refactor.
3. The pilot batch is committed as per-seed data plus a manifest plus a prose
   report, with confidence intervals and harness outcomes separated from game
   outcomes.
4. `npm test` covers the tap decode, the identification parity fixtures, the KB
   loader and the trace equivalence, and every existing suite stays green.

## Risks

- **The tap is where cheating would enter the system.** Every exported field
  needs a justification tied to what the screen prints. `vect-hack-pkz` is proof
  the discipline can slip: a shipped export already leaks trap subtypes.
- **Seeding must not reach an ordinary game.** `--wrap=newgame` keeps real
  timestamps, and the persistence suite is the containment check.
- **Removing `parseStatus()` touches the browser bot too**, not only the gym.
- **The two `VectLarn` bridges are duplicated**, so every native callback must be
  added twice. The tap makes that cost concrete; if a third callback follows,
  the duplication is worth its own bead.
- **The pilot may show the bot is far from any win.** That is information, not
  failure — but it means 1b's budget should be planned against score and depth
  movement, not against a win rate that may stay at zero for a long time.

## Second opinion

Reviewed 2026-08-18 by Codex (`gpt-5.6-sol`, xhigh) and GLM (`glm-5.2:cloud`);
both returned "revise first" and this revision is the result. Codex found the
seeding seam, the impossible reproducibility gate, the `gltime`/`TELEFLAG`
leaks, the `nap()`/`lflush()` hazard, the `know[][]` error, the gym's bypass of
`worker.ts`, and the shipped trap-subtype leak. GLM independently found the
discarded Score. Both independently rejected the original empty-table test as
tautological. Every load-bearing claim was verified against the source before
being folded in.
