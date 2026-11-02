# Self-teaching bot — an LLM that learns roguelikes by playing them

Date: 2026-08-17. v2 (same day): the engine order is decided — **Larn →
Moria → Angband → NetHack** — and a **black-box seed policy** is adopted: the
bot learns from the game itself, not from anyone's tables. Builds on each
Module's semantic stream and on the NetHack `?bot` player
(`src/modules/nethack/bot/`, spec `2026-07-31-bot-player-design.md`) as the
most mature reference body.

## The thesis

NetHack is unusual for an AI target: a large fraction of the skill that
reaches the climax (Killing Yendor) is **factual and strategic knowledge**, not
just fast perception-to-action. "A wraith drains energy, so never let it touch
me." "This potion is heal, identified." "Level 12 is lethal until I'm level 14."
"That monster splits, so one hit doesn't win." Most of these are *statements* a
player accumulates over many games, and they can be **written down, reasoned
over, and reused** — which is exactly what an LLM is good at and what a pure RL
agent has to re-derive from millions of painful deaths. The same holds, at a
smaller scale, for Larn, Moria and Angband.

So the design is neuro-symbolic: **the LLM is the knowledge curator and
strategist; the game's own text is the teacher; a fast low-level policy is the
hands; and the whole thing improves through a reflect → extract → consolidate →
retrain loop.** The bootstrap is deliberately thin: the bot starts knowing how
to *operate* the game (key bindings, prompt semantics, survival common sense).
Tactical and strategic knowledge — monster behaviors, item values, level
strategy — must be **earned in play**, written by the reflect loop with
provenance. The LLM never tries to emit every keystroke at game speed (it's too
slow and too costly); it sets goals and tactics on a slow timescale and curates
the facts that both it and the fast policy consume.

## Engine order: Larn → Moria → Angband → NetHack

The campaign order is the climax-difficulty order, and each engine is a full
iteration of the same loop:

| Engine | Climax | Why it sits here |
|---|---|---|
| **Larn** | Bring the potion of cure dianthroritis home before time runs out (`died(263)`, "a winner") | Smallest game: a handful of levels, a small monster/item set, short games, no character creation, no hunger. The only engine where **mastery** (reliably winning) is a realistic first-iteration target — the loop is validated end-to-end against a true win condition, not just a depth slope. |
| **Moria (Umoria)** | Find the Treasure of Moria on a deep level; the game ends when it is found | Bigger space, a classic survive-and-explore climax with no boss or quest. This build has **seed control** (the Moria persistence suite drives seed/export/import) → scenario curriculum: spawn the bot in a specific situation to earn a specific lesson. |
| **Angband** | Kill the Demon Lord in the Deep | Large monster/item space, a **linear boss climax** — no mandatory quest, a clean sub-goal ladder (get strong → descend → the Lord). |
| **NetHack** | The quest, the Amulet of Yendor, back to level 1, Killing Yendor | The hardest climax in the family: a multi-stage, stochastic quest sub-goal that no bot has solved, then the amulet level, then the return. Last, so the platform, the loop, the fast policy, and the meta-strategy each get **three rehearsals** first. |

The point of the ladder: **the first three engines exist to make mistakes
cheap.** Per-engine facts (monsters, items, levels) do *not* carry over — a
wraith fact is useless in Larn — but the **meta-knowledge does** (L2 below),
and the learning system itself (reflection prompts, reward shaping, policy
architecture, discovered failure modes) is refined each iteration. By the time
the bot faces the quest, it has won Larn, found the Moria treasure, and (with
luck) killed the Lord — and it carries three campaigns' worth of process
lessons about *how to learn*.

## What we already have, per engine

- **Larn** (`src/modules/larn/`): terminal (`LarnGrid`, 80×24) + semantic map
  adapter (`larn_map_info` → packed records → `LarnClassifier` → a 67×17
  `CellGrid`), vector/debug views, the `__wrap_yylex` command discriminator
  (`getKey` with `cmd=1` is a `parse()` boundary, `cmd=0` a nested prompt),
  boot smoke, persistence/checkpoints. **No bot yet** → needs the smallest
  "survivor" baseline policy + world model of the four.
- **Moria** (`src/modules/moria/`): exact 80×24 terminal **plus a sanitized
  semantic exporter** (the cleanest semantic channel in the repo), source-owned
  input/overlay seams, seed/save/score, turn-tail checkpoints. No bot yet.
- **Angband** (`src/modules/angband/`): semantic view + classifier, headless
  boot, and the built-in **borg** playing unattended (`?borg`, 10-minute gate).
  The borg is **not a teacher** (see the seed policy). No external bot.
- **NetHack** (`src/modules/nethack/`): the most mature body — `BotPlayer` /
  `BotModel` / `BotBrain` (a "solid survivor": priority ladder over an 80×21
  semantic grid, BFS exploration, prompt rule tables) + the headless boot
  pattern (`scripts/test/test-nethack-boot.mjs`). It survives early levels but
  has no cross-run memory, no item strategy, no combat tactics, no idea of the
  quest. It is now the **last** target, not the first.

The platform (L2 KB, L4 loop, L5 harness) is built **once, engine-agnostic**,
in a shared `src/bot/` layer that, like `src/render/`, knows only the
Backplane's `CellGrid`. Each engine adds a thin adapter under its Module: a
world model over its semantic stream, prompt tables, a baseline policy, and a
milestone definition.

## Architecture — five layers plus the loop

```
 L0  Environment   The real engine (WASM) in a worker (browser) or headless
                   in Node, behind the Module's semantic event stream:
                   map cells, status, messages, prompts, game over.
 L1  Perception    Per-engine WorldModel: the semantic grid + status +
                   inventory + identification state + a monster-identity cache
                   + per-level map memory.
 L2  Knowledge     The KB — the learned "facts," in two tiers (per-engine and
                   shared meta) and two representations (NL for the LLM,
                   structured params for the fast policy). THE HEART.
 L3  Policy        Two timescales. Fast: per-engine baseline policy (then a
                   learned reflex policy). Slow: the LLM "Brain," invoked on
                   events and per-run, emitting structured directives. A
                   registry of LLM-acquirable ML tools plugs into the fast
                   path.
 L4  Self-teach    The loop: cold-start -> experience buffer -> reflection ->
                   consolidation -> retrain -> curriculum. LLM-driven.
 L5  Harness       Per-engine headless training rig (the "gym") over a shared
                   orchestrator, a sandboxed tool workspace, the persistent
                   KB + experience buffer.
```

### L1 — Perception (per-engine world model)

The raw screen is lossy — roguelikes hide monster HP, alignment (until they
act), item type (until identified), and everything in the fog. Perception
enrichment closes that gap:

- **Full status**: parse every status field the engine exports (AC, gold,
  level, XP, dungeon depth, condition flags), not just HP. The vocabulary
  differs per engine; the classifier or a tty-line parser is the adapter.
- **Inventory**: track item letters, quantities, and **identification state**
  (known vs unconfirmed) — the raw material for "identify before committing."
- **Monster identity**: a cache mapping (glyph `ch`, `color`, `depth`) to the
  best-known species + estimated level + threat, turning "a hostile glyph"
  into "a wraith, ~level 9, drains energy." The cache is itself *learned*:
  seeded with nothing beyond the glyph vocabulary, it grows as the bot observes
  confirmed identities (hits, deaths, recall screens).
- **Level memory**: remember each level's layout and what is known about it for
  the rest of the run (levels persist; monsters and items reappear).

### L2 — The knowledge base (the facts)

A persistent, **versioned** store of learned facts. Every fact carries a
confidence, a provenance (which runs produced it), and a timestamp, so
contradictions are resolvable and bad facts rollable back.

**Two tiers:**

- **Per-engine facts** (`data/kb/<engine>/`): monsters, items, terrain, levels,
  tactics and strategy *for that game*. Game-specific; does not carry over to
  the next engine.
- **Shared meta-knowledge** (`data/kb/meta/`): cross-game strategy principles
  ("disengage from a monster that outruns you," "don't fight below half HP,"
  "resource discipline," "peek before opening doors") and **process lessons**
  about the learning system itself ("reflection prompts work better with the
  last N states attached," "reward shaping X stopped the camping," "the
  anti-stuck threshold should be Y"). The meta tier is what "three iterations
  of learning from mistakes" concretely carries forward.

**Two representations of the same facts:**

- **Natural language** (`facts.md`): curated, human- and LLM-readable; the
  layer the LLM rewrites and reasons over. This is where "self-teaching"
  actually happens.
- **Structured params** (`facts.json`): what the fast policy consumes — a
  monster **threat table** (species -> threat score, `flee`/`use-ranged`
  flags), a terrain-avoidance table, an item-value / identification table,
  reward-shaping weights. Early on the LLM writes both layers in one step; a
  deterministic compiler comes later if the schema stabilizes.

**The seed policy (black-box rule).** The cold-start seed contains **only**:

- **Operational facts**: key bindings, prompt semantics, character creation,
  engine quirks (the kind this repo's AGENTS.md already encodes).
- **Survival common sense**: "lava burns," "walking into a monster attacks
  it," "don't stand still while something hits you." General and
  game-agnostic.

It does **not** contain monster-behavior tables, item-value tables, or
level/strategy advice — the class of thing the Angband borg's knowledge files
are. Those must be written by the reflect loop with provenance pointing at
runs. (The LLM's weights obviously know more than the KB; that is not
unloadable. The enforceable boundary is the **seed commit**: what enters
`data/kb/` as seed is reviewable, and everything else must arrive carrying
"learned from run N." General strategy principles the LLM already knows —
kiting, disengaging, resource discipline — are legitimate prior: they are
general intelligence, not game data.)

**The borg boundary.** The Angband borg is not an input to this system: no
ingestion of its tables, no behavioral cloning from its trajectories, no
reading its source for tactics. It ships in the repo for the merge gate and
may appear on the Angband scoreboard as a *comparison number* ("bot median
depth vs borg median depth"), nothing more. Eric's rule, 2026-08-17: using
the borg's knowledge is cheating; the bot learns from the game.

Storage: the KB lives in plain, **git-trackable files** (diffable, so the
LLM's edits are reviewable like code). The experience buffer (large) lives in
a data dir outside git (`.gym/`). (The tracker holds *tasks*; the KB is
*knowledge* and wants a plain-file, versioned home.)

### L3 — The policy split (fast / slow)

The timescale split is mandatory, not optional.

- **Fast (per-turn, must be reliable)**: a per-engine baseline policy — for
  NetHack the existing `BotBrain` (a priority ladder: emergency → fight → eat
  → loot → BFS-explore → descend → search, with anti-stuck and door handling);
  for Larn/Moria/Angband a similar small survivor ladder, since each is a
  turn-based grid game. The fast policy is **parameterized by the KB** — threat
  table, terrain avoidance, item rules all come from `facts.json`, so as the KB
  improves the baseline improves for free. Over time a **learned reflex
  policy** (a small DQN/PPO, or a decision tree) takes over the reflexive bits
  the ladder handles clumsily: when to attack vs flee vs use a ranged item,
  kiting, pathing under threat. The fast policy is per-engine (fresh per
  engine, optionally warm-started from the previous engine's weights — the
  action space is similar, the state space is not); the *recipe* (reward
  design, curriculum settings, architecture) is what carries over, via the
  meta tier.
- **Slow (the LLM, on-event + per-run, never on the per-turn path)**: the
  `Brain` reads an **enriched state digest** (compact: hero, depth, key
  inventory, nearby monsters with identified species + threat, recent
  messages, current goal) plus the relevant KB facts and its current goal, and
  emits **structured directives** — goal, target cell, item to use, caution
  level, `disengage`, `descend`, `kite`. The fast policy executes these
  between LLM calls.

**Tool acquisition** (the "download ML tools for whatever it wishes"
requirement): a **registry** of named, versioned, callable sub-tools the LLM
can add — a monster-HP estimator, a "flee" policy, a path planner, a
loot-value model. Each takes `(state, context) -> (action | advice)` and the
orchestrator invokes it from the fast path. The LLM can pip/npm install and
train new tools in the sandbox, then **promote only if a champion/challenger
A/B shows it beats the current one** (a bad tool must not ship).

### L4 — The self-teaching loop (the bootstrap)

1. **Cold start (thin, by policy).** Seed the KB per the seed policy above:
   operational facts + survival common sense, and the meta tier (general
   strategy principles + process lessons from previous engines, once they
   exist). No game-specific strategy tables. The bot starts knowing how to
   *operate* the game, not how to *win* it.
2. **Experience buffer.** Every run is recorded as a trajectory: the full event
   stream (map, status, messages, actions, prompts) plus a run summary (death
   cause or win, depth, level, kills, turns, notable events). Stored for
   replay and analysis. This is the raw material the LLM reflects on.
3. **Reflection (per-run, LLM).** After each game over — and at milestones —
   the LLM reads the run's tail + the outcome + key states and asks: *What
   killed me (or what did I do well)? What fact do I now know that I didn't
   before? What rule should I add or fix?* It emits **fact deltas** (new
   facts, corrections, confidence updates) and writes them to the KB with
   provenance. Examples: "I died to a wraith by melee — NEW: wraith drains
   energy, don't melee." / "I drank an unknown green potion and went blind —
   CORRECTION: not heal; mark unidentified." / "I keep dying to acid blobs at
   level 4 — STRATEGY: be more cautious / find better gear first."
4. **Consolidation (periodic + campaign-end, LLM).** Every N runs the LLM
   reviews the KB for contradictions, merges near-duplicates, updates
   confidences from the accumulated evidence, and rewrites facts into cleaner
   form. It also reviews its own **performance trends** (death-cause
   histogram, depth histogram) to name the current bottleneck and set the next
   focus. At the **end of each engine campaign**, a cross-engine consolidation
   distills per-engine facts into meta principles, updates the process
   lessons, and prepares the next engine's seed (operational facts + the meta
   tier — and nothing else).
5. **Retrain (periodic, LLM-orchestrated).** The LLM decides to retrain a fast
   policy on the experience buffer — fine-tune a combat DQN on the last N
   combat episodes, retrain the monster-identity model on more confirmed
   (species, glyph, level) examples. It writes the config, launches it in the
   sandbox, reads the metric, and promotes on a win. This is where "download
   and train ML tools" pays off.
6. **Curriculum (LLM-driven, per engine).** The LLM decomposes each engine's
   climax into ordered sub-goals and focuses both the bot and the reflection on
   the *next* sub-goal, so learning is targeted rather than diffuse:
   Larn — survive a level → descend → find the potion → get home in time;
   Moria — depth milestones → the treasure; Angband — level milestones → the
   Deep → the Lord; NetHack — level milestones → the quest → the amulet → the
   return. It also picks the **character build** per sub-goal where the game
   has one (the sturdiest option to start — for NetHack a lawful human
   Valkyrie, per the playtest notes) and adapts it as it learns.

### L5 — The harness

- **The gym**: one shared orchestrator (`scripts/dev/bot-gym.mjs`,
  `npm run bot:headless -- --game <name>`) that runs a per-engine child script
  once per game — a fresh process, a fresh dungeon, K at a time, each under a
  wall-clock timeout — and keeps `scoreboard.csv`. Each child boots its engine
  headless (every Module has a boot smoke to start from), wires the bot
  decorator against the engine's input seam, plays unattended at full speed
  (no pacing), records the trajectory, and writes a `summary.json`. The
  per-game files and the scoreboard columns are the same for every engine;
  only the child differs.
- **Sandboxed tool workspace**: where the LLM installs/runs ML code, trains
  models, and persists artifacts (weights + configs) to the registry.
- **The persistent KB + experience buffer** live here so learning survives
  across sessions.

## Metrics — how we know it's working

Per-engine milestones:

- **Larn**: **win rate** (the potion home in time) — the true win condition —
  plus deepest level, median commands survived, and the death histogram.
- **Moria**: median depth; % of runs reaching the treasure; total treasures
  found.
- **Angband**: median depth; hero level; Lord encounters; Lord kills. May be
  shown beside the shipped borg's numbers (a comparison, never an input).
- **NetHack**: median depth; quest milestones (questor found, task complete,
  amulet in hand); Killing Yendor.

- **The within-engine signal**: the slope of the primary metric over runs. A
  rising slope is the self-teaching loop working; a flat one is not.
- **The cross-engine signal**: does engine N+1 start **higher and faster**
  than engine N started (win-rate ramp, initial depth slope)? That is the
  measure of what "learn from mistakes" actually transferred.

## Build plan (each phase is independently valuable)

- **Phase 0 — the platform + the Larn gym.** Engine-agnostic core in
  `src/bot/`: trajectory format + recorder, run summary + scoreboard + stats,
  grid pathing, the shared orchestrator. Plus the Larn adapter
  (`src/modules/larn/bot/`): world model over the Larn semantic map + tty
  status lines, prompt tables, a small survivor baseline policy, a headless
  child off the Larn boot smoke. Deliverable: `npm run bot:headless -- --game
  larn` plays N games unattended and writes trajectories + a scoreboard. No
  LLM yet — just a fast, observable, replayable environment. Plan:
  `docs/plans/2026-08-17-bot-gym-phase0.md`.
- **Phase 1 — the loop on Larn.** The KB store (two tiers, two
  representations). The `Brain` (slow timescale) sets the goal, reacts to
  notable events, and does **per-run reflection** writing fact deltas to the
  KB; periodic consolidation; first learned-reflex experiments (Larn's small
  space is the right place to A/B a reflex DQN). **Target: a measurable win**
  — reliably bring the potion home (a win-rate threshold over a fixed run
  budget). Campaign-end: cross-engine consolidation writes the Moria seed.
- **Phase 2 — Moria.** Adapter over the sanitized semantic exporter; the meta
  tier carries over, Moria facts are earned. Use **seed control for scenario
  curriculum** (spawn the bot in specific situations to earn specific lessons).
  Target: find the Treasure reliably.
- **Phase 3 — Angband.** Adapter over the semantic view; target the Demon
  Lord. The scoreboard may show the borg's numbers beside the bot's.
- **Phase 4 — NetHack.** The most mature body; everything carries over. Target
  the quest → amulet → Yendor; the quest sub-goal gets the full accumulated
  meta-strategy.

Along the way, vecthack itself is fair game: bugs the bot exposes get fixed,
and integration seams the bot needs (a native status tap, a no-op `nap()` for
headless speed, a `?bot` for a Module) are ordinary features.

## Honest caveats

- **Killing Yendor is a very high bar.** Even the best RL agents reached high
  levels but the quest/amulet is a wall; humans who clear it have thousands
  of hours. The self-teaching approach's real advantage is that it **reuses
  the LLM's general intelligence** — reading, writing and reasoning over its
  own notes — which pure RL cannot; but under the black-box rule it does *not*
  get to reuse memorized game tables, so it is still a long, compute-heavy
  game with no guaranteed climax. The honest target is *maximize directed
  progress toward it*, engine by engine; winning Larn is the first real proof.
- **The LLM is slow and stochastic.** It cannot be the per-turn policy. The
  hierarchical split is mandatory; the KB is the stable memory the LLM
  re-reads each time (it does not rely on its own long context).
- **Cost.** Thousands of headless runs + per-run LLM reflection add up. Keep
  the LLM off the hot path (per-death + periodic only).
- **Bad facts are fatal.** A confidently-wrong fact can kill the bot. Carry
  confidence, require evidence, and gate every new tool by A/B — a regression
  must not ship.
- **Partial observability.** Monster HP/alignment/identity are hidden; the
  identity cache is probabilistic; the policy must stay robust to wrong facts.

## Open design choices

Phase 1b (spec `2026-08-19-bot-phase1b-larn-reflect-design.md`) settled the
first three; they are recorded here rather than deleted, so the reasoning stays
findable.

- **LLM provider** — *settled, local.* The `Brain` is an interface with two
  adapters: `local` (llama-server on `127.0.0.1:8090`, `qwen38-q5`, temperature
  0 and a fixed sampling seed) does the bulk per-run reflection, and `replay`
  serves recorded fixtures so the loop is testable with no GPU and no network.
  A frontier adapter was deliberately not built: it existed in the design to
  run an LLM consolidation pass, and that pass is deterministic instead. Note
  the provider sits off the measured path entirely — the evaluation arms call
  no model — so a weak provider costs time, never a result.
- **KB storage** — *settled, plain files.* `data/kb/{meta,larn}/facts.json`
  plus `facts.md`, with tuning apart in `policy.json`. Diffable, so the model's
  edits are reviewable like code.
- **NL->structured compiler** — *settled, and not the shape this asked about.*
  The model emits typed structured deltas directly; there is no free-text layer
  to compile. What is derived deterministically is everything downstream: fact
  ids from claim subjects, confidence from evidence counts, and the three
  policy tables from the facts (`src/bot/kbCompile.ts`).
- **Parallelism** — *still open,* and now in two places. The gym has
  `--parallel` for headless engines; the reflect host does not, and reflects
  runs strictly in sequence.
