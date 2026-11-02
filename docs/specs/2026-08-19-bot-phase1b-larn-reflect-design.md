# Phase 1b — the reflect loop: one earned fact, measured

Date: 2026-08-19. Bead: `vect-hack-b5f` (the Phase 1 epic). Parent spec:
`docs/specs/2026-08-17-self-teaching-bot-design.md`. Predecessor:
`docs/specs/2026-08-18-bot-phase1a-larn-baseline-design.md`.
Baseline: `docs/reports/2026-08-18-larn-baseline.md`.

## Why this exists

1a made the Larn bot measurable while changing none of its decisions. It
shipped deterministic seeding, a native status tap, a world model fed by it,
the `data/kb/` skeleton with the learned tables declared-but-empty, and a
committed 100-game baseline. The bot has learned nothing.

1b is the smallest complete circuit that changes that: a run is reflected on, a
typed claim is written to the KB with provenance, the fast policy reads it, and
a paired A/B on held-out seeds says whether it helped. Every mechanism that is
not on that circuit is deferred. The goal of 1b is **a simple learning run that
works end to end**, not a learning system.

## Scope

In: the run digest, the `Brain` interface and two adapters, the fact-delta wire
format, the deterministic applier, the fact-to-table compiler, the two policy
seams that make a learned fact actionable, deterministic consolidation, the
`--kb` evaluation arm, and one report.

Out, deferred to 1c/1d: in-run `Brain` directives, the curriculum, an LLM
consolidation pass, per-fact leave-one-out ablation, any learned-reflex model,
and any second engine.

## Two source findings this design rests on

Both were verified against the source before the design was fixed.

**The volcanic shaft is already distinguishable, and no native change is
needed.** Larn draws its four downward exits as four different characters:
`%` an ordinary staircase, `^` a down elevator, `E` the dungeon entrance, and
`V` the volcanic shaft (`objnamelist`, `external/larn/data.c:179`, with
`OSTAIRSDOWN 13`, `OELEVATORDOWN 14`, `OENTRANCE 54`, `OVOLDOWN 55` in
`header.h`). The exporter collapses all four to `KIND_DOWN`
(`src/modules/larn/native/main-wasm.c:451`), but the classifier carries the
source-true character through to `Cell.ch`, so the distinction survives into
the semantic grid. The exporter is not hiding anything the screen shows; it is
the KB's key that is too coarse. See "The two policy seams".

**Pickup is automatic.** `lookforobject()` runs on every move
(`external/larn/main.c:291`), so an item decision is a routing decision — walk
to the cell — and needs no command, no key and no prompt rule.

## The measurement contract

This section is **pre-registered and binding**. It is written before any 1b
batch runs, and a later phase that wants a different rule changes it here
first, in a commit that precedes the batch.

**Cohorts.** Training master `20260818`; held-out evaluation master `20260819`.
Reflection may read training-cohort trajectories only. No 1b process may read a
held-out trajectory for any purpose except computing the metrics below. The two
masters were checked to share no seed out to 5000 each, so the held-out cohort
may be extended by `childSeed(20260819, i)` without touching a training seed.

**The two arms.** Two batches over the same held-out seed list, on the same
commit and the same `larn.wasm`, differing only in whether the KB is loaded:
`--kb none` (control) and `--kb data/kb` (treatment). Everything else is held
fixed, including the command cap and the concurrency.

**Strata come from the control arm, not from the treatment.** Each seed is
labelled `volcano` or `surface` by what the *control* run did on it. Labelling
by the treatment run's own depth would be conditioning on an outcome the
treatment caused, which manufactures differences out of nothing. The control
arm is the pre-treatment behaviour by construction, so it is the honest source
of the label. Labels are written once, committed, and reused by every later
comparison on that seed list.

**Primary metric.** The median per-seed score delta (treatment minus control),
reported within each stratum and pooled, alongside a win / loss / tie count
over seeds. Score is Larn's own.

**Guard metric.** Within the control-surface stratum, the median per-seed depth
delta must be at least zero. A bot that survives longer by never descending has
not improved, and this is the assertion that says so.

**Missing data.** Larn prints a score only on its end-of-game line, so a capped
run has no score and the CSV's `0` is missing data, not a zero. The command cap
is raised until capped runs are under 1% of the control arm; any seed capped in
*either* arm is excluded from the score statistic, and the excluded count is
reported. A change that caps more games must not be able to read as a score
regression.

**Decision rule.** The KB ships if the pooled median per-seed score delta is
positive, the win count exceeds the loss count, and the guard holds. Otherwise
it does not ship, and the run is reported as a negative result.

**The slope is reported, never gated.** A slope over successive training
batches has no control arm and is confounded with every other change in the
tree. It is published if the batches produce it for free and cut the moment it
costs anything.

**No composite metric, and no significance machinery** beyond the paired median
and the win/loss count. The bimodality is handled by the strata, not by a
statistic.

## The spine

```
 .gym/<batch>/<run>/  ->  digest  ->  Brain.reflect  ->  fact delta (JSON)
                                                             |
                                        applier (ids, confidence, files)
                                                             |
                                              data/kb/larn/facts.json
                                                             |
                                     compiler -> threat / itemValue / avoidTerrain
                                                             |
                                            LarnBrain (the fast ladder)
                                                             |
                              two held-out batches: --kb none vs --kb data/kb
```

### The digest

A run reduces to one small object built from its trajectory and summary. The
digest is the only thing the model sees, so its contents are the enforceable
boundary of what reflection can learn from. It carries **public observations
only**, the same discipline the 1a status tap holds itself to:

- the outcome, the epitaph, and the last messages;
- deepest depth, experience level, HP and HP max at the end, commands, mobuls;
- what was adjacent to the hero over the final few frames, as `(ch, color,
  category)` — the killer is usually standing next to the corpse;
- the terrain the hero stood on and stepped onto over those frames, as
  `(category, ch, kind)`;
- **every descent taken**: the character of the exit used, and the depth and
  experience level at which it was used.

That last field is what makes the shaft learnable at all. Without it the model
can see that the bot died at depth 11 with no memory of how it got there.

The digest has a hard size cap so a batch of reflections stays cheap; the
builder truncates the message and frame lists to fit rather than emitting an
oversized prompt. `src/bot/digest.ts` defines the shape; the Larn builder lives
in `src/modules/larn/bot/digest.ts`.

### The Brain

`src/bot/brain.ts` declares one interface — a digest in, a raw delta document
out — and 1b ships two adapters:

- **`local`**: the OpenAI-compatible llama-server on `127.0.0.1:8090`, model
  `qwen38-q5`, temperature 0 and a fixed sampling seed. This does the bulk
  per-run reflection.
- **`replay`**: serves recorded responses from a fixture directory. This is the
  adapter `npm test` uses, so the whole loop is testable with no GPU and no
  network.

A frontier adapter is **not** in 1b. It existed in the design to run the LLM
consolidation pass, and that pass is deferred; adding an unused adapter would
be a mechanism without a caller.

Two properties matter more than the provider choice:

**Reflection is off the measured path entirely.** The evaluation arms call no
model — the KB is a static file. A weak provider costs time and tokens; it
cannot contaminate a result.

**Every call is recorded.** Model id, parameters, the full prompt, the raw
response, the parsed delta and every rejection are written beside the run. An
LLM is stochastic, so without the transcript the KB is an artifact nobody can
rebuild or review. With it, a fact's provenance names both the trajectory and
the reasoning that turned it into a claim.

**A local model is also the better fit for the black-box rule.** The rule's
weak point is that a frontier model already knows Larn and can launder
pretrained knowledge as "learned from run 47". A 27B local model knows
considerably less about a 1986 BSD roguelike. That narrows the leak; it does
not close it, and 1a's honest caveat still stands.

### The fact delta on the wire

The model **never writes a file**. It emits deltas; a deterministic applier is
the only thing that touches `data/kb/`. Bad output is then a rejection with a
reason, not a corrupted knowledge base.

```jsonc
{
  "op": "assert" | "confirm" | "refute" | "retire",
  "claim": { "kind": "threat",        "ch": "D", "color": 1, "depth": 11 }
         | { "kind": "avoid-terrain", "category": "stairs", "ch": "V" }
         | { "kind": "item-value",    "ch": ")" }
         | { "kind": "note" },
  "value": 0.9,
  "text": "a level-1 character taking the V shaft died in 18 commands",
  "evidence": [{ "trajectory": "<hash>", "from": 412, "to": 468 }]
}
```

Four rules the applier enforces, each of which removes a class of thrash:

- **The model does not choose ids.** The applier derives the id from the
  claim's typed subject — `larn/avoid-terrain/stairs:V`,
  `larn/threat/D|1|11`. Two runs that learn the same thing therefore hit the
  same fact and merge, instead of accumulating near-duplicates for a later pass
  to clean up. Most thrash is prevented here rather than repaired.
- **The model does not set confidence.** It is arithmetic over the evidence:
  `(support + 1) / (support + refute + 2)`. A model's self-reported certainty
  is the least reliable number in the pipeline and the one the fast policy
  would act on.
- **The model does not write table rows.** It proposes claims; the tables are
  compiled. See below.
- **Evidence is checked.** The named trajectory must exist and the event range
  must be within it. This is an audit trail, not enforcement — 1a said so
  plainly and it remains true.

An item-value claim names the map glyph, not the rendered item name, because
the policy's only consultation site routes over map cells and a cell carries
nothing but the glyph — the name is revealed on pickup, after the routing
decision, so a name-keyed row would never be read.

There is no `revise` op: an `assert` carrying a new value on the same subject is
a revision, and one fewer op is one fewer thing to specify. `retire` writes a
tombstone with a reason rather than deleting, because what the bot believed and
abandoned is what makes the audit readable later.

Rejections are recorded in the transcript, never silently dropped. A reflect
run that rejects most of its deltas is a finding.

### The compiler, and what `facts.json` holds

`threat`, `itemValue` and `avoidTerrain` stop being stored fields and become a
pure function of the facts. `facts.json` holds facts only.

This is not tidiness. Today those tables are bare records with no provenance
attached; if the model wrote them directly, the audit would cover `facts.json`
and quietly miss the three structures the policy actually reads. Deriving them
makes divergence impossible to express.

A fact contributes to a table only while it is active and its confidence is at
or above a floor. The floor is **tuning, not knowledge**, so it lives in
`data/kb/larn/policy.json` beside `restLimit` — the 1a separation holds: knobs
the ladder was born with are not claims about Larn that anything learned.

Because an empty fact list compiles to empty tables, and empty tables are inert
by construction, a KB-off run makes exactly the decisions the 1a bot made.

### The two policy seams

**The terrain-avoidance key gains the character.** `passable()` currently asks
`kb.avoidTerrain(under.category)`, and that key is `"stairs"` — so the only
reachable fact is *avoid every staircase*, which would delete descent from the
game. The key becomes `"<category>:<ch>"`, which is what lets a fact name
`stairs:V` — the volcanic shaft — while leaving `stairs:%` alone.

**`kb.itemValue` gets its first call site.** It was declared in 1a with no
consumer. The ladder gains a routing step: walk to a reachable item whose
learned value is above zero, ahead of frontier exploration. No pickup command
is needed. With an empty table the step never fires. The table is keyed by the
item's map glyph — `kb.itemValue(cell.ch)` — for the same reason the terrain
key gains one: the routing step sees cells, and a cell has a glyph and no name.

**`FLEE_THRESHOLD` stops being infinite and becomes tuning.** 1a set it to
infinity so it could never trip by accident; 1b lowers it deliberately, which
is the whole point of the phase. Threat values are on a 0..1 scale. What it
buys is narrow and should be described narrowly: the ladder **declines to
initiate melee** against a monster over the threshold and falls through to the
steps below. It is not a flee routine, and 1b does not add one.

### Consolidation, in its minimal form

Deterministic, no model pass:

- **Merge by derived id.** Same subject, one fact; evidence unioned and
  deduplicated by `(trajectory, from, to)`; confidence recomputed from the
  union.
- **Numeric claims take the median** of the asserted values across the
  supporting evidence, so one outlier cannot swing a table row.
- **Contradiction is handled by arithmetic.** A refuted fact's confidence
  falls, and a fact below the floor stops compiling into a table. Nothing needs
  to delete it for behaviour to change.
- **Trigger on evidence, not on a clock.** Consolidation runs when the applier
  has taken new deltas, never on a fixed run count that guarantees a rewrite
  whether or not anything was learned.

**Idempotence is a gate.** Applying the same delta set twice must produce a
byte-identical `facts.json`. A pass that keeps finding work on unchanged input
is thrashing by definition, and this catches it in a fixture test rather than
fifty batches later.

### The evaluation arm

- `scripts/dev/bot-gym.mjs` gains `--kb <dir|none>`, **defaulting to `none`**.
  An unflagged run is the seed bot, so the trace and reproducibility gates
  cannot be contaminated by a KB that happens to be on disk.
- Each run records the KB it played under — a hash of the compiled tables, or
  the empty string for `none` — in its metadata. A result is then attributable
  to a specific knowledge state. This is metadata, so `canonicalRecord()` is
  untouched.
- `scripts/dev/kb-ab-report.mjs` reads the two batches and emits the paired
  per-seed table, the strata, the primary and guard numbers, the excluded-pair
  count, and the mode-migration count. The report lands under
  `docs/reports/` beside the per-seed data, as 1a's did.

### Where the code lives

- `src/bot/digest.ts`, `src/bot/brain.ts`, `src/bot/factDelta.ts` (wire format,
  validator, applier) and `src/bot/kbCompile.ts` — game-free, and bound by this
  directory's existing rules: relative `.ts` import specifiers, erasable-only
  TypeScript, and **no filesystem access**, because the browser bot shares this
  code. The adapters use `fetch`, which both hosts have.
- `src/modules/larn/bot/digest.ts` — the Larn digest builder.
- `scripts/dev/bot-reflect.mjs` — the node host: reads a batch, builds digests,
  calls the Brain, writes transcripts, applies deltas, runs the probe.
- `scripts/dev/kb-ab-report.mjs` — the paired report.

### The ablation probe

A fact that would have been emitted regardless of the evidence came from the
model's priors, not from the dungeon. The probe re-runs reflection on a
deliberately mismatched input — one run's events paired with another run's
outcome, or the death event stripped — and checks whether the same claim
subject still appears.

**Where it runs matters.** Against the `replay` adapter the probe would test the
recording rather than the model, so it is a **reflection-time gate**: the
reflect script runs it over a sample of each batch, and the batch fails if any
sampled leak is found. A separate fixture test proves the probe machinery
itself detects a leak when one is planted — the same sabotage standard the
persistence tests were just held to.

## Tests and gates

- **Unit** — the applier: id derivation, confidence arithmetic, evidence
  validation, each rejection reason; the compiler: floor, active/retired,
  median for numeric claims, empty facts compile to empty tables; the digest
  builder against trajectory fixtures, including its size cap.
- **Idempotence** — the same delta set applied twice is byte-identical.
- **Leak probe machinery** — a planted prior-only claim is detected.
- **Replay end to end** — a fixture batch runs digest → replay Brain → applier
  → compiler → a KB, with no network.
- **Inertness** — with `--kb none`, and with a KB whose facts are all below the
  floor, the ladder's decisions are unchanged.
- **Unchanged** — `test:larn-trace`, `test:larn-repro`, `test:larn-status`, the
  Larn persistence suite, and the vectorview suite. The frozen 1944-keystroke
  trace is expected to stay green, because a KB-off run is the 1a bot. If a 1b
  change does move it, that fixture is re-recorded **on purpose**, with the
  behaviour change named in the commit message — never to turn a red gate
  green.

## Status

**The learning run happened on 2026-08-21 and the rule said NO-SHIP.** All five
acceptance criteria are met: the training batch produced 100 transcripts and 52
facts whose every citation is attested by the digest of the run it names, the
probe found no leak, both arms ran on the held-out cohort, and the
pre-registered rule was applied and reported as a negative result
(`docs/reports/2026-08-21-larn-1b-ab.md`, decision log 2026-08-21).
`data/kb/larn/facts.json` is empty again by that decision, not by omission. What
the run exposed — a threat value read as a melee veto, a digest that cannot join
the killer to a glyph, a `note` the ladder never reads, and a ladder that can
livelock — is 1c's material.

### How it stood when the circuit merged

**The circuit was built; the learning run had not happened.** Tasks 1-8 of
`docs/plans/2026-08-19-bot-phase1b-larn-reflect.md` shipped and are
merged: the digest, the Brain and its two adapters, the delta wire format and
its applier, the compiler, the two policy seams, the `--kb` arm, the reflect
host with its committed fixture batch, and the paired A/B report. Everything
below is exercised end to end against the `replay` adapter by
`npm run test:larn-reflect`.

Task 9 — the real training batch, reflection with the local model, and the two
held-out evaluation arms — is deliberately **not** in that merge. So
acceptance criteria 1, 3 and 4 are open by construction, `data/kb/larn/facts.json`
is still `{ "facts": [] }`, and no report exists under
`docs/reports/` for this phase. Bead `vect-hack-b5f.2` stays open
until they are met, and `vect-hack-b5f.2.1` (the loot step oscillates when a
valued item cannot be picked up) blocks it: that defect is inert only while the
item table is empty, which stops being true the moment the first treatment
batch carries an item fact.

## Acceptance

1. A training batch produces reflections, each with a committed transcript, and
   the applier writes at least one fact whose provenance names real evidence.
2. The compiled tables are a pure function of the facts, and an empty KB
   compiles to inert tables.
3. Both evaluation arms run on the held-out cohort under the pre-registered
   contract, and the paired report is committed as data plus prose.
4. The decision rule is applied and stated — including if the answer is that
   the KB did not help. A negative result reported honestly is a successful
   1b; a positive result that the contract cannot support is not.
5. `npm test` covers the applier, the compiler, the digest, idempotence, the
   probe machinery and the replay path, and every existing suite stays green.

## Risks

- **The model may learn nothing useful.** The mitigation is that the contract
  can say so. 1b is a circuit, not a promise about what flows through it.
- **A laundered prior looks exactly like a learned fact.** The probe narrows
  this and the local model narrows it further; neither closes it, and the
  defensible claim stays the one 1a wrote: no curated engine tables enter
  through system-controlled channels, and reflection input is restricted to
  public trajectories.
- **The shaft fact is a large, single-fact behaviour change.** Roughly half the
  seeds hinge on it, so the first A/B may move every aggregate at once. The
  frozen strata are what keep that readable.
- **Lowering `FLEE_THRESHOLD` changes decisions with no evidence behind it
  until the threat table fills.** It is inert while the table is empty, which
  is the only reason it can land in the same phase as the thing that fills it.
- **The digest is a second place where cheating could enter**, after the 1a
  status tap. Every field needs the same justification: the screen showed it.
