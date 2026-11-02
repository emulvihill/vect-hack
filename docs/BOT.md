# The Larn bot, the gym, the reflect loop, and the bench

Demoted from `AGENTS.md` (vect-hack-2dr). AGENTS.md keeps the command names
and the invariants; this file keeps the reasoning, most of which is a record of
a measurement that came out the other way.

The invariants AGENTS.md still states:

- **No fact and no readiness bar can seal a level.** `passable()` is
  `walkable()` (the map) minus `avoided()` (the KB), and the breach step that
  fires when nothing else is reachable asks `walkable()`.
- **Ids, confidence, merging and evidence scope are ours, never the model's.**
- **`--kb <dir|none>` (default `none`)** names the knowledge state a batch
  played under, and every summary records it.
- **`data/kb` is empty by decision, not by omission.** Phase 1 and Phase 2 are
  both closed; every earned fact set lost depth on held-out.
- **Report `npm run bench:larn` beside `scripts/dev/bench-pair.mjs`, always.**
- `scripts/dev/policy-sweep.mjs` refuses `--set held-out`. Nothing in code
  keeps a held-out seed out of a reflection — that wall is the runbook's.

Specs and reports, newest last:

- `docs/specs/2026-08-17-self-teaching-bot-design.md` (Phase 0/1a)
- `docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md`
- `docs/specs/2026-08-21-larn-engagement-design.md`
- `docs/specs/2026-08-28-larn-bench-design.md`
- `docs/reports/2026-08-18-larn-baseline.md` (read its pilot caveat)
- `docs/reports/2026-08-21-larn-1b-ab.md`
- `docs/reports/2026-08-24-larn-phase1-closing.md`
- `docs/reports/2026-08-28-larn-descent-readiness.md`
- `docs/reports/2026-08-28-larn-r5-learning-run.md`
- `docs/reports/2026-08-29-larn-phase2-closing.md`

## The survivor ladder (`?bot`, `LarnBotPlayer`)

For `?game=larn`, `?bot` (same pacing flags) hands the game to
`src/modules/larn/bot/LarnBotPlayer.ts` — a survivor ladder over the semantic
map that answers Larn's own prompts. Whether to start a fight is `engage()`, not
a threshold: a learned threat is a claim about a *being* and is compared to what
the hero can absorb (hp fraction plus an experience term, uncapped above 1 so a
healthy hero fights anything), because Phase 1b compared it to a constant and a
table of honest 1.0s read as "never fight". Declining costs a bounded step away
rather than a fall-through, and a cornered hero swings anyway. `passable()`
refuses a being and a known trap, so either can seal a level into a pocket the
ladder circles until the command cap; the breach step is what removes that wall
— route beside an engageable monster and let the fight step have it, or cross
the trap once nothing else is reachable. The anti-stuck memory that names those
walls latches on the MAP, not on movement: a step that did not move the hero
blocks the cell it aimed at for the level, unless that cell still shows a
*closed* door, which is Larn refusing at random rather than terrain refusing at
all (`rnd(11) < 7`, object.c OCLOSEDDOOR — it prints nothing and a success is
visible only as `OOPENDOOR`). Three unlucky rolls used to seal a door forever,
one closed door in six. Carrying capacity is the engine's to
report, never ours to model: `LarnBotModel.packFull` latches on Larn's own "You
can't carry anything else" (global.c:481), the prompt table then answers items
with `(i) ignore` and the loot step stops routing to them altogether — pickup is
automatic, so wanting an item is only ever routing. The latch clears when the
status tap's `<slots>:<xlevel>` pair moves, because take()'s limit is
`15 + (LEVEL >> 1)`; that formula is deliberately not copied into the bot, so a
pack that is still full simply answers with one more refusal and re-latches.

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
level number (H=0, 1-10, V1-V3=11-13) and the seed bot takes any descent it is
offered, including the town's volcanic shaft. `--seed <master>` makes a batch
reproducible — game i always plays `childSeed(master, i)` — and
`scripts/dev/baseline-report.mjs` turns one such batch into the committed
baseline artifacts (per-seed CSV, re-run manifest, report) under
`docs/reports/`. The game-free half lives
in `src/bot/` (trajectory log, scoreboard, canonical record, KB, grid pathing);
every other Module's
gym child follows the same contract (`scripts/dev/bot-gym-utils.mjs`). 
### Phase history: what has and has not been shipped

Phase 0
and Phase 1a of `docs/specs/2026-08-17-self-teaching-bot-design.md`;
the Phase 1a baseline is `docs/reports/2026-08-18-larn-baseline.md`
— read its pilot caveat before quoting a rate out of it. Phase 1b then ran the
loop for real and its held-out A/B rejected the first earned knowledge base
(`docs/reports/2026-08-21-larn-1b-ab.md`), so `data/kb` is empty by
decision, not by omission. **Phase 1 is now closed**
(`docs/reports/2026-08-24-larn-phase1-closing.md`): four runs, zero
facts shipped, every measured gain traced to the prior-admitted terrain half
while the earned threat half was a regression. **Phase 2 (`vect-hack-h9x`) is also closed**
(`docs/reports/2026-08-29-larn-phase2-closing.md`): its premise was
that the bot needed verbs, and three independent lines say otherwise — two verbs
built and working moved neither co-primary, the one knob ever searched was
already optimal, and the loop's cleanest fact set lost depth in every arm. Its
yield is the instruments below and two mechanisms, `vect-hack-h9x.22` and
`h9x.23`; its children stay open on their own merits. Start there, not at
another verb. 
### The bench, and what a knob has to earn

Phase 2 is read against **one frozen number**, `npm run bench:larn`
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
63.5→598 (`docs/reports/2026-08-28-larn-descent-readiness.md`). No
readiness bar can seal a level: the breach steps route on `walkable()` and ask
it nothing. Every verb since is a **knob that ships off until it earns its
place** — `wieldProbes` (measured null, h9x.6) and `castAtRange` (h9x.4) — each
with a pre-registered bar, a paired same-build control, and a test pinning that
the knob at its shipped value makes the code inert. A verb that works is a
precondition, never the result. **Report `npm run bench:larn` beside
`scripts/dev/bench-pair.mjs`, always**: dungeon depth runs 0-10 and its median
ties two thirds of any comparison, so the co-primary alone reads "no effect"
where it means "none I can see" — the paired per-seed sign test is what tells
those apart, and it is a sensitivity check and never a ship rule
(vect-hack-h9x.2). `scripts/dev/policy-sweep.mjs` searches a knob over the bench
set and refuses `--set held-out`.

### r5, and the two mechanisms it named

That A/B's own post-mortem named the seam it lost on
and `docs/specs/2026-08-21-larn-engagement-design.md` fixed it. **r5**
(2026-08-28) is the first learning run over a corpus with no shaft rides: 150
games, 415 deltas, 97 facts, no probe leak — and every arm LOST depth on
held-out, so `data/kb` is still empty by decision. The two mechanisms it named
are worth more than the facts: `avoid-terrain` ratchets its threshold upward on
the capacity a hero took an exit with, so for an exit the bot must use it
converges on never using it (vect-hack-h9x.22 — and that is why r4c avoided the
ordinary staircase and permitted the shaft); and a well-formed threat table
still loses because the ladder's only way to decline is a retreat Larn's
monsters follow (vect-hack-h9x.23). Read
`docs/reports/2026-08-28-larn-r5-learning-run.md` before running a
sixth. The
rejected fact set is kept as the regression fixture under
`scripts/test/fixtures/kb-1b/` — read its README before touching it — and
`docs/reports/2026-08-21-larn-engagement.md` is what re-measuring
it found.

## The reflect loop and the knowledge base

`--kb <dir|none>` (default `none`) names the knowledge state a batch plays
under, and every summary records it: a row that cannot name what the bot knew
is not evidence about knowing it. `npm run bot:reflect -- --batch <dir>` closes
the loop (Phase 1b, `docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md`):
one finished game at a time, a digest of what that game's screen showed — never
the raw trajectory — goes to a model, and the applier turns the
fact deltas that come back into `data/kb/larn/facts.json`. Ids, confidence,
merging and evidence scope are ours, never the model's; every call leaves
`<run>/reflection.json`, and a sampled ablation probe re-asks each digest with
the death taken out, so a claim that survives its own evidence being removed
fails the whole batch before a byte is written — except `avoid-terrain`, whose
leaks are ADMITTED and printed (`PRIOR_ADMISSIBLE_KINDS`, b5f.23): no ablation
removes the descent record a terrain claim is about, so such a fact may be the
model's prior rather than this bot's play, and a report must say so. `--brain` picks who answers:
`local` is llama-server over the OpenAI chat shape (`--url`, `--model`), and
`claude` shells out to the `claude -p` CLI (`scripts/dev/brain-claude.mjs`,
`--model` `claude-opus-5`, `--effort` `high`, credentials the CLI's own OAuth
login — no API key). It is a separate adapter rather than a second `--url`
because the local body carries `temperature` and `seed`, which Claude has
nowhere to put — and because no OpenAI-compatible endpoint fronts Claude to
point at. Each call runs from a fresh empty temp directory with
`--system-prompt` replacing the harness prompt, so this repo's own
CLAUDE.md/AGENTS.md never reaches the reflecting model. It refuses
to manufacture a reflection: a refusal or a `max_tokens` truncation throws, and
a pass resumes from the transcripts already written rather than recording
either as a run that learned nothing. `--brain replay` serves recorded
replies instead of a model, which is what `npm run test:larn-reflect` drives.
That transcript is also the resume record: a pass reuses a recorded reply when
the prompt it would send is byte-identical AND the trajectory sha256 still
matches, and re-asks otherwise (vect-hack-b5f.13 — a 200-game pass is five
hours, and one evicted model at run 67 used to throw away all 66 finished
reflections). The recorded raw is reused, never the recorded parse:
parseDeltaDocument is the only thing allowed to normalize a delta. `--no-reuse`
forces fresh calls — a re-run on the local Brain, a re-roll on Claude, which
has no sampling control to pin. Reproducibility is the transcript's, not the
sampler's. The transport around the local model is the other half —
`scripts/dev/brain-fetch.mjs`, a POST with no clock on it and a bounded retry
on a dropped socket, and only on a dropped socket: a status the server chose to
send is an answer and stays the Brain's to reject. The cloud Brain has no use
for it; the CLI owns its own transport.

### What the applier will and will not take

A `threat` claim is the one kind the digest can ground in a single being, so
the applier gates it: an assert or confirm is rejected unless it names the
run's `killer`, which `__wrap_died` supplies as the map glyph of the creature
the epitaph names and `buildLarnDigest` publishes only when the screen drew
that glyph beside the hero (vect-hack-b5f.4 — without the join a model reads
adjacency as causation and blames a bystander). A run that names no killer —
survived, capped, won, killed by a trap, or killed by something it never saw —
teaches nothing about any being; `refute` and `retire` are not gated.
An `avoid-terrain` claim is gated the same way and against the same
derivation: `runGrounds()` (`src/bot/digest.ts`) is the one place that says what
a run may claim about — its killer, and the exits its hero *chose* to step onto
— and both the prompt and the applier read it, so a key the model is offered is
a key the applier takes. Ground the hero merely stood on is not a subject:
`finalTerrain` says where the fight was, not what was worth declining. Which
kind a lesson goes under is stated before the kinds are listed, because a
`note` compiles into nothing and 1b filed the shaft insight in one — 84 notes
against 2 avoid-terrain claims over 100 runs, and of the 53 that rode the
volcanic shaft to depth 11, none named `stairs:V` (vect-hack-b5f.6). `note`
stays: most of those 84 were about descent pacing, which no kind carries.
No fact can seal a level, whatever it says. `passable()` is `walkable()` (the
map) minus `avoided()` (the KB), and the breach step that fires when nothing
else is reachable asks `walkable()` — so a learned avoidance is a preference
the ladder takes another way around while there is one, and never a wall.
`scripts/dev/kb-ab-report.mjs` is the verdict: two gym batches over one
held-out seed list, paired seed by seed, strata frozen from the control arm,
read under the pre-registered rule in `src/bot/abReport.ts`. Nothing in code
keeps a held-out seed out of a reflection — that wall is the runbook's.
