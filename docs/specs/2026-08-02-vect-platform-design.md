# Vect platform — design

2026-08-02. Brainstormed with Eric; research basis in `docs/research/2026-08-02-*.md`.
Revised same day after a grilling session: simplified from "shell + downloadable
modules" to one App with an internal Backplane. Vocabulary: `CONTEXT.md` at the
repo root (App, Engine Build, Engine Repo, Module, Backplane, Cell, Category,
Kind, Classifier).

## Vision

vecthack.com grows from "a NetHack client" into **a vector-arcade roguelike
platform**: one maintained presentation identity (Quadrascan physics, stroked
letterforms, wireframe geometry, additive glow) over multiple real classic
engines compiled to WASM. Prior-art check confirmed the combination is open
ground: 3D NetHack clients exist (nethack-3d), browser Angband exists
(angband.live, server-side tty), but nobody owns "the classic roguelike canon,
one arcade-vector identity, real engines client-side."

Current scope: a **two-game implementation (NetHack + Angband), private, no
distribution**. Scaling to N games — and every decision that only matters then
(repo layout, licensing posture, library publication, monetization) — is a
future spec, taken when two real Modules exist.

## Architecture

**One versioned App.**

- All of Eric's code — renderer, HUD, skins, input, save management, and every
  game's integration — compiles into a single application. No dynamic module
  loading, no cross-version compatibility matrix.
- An **Engine Build** (one engine's WASM bytecode) is the only artifact the
  App loads rather than contains. Each is produced from an **Engine Repo**
  that is fully GPL-clean — upstream source plus at most a minimal stub — so
  anyone can reproduce the exact bytecode. (Today NetHack's build lives in
  this repo; migration into a dedicated Engine Repo is a scale-to-N decision.)
- A **Module** is the per-game integration unit inside the App: Classifier,
  input map, and glue conforming to the Backplane, referencing exactly one
  Engine Build. It is a code-organization concept — the assembly-line pattern
  every game follows (a top-down ASCII grid translated into vector space) —
  not a distribution unit. The Engine Build is never called a module.
- The **Backplane** is the internal interface between the App's shared layer
  and each Module: the Cell grid, input events, and persistence namespace. It
  versions with the App itself. It generalizes what `src/protocol.ts` +
  `MapModel` do today: everything downstream of MapModel is already
  engine-agnostic.

**Cell vocabulary — the two-level split.** The shared layer owns a small,
closed set of **Categories**: the things the renderer and radar genuinely
branch on (wall, floor, door, water, lava, stairs, trap, being, item, effect,
…). Modules own an open set of **Kinds** within a Category (`mineral-vein`,
`web`), and the renderer must draw any unknown Kind acceptably from its
Category plus standard hints — a novel Kind never forces a shared-layer
change. Fit risk for a future title is audited cheaply before porting: read
its terrain/feature table against the Category enum (Angband's `terrain.txt`,
umoria's feature array, …).

**Persistence: one storage volume per Module** (e.g. `vect-nethack`,
`vect-angband`). Hard isolation, matching the one-worker-per-engine boundary;
the Backplane's persistence namespace is literally the volume name. The shared
layer owns only volume lifecycle (mount, flush, enumerate); what a Module
writes inside its volume is its own business. The checkpoint mirror and
`recoverSave.ts` are NetHack Module code, not shared-layer code, and the
`test:persist`/`test:tabs`/`test:autosave` suites stay NetHack-Module tests.

**Hygiene rule (the residue of the deferred library extraction):** the render
core keeps zero game semantics — no Category branching on game identity, no
per-game special cases below the Backplane — so a future extraction of the
vector-CRT layer stays cheap. Extraction itself, its name, its license, and
its publication are all deferred to scale-to-N.

## Sequencing

1. **Angband WASM spike** (first, before any Backplane extraction). Research
   verdict: SMOOTH — unmodified Angband 4.2.6 already compiles (150 objects,
   0 errors) and links (4.0 MB wasm, ASYNCIFY + worker + IDBFS) under our
   Emscripten toolchain; only a VFS-layout boot stop remains, with a known
   fix. Shelob (ridiculousfish's Angband-3.4.1-in-WASM, architecture identical
   to ours) is the recipe: transliterate its 528-line front end onto 4.2's
   nine `ui-term` hooks, reuse its `ASYNCIFY_REMOVE` list (Safari stack),
   apply its three one-line core guards.

   Spike goal: boots in a worker, reaches the birth screen, answers keys,
   output readable in a tty-style debug view — implemented in the
   **structural shape of a Module**: its own directory, its own worker, typed
   protocol messages in the `src/protocol.ts` mold (no ad-hoc postMessage
   blobs), its storage-volume name reserved. What crosses the Backplane is the raw
   tty grid. Out of scope: Cell/Category/Kind classification, 3D, saves.
2. **Backplane extraction**, derived from two real consumers: reshape
   NetHack's existing integration into the first Module, conform the Angband
   glue into the second, and let the Backplane — including the first Category
   draft — be what the two of them actually share.
3. **Angband Module productization**: Classifier, first-person, saves.

Then this design ends. Scaling to N is a future spec.

## Candidate pool (reference, not roadmap)

Research-backed tiers for scale-to-N; licensing columns dormant until
distribution matters.

| Tier | Titles | Basis |
|---|---|---|
| Proving engine | **Angband** (unlocks Sil-Q, variants) | feasibility report: SMOOTH |
| Nearly free | **xNetHack** (rebased onto NetHack 5.0, May 2026 — same windowport shape, same CROSS_TO_WASM) | rebase check |
| Best standalone | **umoria** (GPL-3, 2-file curses seam) | license survey #2 |
| Proprietary-friendly | **Rogue 5.4.4** (BSD-3, the real Toy/Arnold/Wichman), **Omega** (LGPL-2+, curses confined to scr.c), **UltraRogue/Advanced Rogue** (BSD+rename; UltraRogue already linked to a working 967 KB wasm behind a 34-symbol curses stub), **Phantasia** (explicitly uncopyrighted) | license survey + esoteric report |
| Free-only (license) | **Larn** (Morgan's unwaivable no-profit clause), UDD (no license text; story gold — DEC ordered it destroyed in 1983) | license survey / esoteric report |
| Blocked / later | Brogue CE (AGPL — revisit if model shifts), DCSS (511 KLOC, no seam), Stoehr's rogue clone (no-sale), PLATO lineage (TUTOR; reimplementation only) | reports |

Two rogues warning (recurring trap): the sellable one is Toy/Arnold/Wichman
5.4.4 (BSD-3); Stoehr's clone carries "not to be traded, sold, or used for
personal gain or profit". Verify any rogue tree by grepping `rogue.h` for
"personal gain" (real 5.4.4: no match).

The esoteric report also softens the license survey's ncurses worry for the
Rogue family specifically: these games need ~34 stubbed curses symbols total —
a windowport-shaped shim, not an ncurses emulation.

## Dormant until distribution

With the two-game implementation private, everything license-shaped sleeps:
the separate-works posture, NGPL/GPLv2 analysis, counsel review, and
monetization (bead **vect-hack-oab**, P3, stays parked with its findings
appended). Nothing technical blocks on any of it. The Engine Repo discipline
(GPL-clean, reproducible builds) is kept anyway because it is nearly free now
and is the foundation of whatever posture counsel later blesses.

## Testing

The spike lands a node smoke test in the mold of `test:wasm-boot` (boots
headless, birth screen, keypress advances, grid readable) that survives into
the real port. The Backplane, once extracted, gets pinned by unit tests
shared across Modules; `check:browser`/`check:controls` analogues extend
per-game as Modules productize.

## Risks

- **Safari Asyncify stack** (Angband): tuning risk invisible on Chrome. Start
  from Shelob's ASYNCIFY_REMOVE list; Safari check in CI from day one.
- **Shelob version gap**: 3.4.1 → 4.2.6 means re-derive, not rebase.
- **Backplane over-fitting**: mitigated twice — spike-first sequencing, and the
  spike carries only the structural Module shape while the semantic Backplane
  (Categories) is derived in step 2 from both consumers.
