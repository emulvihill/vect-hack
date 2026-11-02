# Larn Module — Design

Issue: vect-hack-611 — Port Larn as a third Module.
Date: 2026-08-06.

Add Larn (Noah Morgan's 1986 dungeon crawler) as a third game Module, following
the established NetHack and Angband module pattern. The Angband Module is the
closest precedent — both are curses/term-based C engines compiled to WASM via
Emscripten and hosted in a Web Worker, presented through a Backplane `CellGrid`.

This design covers the full acceptance criteria (boot, TtyView, VectorView,
saves) but delivers it in two phases: boot+TtyView first, VectorView+saves
second — mirroring how the Angband Module was spiked (its 3D view and saves
were a later phase).

## Decisions (settled in brainstorming)

1. **Source: classic BSD Larn**, vendored as a pinned submodule like
   NetHack/Angband when viable. The exact version + interception point is
   spike-gated (see Source pinning).
2. **Scope: phased.** Phase 1 = build + worker + protocol + session + TtyView +
   boot. Phase 2 = classifier + VectorView + saves.
3. **Categories: reuse `feature`** for shops/altars/bank (with a `kind`
   discriminator), exactly as Angband maps its stores. No new `Category`
   variants in the shared Backplane.
4. **Bot: out of scope** for this port (per the issue).
5. **No module registry abstraction** — stay a literal if/else in `main.ts`
   at N=3 (the project map specifies none at N=2; we do not introduce one).

## Source pinning (spike-gated)

Classic BSD Larn. A source-viability spike at the start of phase 1 evaluates
candidates on two axes: *compiles under Emscripten with cflags-only (no
source patches)*, and *cleanest terminal interception point*.

Candidates:

- **HunterZ/larn 12.3** (`00d60428284f`) — stable, most-played classic version
  (Kevin Routley, first to use `@` for the player). Termcap-based `io.c` with
  semantic grid primitives (`cursor`/`lpr`/`cl_dn`/`l_cls`/`standout`).
- **HunterZ/larn 12.4-alpha2** (`e61f3fbfc31b`) — has a clean minimal
  `ansiterm.h` (5 functions: `init`/`clean_up`/`out`/`getch`/`getche`), but
  `ansiterm_out` emits raw ANSI escape sequences (needs a JS-side ANSI parser).
  It is an alpha.
- **NetBSD `games/larn`** (David Holland's 2008 modernization of BSD Larn
  12.2) — already compiles under modern compilers. Fallback as a vendored
  snapshot if both HunterZ versions require source patches.

Pick rule: submodule the cleanest-compiling candidate with the simplest
interception surface. If every candidate needs source patches, vendor the
NetBSD-modernized snapshot into `external/larn/` with the pinned NetBSD
source revision cited in a `README`, and record the deviation in
`docs/DECISIONS.md`. Whichever lands:

- Pin the commit in `scripts/build/build-larn-wasm.sh` and refuse to build a
  different commit (the Angband pin-guard pattern).
- Keep the vendored source pristine — **never patched**. All C compat lives
  in our makefile cflags (e.g. `gnu89` + `-Wno-implicit-int`
  + `-Wno-implicit-function-declaration` + `-Wno-int-conversion`) and in
  `src/modules/larn/native/main-wasm.c`, both of which are ours.

## Worker bridge (Angband pattern)

A Web Worker hosts the Larn WASM (Emscripten, `MODULARIZE`/`EXPORT_ES6`/
`ASYNCIFY`, `ENVIRONMENT=worker,node` — the Angband link flags).
`native/main-wasm.c` is our own `main()` + terminal backend; upstream's
default terminal backend is excluded from the link (as Angband excludes
`main.o`). The shim implements Larn's terminal output primitives as
`EM_ASYNC_JS`/`EM_JS` calls into `globalThis.VectLarn`, writing to an 80×24
tty grid and posting display events.

Key input uses the Asyncify split proven on Angband: an async `gatherKey`
that posts a `getKey` request and awaits the main-thread reply, plus
synchronous `keyCode`/`keyMods` getters the C side reads back. This is the
core bridge; the exact set of terminal primitives (12.3's semantic `io.c`
functions vs. 12.4-alpha2's `ansiterm` + JS ANSI parser) is the second axis
the spike resolves.

Larn's display is 80×24; the map viewport dimensions are pinned from the
source during the spike (the issue notes the viewport may differ from the
display).

## Module components

`src/modules/larn/` (① = phase 1, ② = phase 2):

- ① `protocol.ts` — `LarnEvent` union (the curses/term display events the
  worker posts: `text`, `curs`, `clear`, `flush`, `level`, `message`),
  `LarnWorkerToMain` / `LarnMainToWorker`, `LarnKey { code; mods }`,
  `KC_ESCAPE`. One blocking request/reply (the key wait), like Angband.
- ① `worker.ts` — installs `globalThis.VectLarn` (one method per protocol
  event + `gatherKey`/`keyCode`/`keyMods`), boots `larn.js` from
  `public/modules/larn/`, mounts storage, posts `ready`.
- ① `session.ts` — `LarnSession` wrapping
  `EngineSession<LarnWorkerToMain, LarnMainToWorker>`; `LarnHandler`
  interface (`onReady`/`onNotice`/`handle`/`nextKey`); `makeDelegate`;
  `larnFallback` (the cancel-shaped reply for the throwing-dispatch guard).
  Literal `new Worker(new URL("./worker.ts", import.meta.url),
  {type:"module"})`.
- ① `keys.ts` — `KeyboardEvent` → `LarnKey`, `movementKey`. Larn's
  keypad/movement encoding differs from Angband's and is pinned from the
  source during the spike.
- ① `grid.ts` — the 80×24 tty scratch surface (mirrors Angband `grid.ts`).
- ① `persist.ts` — `mountLarnStorage` over `VOLUMES.larn`;
  `LARN_WRITABLE_DIRS` pinned from the source (save/score dirs).
- ① `ui/TtyView.ts` — the debug/no-GPU text view; implements `LarnHandler`.
- ① `native/main-wasm.c` — created in phase 1 with the tty-text terminal
  backend; the semantic-grid `mapBatch` Int32 path that feeds the
  classifier is added in phase 2.
- ② `mapRecords.ts` — the Int32 grid word layout shared between C and TS,
  with only the fields Larn needs (no trap/feature-rich Angband stride).
  Needed only by the semantic-grid `mapBatch` path that feeds the
  classifier, so phase 2.
- ② `classifier.ts` — `LARN_COLS`/`LARN_ROWS`; `LarnClassifier` mapping Larn
  glyphs/terrain → `Cell`. Shops/altars/bank → `feature` (with `kind`); traps
  → `trap`; lava/water → existing categories. No new `Category` variants.
- ② `ui/VectorView.ts` — the 3D arcade-vector view; implements `LarnHandler`.
- ② `checkpoint.ts` — autosave cadence (modeled on Angband's, unless Larn's
  save is too simple to warrant it — a phase-2 call).

## Backplane wiring (the only shared-file touches)

- `src/backplane/volumes.ts` — add
  `larn: { id:"larn", mountpoint:"/vect-larn", lock:"vect-larn/persist" }`,
  widen the `Record` type to `"nethack" | "angband" | "larn"`.
- `src/main.ts` — add `else if (params.get("game") === "larn")` with
  `makeLarnView()` + `LarnSession` + window globals
  `__larnSession`/`__larnView`. Literal if/else at N=3 — no registry.

The Backplane (`cell.ts`, `session.ts`, `keyQueue.ts`, `saveBlob.ts`,
`saveExport.ts`) is consumed, not modified. `Category` gains no variants.

## Build

`scripts/build/build-larn-wasm.sh` + `larn-wasm.mk`, structured like the
Angband pair:

- Submodule commit pin guard — refuse to build a different commit.
- Makefile stamp — `sha256sum` of `larn-wasm.mk`; if changed, purge stale
  objects (submodule src + out-of-tree `main-wasm.o` + artifacts) so old
  flags can't linger.
- Stage the `lib/` VFS — data files only (license hygiene); exclude any
  tiles/sounds/fonts the source may carry.
- `--preload-file lib@/lib`; copy artifacts to `public/modules/larn/`.
- Discipline guards (CANARY-equivalent / asset carve-out) are named by
  *pattern* here and filled with concrete greps in the plan, once the spike
  reveals what the Larn build actually emits — we can't pre-name guards
  before the shim's real surface is known.

## Phasing

**Phase 1 — boot + TtyView.** Deliverable: `?game=larn` boots the WASM
engine and renders the game in TtyView. Steps: source-viability spike
(pick + pin the version, prove cflags-only compile) → `build-larn-wasm.sh`
+ `larn-wasm.mk` → `protocol.ts`/`worker.ts`/`session.ts`/`keys.ts`/
`grid.ts`/`persist.ts` → `main-wasm.c` (tty-text path) → `ui/TtyView.ts`
→ `volumes.ts` + `main.ts` wiring. Phase-1 exit: `?game=larn` shows
character creation and play in the tty grid; a node smoke test boots to the
shim boundary.

**Phase 2 — VectorView + saves.** Deliverable: the 3D view renders correct
Cells; saves persist across reloads. Steps: `mapRecords.ts` + the
`mapBatch` path in `main-wasm.c` → `classifier.ts` → `ui/VectorView.ts`
→ `persist.ts` save/restore + `checkpoint.ts` → engine tests (persist,
save-restore, autosave) mirroring the Angband trio.

## Error handling

Reuse the Backplane's load-bearing machinery unchanged:

- **Fatal → notice** via `EngineSession`: a worker fatal posts a `notice`
  the session surfaces as a banner (`fatalNotice`: "The Larn engine died
  — …"), the Angband shape.
- **Throwing-dispatch guard** (vect-hack-c1w/1g5): `larnFallback` returns a
  cancel-shaped key reply so an engine that throws mid-turn unwedges
  instead of hanging on the Asyncify suspend. The one fix-once site — we
  implement the delegate against it, we do not modify it.
- **Storage collisions**: `mountVolume`'s seed checks preload collisions
  and never overwrites packaged data.
- **Two-tab isolation**: the volume's Web Lock (`vect-larn/persist`) makes
  a second tab session-only, mirroring `/vect-nethack` and `/vect-angband`.

## Testing

Mirrors the established per-Module groups, added to `package.json`:

- ① `test:larn`, `test:larn-boot` — node smoke: boots to the shim boundary.
- ② `test:larn-persist` — saves/scores round-trip through a real IDBFS; a
  losing tab can't delete them.
- ② `test:larn-save-restore` — drives the engine through save, reload,
  restore.
- ② `test:larn-autosave` (if Larn's save warrants a checkpoint cadence) — a
  checkpoint survives a tab that never quit.
- No `test:larn-borg` — no bot in this port.
- The vitest unit layer (classifier, keys, grid) joins
  `npm run test:render`; `npm test` runs all three Modules' engine tests.
- `check:browser` and `check:controls` get a `?game=larn` run each once the
  VectorView exists (phase 2) — same real-Chromium discipline as the other
  two Modules.

## Non-goals

- No bot, no `?borg` equivalent.
- No new shared-Backplane `Category` variants.
- No module registry abstraction (stay literal if/else at N=3).
- No patching of the vendored Larn source — all compat in makefile cflags
  and `main-wasm.c`.