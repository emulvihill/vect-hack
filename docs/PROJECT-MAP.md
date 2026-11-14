# Project map

Demoted from `AGENTS.md` (vect-hack-2dr): one entry per directory, what lives
there and the rules that hold it together. AGENTS.md keeps the one-line layer
summary and points here.

The layering, which the import graph obeys today and
`scripts/test/layering.test.ts` asserts on every `npm run test:render`:

```text
backplane -> backplane only        (0 outward edges, and no DOM)
skins     -> skins only            (0 outward edges: leaf data)
render    -> backplane, skins
ui        -> backplane, render, skins
bot       -> backplane
modules/X -> backplane, bot, render, ui, skins
modules/X -> modules/Y             (none: no Module imports another)
anything  -> main.ts               (none)
```

`skins` is in the table because leaving it out is how the one violation the
2026-08-27 review found survived: an unnamed layer has no rule to break. The
test's own allow-table is the enforced copy; this one is prose and nothing yet
pins the two together (vect-hack-z80c).

## The vendored engines

- `external/NetHack` — official source, submodule pinned to the `NetHack-5.0` branch tip
  (release-tag wasm bugs were fixed on the branch; see docs/DECISIONS.md). Never
  patched: it stays a clean external dependency anyone can compile as instructed.
  `build-nethack-wasm.sh` pins `SUPPORTED_NETHACK` and refuses to build a different
  release, because `src/modules/nethack/recoverSave.ts` depends on NetHack's on-disk save
  layout. Moving the pin means re-checking that port — and checking whether
  `sys/libnh/libnhmain.c` has learned to clear `program_state.in_self_recover`,
  which is the upstream bug the port exists to route around.
- `external/angband` — official source, submodule pinned to 4.2.6-166
  (f0f6bd223). Never patched, same rule as NetHack;
  `build-angband-wasm.sh` pins the commit and refuses to build anything else.
- `external/umoria` — official source, clean submodule pinned to
  `3bf8abc4f76812810e59d738492c7b61fb8f1bb6`. Never patch it;
  `build-moria-wasm.sh` pins source/toolchain/flags/seed bytes, stages the
  12-file runtime seed itself (the allow-list `MORIA_RUNTIME_FILES` in
  `src/modules/moria/persist.ts` mirrors), and publishes the complete
  JS/WASM/data set atomically.
- `external/larn` — vendored NetBSD BSD-Larn-12.0 source under its original
  no-profit permission; see `LICENSING.md` before distribution changes.
### What each build script guards

Each build script guards what its artifact cannot be checked for afterwards.
build-nethack-wasm.sh: the Lua tarball's sha256 (upstream computes one and throws it
away), the NetHack release pin, upstream's exported-function list, and greps
for SELF_RECOVER and `_save_currentstate`. build-angband-wasm.sh: the submodule
commit pin, a makefile stamp that discards stale objects on a flag change, the
`game_event_dispatch` Asyncify canary (the CANARY comment in `angband-wasm.mk`
— a link that stops printing that warning now fails the build), and greps for
the asset carve-out and for `-DALLOW_BORG`, without which the borg objects
compile empty, the build succeeds, and the merge gate has nothing to drive.
All four run `guard-host-paths.sh` on what they publish: no artifact may
contain the checkout path, the Moria source directory or `$HOME`, and a
file it cannot scan fails. Emscripten bakes the `-o` path into the
glue as the `.data` package name, so the Angband, Larn and Moria links run from
`build/<module>` with relative output and preload paths, and Moria compiles
with `-ffile-prefix-map` because `helpers.cpp`'s asserts put `__FILE__` in the
wasm.

## The client

- `scripts/build/`, `scripts/test/`, `scripts/dev/` — build, test, and dev tooling.
- `src/backplane/` — the Backplane (CONTEXT.md): `cell.ts` (the Cell/Category
  grid every Module presents and the renderer draws), `colors.ts` (the 16-slot
  color vocabulary `Cell.color` indexes), `session.ts`
  (`EngineSession`: worker lifecycle, fatal→notice, the throwing-dispatch
  guard — the fix-once site for vect-hack-1g5/c1w), `keyQueue.ts` (the
  buffer-or-waiter input queue; its `cancel()` is the teardown half —
  vect-hack-a8r — because a view that unbinds its keydown listener has cut the
  only thing that could ever push, leaving whatever is parked on `next(true)` a
  promise nobody will settle, with the Backplane's dispatch awaiting it. It
  **resolves with null and never rejects**: null is already the queue's word for
  "no key", and a rejection would land in `EngineSession`'s throwing-dispatch
  guard, which exists to report a display error and must keep meaning that), `volumes.ts` (one storage volume per
  Module: `/vect-nethack`, `/vect-angband`, `/vect-larn`, `/vect-moria`), `saveBlob.ts` + `saveExport.ts`
  + `pendingImport.ts`
  (a whole volume packed as one portable `.vhsave` file, and the worker round
  trip that fetches it — the volume lives in the worker's FS). Imports nothing
  from modules, render, or ui.
- `src/modules/nethack/` — the NetHack Module: `protocol.ts` (typed
  messages), `worker.ts` (engine + all wasm-memory decoding), `session.ts`
  (delegate over `EngineSession`; `NethackHandler` stays its view
  interface), `classifier.ts` (glyphs → Cells; owns `NETHACK_COLS/ROWS`),
  `persist.ts`/`checkpoint.ts`/`recoverSave.ts` (the vect-nethack volume,
  autosave mirror, save rebuild — read recoverSave's header before touching
  either), `engineBoot.ts`/`evalShim.ts`/`wasmAbi.ts`, `ui/` (TextHud,
  VectorView, DebugView, key/movement tables, pointer actions, command
  menu), `bot/` (the ?bot player).
- `src/modules/angband/` — Angband Worker/session, tty and semantic views,
  classifier, key mapping, persistence/checkpoint policy, borg, and native
  front end.
- `src/modules/larn/` — Larn Worker/session, terminal and semantic map adapter,
  vector/debug views, persistence/checkpoints, native porting shim, `shimBridge.ts`, and `bot/`
  (the ?bot survivor: model, prompts, policy with `DEFAULT_TUNING` — the
  ladder's hand-tuned knobs — LarnBotPlayer, recorder, `bench.ts`, and
  `digest.ts`, one finished game reduced to its public projection).

  `shimBridge.ts` is the ONE implementation of the `globalThis.VectLarn` object
  that `main-wasm.c`'s `EM_JS` blocks call. Six hosts install it —
  `worker.ts`, `scripts/dev/bot-gym-larn.mjs`, `scripts/test/larn-play.mjs`,
  `test-larn-boot.mjs`, `test-larn-seed.mjs`, `test-larn-status-tap.mjs` — and
  each says only what it does with one typed event stream (`onEvent`) and four
  lifecycle callbacks (`notice`, `saveLanded`, `quit`, `gatherKey`). The bridge
  owns every C-side signature, both heap copy-outs and the key register, so
  `keyCode`/`keyMods` appear in no host. A new DISPLAY callback is a new
  `LarnEvent` in `protocol.ts` plus one line in the bridge and NO host edit —
  a host that does not care ignores an event name, which is not an edit. That
  was measured rather than assumed: a throwaway seventh callback built into the
  real WASM cost 10 added lines across `main-wasm.c`, `protocol.ts` and
  `shimBridge.ts`, arrived in the gym's trajectory, and left all thirteen Larn
  gates green. A new LIFECYCLE callback still reaches every host, deliberately:
  those four carry a decision no default can make.

  Two mitigations inside the bridge are load-bearing and predate it
  (vect-hack-dwb). The gym hooks (`gymSeed`, `gymFast`) are ABSENT when a host
  does not supply them, never defaulted: `main-wasm.c` asks
  `typeof v.gymSeed === "function"` and reads a miss as "off", so a default
  would seed every browser game — which is why the test asserts the property is
  absent rather than that it returns 0. The display callbacks FAIL LOUDLY: with
  no `onEvent`, each throws naming the callback C called and the host that
  installed the bridge. A silent no-op default would hide exactly the bug this
  came from, where `statusBatch` landed in Phase 1a and four gates threw until
  a stub was pasted into each. `scripts/test/larn-shim-bridge.test.ts` pins
  both, and `scripts/test/bot-node-import.test.ts` covers the bridge as a head
  of the no-bundler chain, because five of the six hosts are `.mjs`.
- `src/modules/moria/` — Umoria Worker/session, exact 80x24 terminal, source-
  owned input/overlay seams, sanitized semantic exporter/classifier, vector
  and debug views, hit inference, explicit persistence, typed turn-tail
  checkpoints/recovery, and validated portable import.
- `src/render/` — the shared 3D layer, game-free: consumes a Backplane
  `CellGrid`. `TerrainBuilder` (static level geometry), `EntityLayer`
  (per-frame letterforms), `vectorFont` + `letterform`, `LineBatch`,
  `WallFill`, `DungeonCamera` with `OrbitCam` + `FirstPersonCam`,
  `DungeonRenderer` (renderer + frame loop + F2; takes the grid its
  Module's view constructs — `renderer.map` keeps its name for the page
  helpers). The token file it draws from lives at
  `src/skins/tokens/quadrascan.json` and reaches render through
  `activeSkin().tokens`.
- `src/skins/` — the single source of truth for every colour/theme value (see
  the directory's own headers), and a leaf: it imports nothing above itself.
  `tokens/quadrascan.json` is the base token file, kept under `tokens/` so its
  basename does not collide with the default skin `src/skins/quadrascan.json`.
  It is the physics/token base a skin's `tokens` section overrides.
- `src/ui/` — shared only: `hud/Radar.ts` (monster radar over the CellGrid),
  `gpuSupport.ts` + `chooseView.ts` (the one ?view=debug/no-GPU degrade policy),
  `gaze.ts` (camera-relative direction arithmetic) + `gazeControls.ts` (the
  per-camera-mode binding tables and chord resolver every vector view arms
  while a command request is parked; each Module keeps its own command seam
  and key encoding — Larn's seam is the `__wrap_yylex` flag in its native
  shim), `saveMenu.ts` (the Saves button and both keys) over `saveDownload.ts`
  (bytes -> a file in the downloads folder) and `saveUpload.ts` (a picked file
  -> validated, parked, page reloaded), `saveRisk.ts` (both save warnings and
  all their copy: the one-time notice and marked Saves button an unpersisted
  origin gets — drawn off the storage grant's `.then()`, never an await, and
  nothing at all when the grant was given — and the three sentences a tab that
  cannot save AT ALL gets, one per `SessionOnlyCode`. The Backplane tags each
  of `mountVolume`'s seven session-only reasons with a code and posts the code,
  never the detail, as the `sessionOnly` lifecycle message; `EngineSession`
  routes it to the listener `main.ts` registers, one for all four Modules. The
  two states share one banner and one button and session-only wins both in
  either arrival order, removing `atrisk`'s class and title rather than sitting
  on top of them — its title names a button that refuses here, since
  `exportSave()` throws before touching the filesystem whenever the volume
  never mounted, so no copy in that state may name the Saves button. Its
  dismissal lasts one page load and is never stored), `noKeyboard.ts` (what a touch-only visitor gets instead of an inert
  canvas: `(pointer: coarse) and (hover: none)` decided as a pure function, the
  explanation, and the `?bot`/`?borg` demo — `SELF_PLAY_FLAG` there has to keep
  agreeing with `main.ts`, and Moria, which has neither, is offered no demo,
  never another game's).
- `src/bot/` — shared, game-free bot substrate: `trajectory.ts` (the JSONL
  experience log), `scoreboard.ts` (run summaries, CSV, stats), `canonical.ts`
  (the fields two runs of one seed must agree on — everything a row carries
  except its id and its wall clock), `digest.ts` (the shape of one finished
  game's public projection, read by the killer test and the batch studies),
  `pathing.ts` (BFS/frontier over a `CellGrid`). Imports only the backplane,
  and touches no filesystem because the browser bot shares it. Every file the
  headless gym loads (`src/bot/`, `src/modules/larn/bot/`, and their imports —
  `classifier.ts`, `keys.ts`, `grid.ts`, `mapRecords.ts`, `protocol.ts`, `shimBridge.ts`,
  `backplane/cell.ts`, `persist.ts`) uses relative `.ts` import specifiers and
  erasable-only TypeScript (no parameter properties, no `enum`), because node
  loads them straight from source with no bundler;
  `scripts/test/bot-node-import.test.ts` guards it.
- `src/main.ts` — App composition root: the explicit `?game` branch, no Module
  registry abstraction solely for enumeration. Each arm resolves its Module
  through `await import(...)` inside its own `bootX()` function, so a visitor
  downloads the game they asked for and no other (vect-hack-l11); every Module
  name at the top of the file is an erased `import type`. Three rules hold that
  together. The view is constructed before the session, so no engine event can
  reach a handler with no grid installed. The storage grant and the
  session-only registration stay on the synchronous path above the arms, ahead
  of any download, because a worker mounts its volume during boot. And **no
  `Promise.all` may name one module twice** — vitest 4.1.10 hands the REAL
  module to the second of two concurrent dynamic imports of a mocked one, which
  drags the whole render layer into a test that mocked it away and reports the
  failure a directory from its cause.

  Each arm hands `chooseView` a **loader per view** rather than the two classes,
  and only the winning arm's loader is called (vect-hack-po4). A browser with no
  GPU — or a `?view=debug` page — is shown a character grid, and it used to
  download three/webgpu and `src/render` (810 kB of chunk, 224 kB over the wire)
  to draw it, because `main.ts` had to resolve both `import()`s before it could
  ask the policy anything. It buys the common case nothing: a visitor with a GPU
  still fetches all of it, and now pays one probe's latency in front of the
  fetch. The session module stays beside the choice in the `Promise.all` — it
  names no view, so it is not what the probe is deciding between — and the two
  view loaders live inside the `chooseView` call where at most one ever runs, so
  the name-one-module-twice rule is untouched. Because the call site no longer
  holds the vector class as a value, `chooseView` returns a discriminated
  `{kind, view}` and the arms read `chosen.kind === "vector"` where they read
  `view instanceof VectorView`; `view` is still typed as that arm's own view, so
  renaming the Look HUD's field is still a type error here.

  `booted` is exported for the composition tests: boot is no longer synchronous, so waiting one microtask is no longer a
  truthful way to wait for it. All four Modules now have a
  `scripts/test/<module>-main.test.ts` pinning their arm (vect-hack-2cg).
  NetHack's is the widest — it is the only arm with `?touch` and the only one
  whose view's `onNotice` is optional — and its VectorView mock returns a real
  INSTANCE of the mocked class rather than a seam object, because `?touch` and
  the look binding are both gated on `view instanceof VectorView`, which a
  returned foreign object makes permanently false. Under the sibling files'
  shape, deleting either line from `main.ts` keeps their tests green.
## Upstream and prior art

- NetHack upstream: https://github.com/NetHack/NetHack (5.0.0, May 2026).
- Umoria upstream: https://github.com/dungeons-of-moria/umoria.
- Prior art (study, don't copy): https://github.com/JamesIV4/nethack-3d

## Tearing down a worktree

**Tear one down with `scripts/dev/worktree-teardown.sh <path>`**, which exists
because the procedure this paragraph used to give was itself the trap. It said
to `git submodule deinit` inside the worktree first — and that unregisters the
submodules in `.git/config`, which every worktree SHARES, leaving the PRIMARY
checkout with three unregistered submodules. The files survive, only the
registration goes, and nothing tells you: the next build fails somewhere
unrelated.

The deinit was never necessary. `git worktree remove --force` removes a
worktree with initialized submodules and never touches the shared config —
git's own manual says so ("ones with submodules can be removed with `--force`";
the "`--force` twice" on the same page is about LOCKED worktrees). Verified on
git 2.53.0 against a scratch worktree with all three submodules checked out:
removal succeeded, `git submodule status` in the primary was unchanged.

The script does that, refuses first on uncommitted changes and on commits not
on `main` (`--force` discards both without a second warning), deletes the branch
only if it merges cleanly, and then CHECKS the primary's submodule
registration — repairing it with `git submodule update --init --recursive` if
it ever is broken, which re-registers without re-cloning. It verifies rather
than assumes because this failure is silent.

The `VectLarn` shim object has ONE implementation,
`src/modules/larn/shimBridge.ts` (vect-hack-dwb), which six hosts install and
decorate. A new DISPLAY callback is a new `LarnEvent` plus one line in the
bridge and no host edit; a new LIFECYCLE callback still reaches every host,
deliberately. The two mitigations inside it are load-bearing and must survive
any further refactor: the gym hooks are ABSENT rather than defaulted, because
`main-wasm.c` asks `typeof v.gymSeed === "function"` and a default would seed
every browser game; and the display callbacks FAIL LOUDLY, because a silent
no-op default would hide exactly the bug this came from. `docs/PROJECT-MAP.md`
has the rest.
