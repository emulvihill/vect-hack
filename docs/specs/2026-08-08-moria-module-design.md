# Moria Module Design

**Status:** Approved for implementation by Eric Mulvihill on 2026-08-08 through
Beads readiness gate `vect-hack-nfz.7`.

**Source of truth:** Beads epic `vect-hack-nfz` and children `.1` through `.6`.
This document records the accepted cross-stage architecture; the child beads
remain authoritative for acceptance and dependency state.

## Goal

Ship canonical Umoria 5.7.15 as a first-class VectHack Module. The official
`dungeons-of-moria/umoria` core is pinned at
`3bf8abc4f76812810e59d738492c7b61fb8f1bb6`, compiled to WebAssembly, and run
in a Web Worker. VectHack supplies the terminal, semantic map, persistence,
renderer, controls, tests, and browser integration without modifying upstream.

## Boundaries

- `external/umoria` stays a clean submodule at the exact approved commit.
- Project-owned C++ replaces only upstream `main.cpp` and `ui_io.cpp`; the game
  remains synchronous and uses Asyncify for input and event-loop yielding.
- The native layer owns source-faithful terminal and semantic extraction. The
  TypeScript classifier remains thin and never derives game truth from the TTY.
- The Backplane owns shared session, grid, renderer, camera, Radar, export, and
  volume concepts. Moria keeps its protocol, classifier, input contexts, and
  persistence policy inside `src/modules/moria`.
- No Module registry is introduced at four games; `src/main.ts` keeps explicit
  composition branches.

## Delivery order

1. Pin and build the clean official source, package runtime/license materials,
   and reach a tested native/JavaScript bridge.
2. Implement the exact 80x24 terminal and Worker input lifecycle until the real
   engine is playable.
3. Export visibility-safe semantic state and render it in the shared vector view.
4. Persist explicit saves, scores, and portable volumes under the shared
   single-writer policy. Stages 3 and 4 may proceed in parallel after stage 2.
5. Integrate the production route, previews, documentation, and live WebGPU,
   WebGL, and controls gates.
6. Add periodic recovery only after a measured invariance spike selects an
   observationally pure checkpoint strategy.

## Terminal and input

The terminal is a byte-faithful 80x24 grid. The replacement for `ui_io.cpp`
preserves cursor, clear/wipe, saved-screen, message history and combining,
`-more-`, line editing, Ctrl-R, bell, and EOF behavior. Blocking reads suspend
through one key queue. Nonblocking run/rest polls always yield to the Worker
event loop and honor the upstream delay. Channel closure never masquerades as
EOF. Screen-relative movement is enabled only for proven outer-command reads;
nested prompts receive literal keys in both original and roguelike modes.

## Semantic presentation

Native code reads `dg.floor` and related public game state directly, emits one
bounded full snapshot followed by packed diffs, and carries terrain under
occupants. It reproduces display visibility without calling
`caveGetTileSymbol()`: blindness exports only the player, hallucination neither
reveals identities nor consumes RNG, and hidden objects/monsters never cross the
protocol. Moria-specific hit evidence produces a red pulse only when the victim
cell is unambiguous.

## Persistence

Runtime seed files are packaged separately, copied into `/vect-moria` on a new
volume, and accessed through upstream-relative paths by making the mounted
volume the working directory. `mountVolume`, Web Locks, and IDBFS elect one
writer. Explicit Ctrl-X saves, scores, exit/death writes, F3 export/import, and
all error paths are durably synchronized before success is reported. A losing
tab is visibly session-only and never mounts or reconciles the persistent store.

Autosave is intentionally absent until stage 6. The checkpoint spike compares a
byte-compatible writer, controlled stock save with complete restoration, and a
larger snapshot seam. The chosen path must preserve the exact RNG stream, input
queue, turn, speed, rest/search, UI, dungeon, monsters, stores, messages, and
every touched global. Explicit saves outrank stale checkpoints; death cannot be
undone by an older checkpoint.

## Licensing

Upstream identifies Umoria as GPL-3.0-or-later and records the 2008 relicensing.
The build includes `LICENSE`, `AUTHORS`, generated version material, and the
project-owned UI adaptation's upstream copyright/SPDX provenance. Public
distribution must provide corresponding source for the combined covered work;
the repository itself is the intended source path. This implementation does not
reuse code from the browser fork.

## Verification

Every behavior change follows red-green-refactor. `npm test` runs all Module
unit and real-engine groups. Moria adds boot, persistence, save/restore, tabs,
and autosave engine gates. `npm run preview` renders Moria in orbital and
first-person views. Live Chromium gates exercise Moria under WebGPU and WebGL,
then prove orbital and first-person controls against keys actually delivered to
the engine. The external submodule must finish clean at the exact pin.

