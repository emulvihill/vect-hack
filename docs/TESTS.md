# What each engine test pins

Every test group `package.json` runs, and what each one pins.

`npm test` runs every Module's engine tests — **there is no fast subset worth
preferring.** The per-Module groups name a failure; they are not permission to
leave a Module unrun. `npm test` is typecheck, then one `vitest run` over every
project: it reports every failure rather than stopping at the first, and its
exit code is what matters: never pipe it.

## Vitest projects

`vitest.config.ts` splits the suite into projects; `--project` picks them
(`npx vitest run --project engine-larn`, `--project "engine-*"`).

| Project | Script | What it runs |
| --- | --- | --- |
| `unit` | `test:render` | every `*.test.ts`; no engine build (CI runs this) |
| `engine-<game>` | `test:<game>` | `scripts/test/<game>/<game>.engine.ts`: each `test:<game>-*` script, in `package.json` order |
| all `engine-*` | `test:engines` | the four engine projects |

An engine test is a `package.json` script, `timeout N node <driver>`, and
nothing else registers it: `scripts/test/engine.ts` turns every
`test:<game>-*` script into one vitest test, run through `npm run`, with
vitest's limit at N plus 30 seconds so the script's own `timeout` fires first.
A script without a `timeout N` prefix is refused. Within a Module the scripts
run one after another; the four Modules and `unit` run in parallel, which is
safe because every driver boots its own engine against its own fake
IndexedDB and temp directories. A failing script's last 80 lines of output are
in the failure message; a passing one prints nothing. Run a single script
directly (`npm run test:larn-trace`) to watch its output live.

The authority for what exists is `package.json`. If a name here disagrees with
it, `package.json` is right and this file is stale.

## Layout of `scripts/test/`

A test lives in the folder of the code it exercises. `vitest` finds every
`*.test.ts` below `scripts/test/` and `scripts/dev/`; the `test-<game>-*.mjs`
engine drivers are run by name from `package.json`, through each Module's
`<game>.engine.ts`.

| Folder | What lives there |
| --- | --- |
| `nethack/` `angband/` `larn/` `moria/` | one Module each: its unit tests, its engine drivers, their shared helpers (`*-play.mjs`, `bot-fixtures.ts`, NetHack's DOM stub `stub-dom.ts` and fake wasm heap `fake-heap.ts`, `moria-checkpoint-fixtures.ts`), native harnesses (`*.cpp`) and fixtures |
| `backplane/` | `src/backplane` outside the save path: cells, sessions, describe, the key queue |
| `saves/` | the save system across `src/backplane` and `src/ui`, and `fake-fs.ts`, the Emscripten FS stand-in every save-path test shares |
| `render/` | `src/render`: terrain, entities, effects, cameras, picking |
| `ui/` | `src/ui`: HUD, gaze, touch, GPU detection, page links |
| `bot/` | the shared `src/bot` layer and its node-importability |
| `tooling/` | the gate drivers in `scripts/browser-check` and build guards in `scripts/build` |

A test that spans every Module or guards the whole tree (layering, the
cross-Module teardowns, `main.ts` with no GPU, skins) stays at the top level,
as does `worker-harness.ts`: the stand-in core and worker globals every
Module's worker-entry test boots against.

## NetHack — `npm run test:nethack`

| Group | What it pins |
| --- | --- |
| `test:nethack-boot` | node smoke test: the engine boots to the shim boundary |
| `test:nethack-persist` | saves/scores round-trip through a real IDBFS |
| `test:nethack-save-restore` | drives NetHack through `#save`, reload, restore |
| `test:nethack-tabs` | two live engines: the second must not wipe the first |
| `test:nethack-autosave` | checkpoints land, a closed tab's game comes back |

## Angband — `npm run test:angband`

| Group | What it pins |
| --- | --- |
| `test:angband-boot` | node smoke test: Angband boots to the birth screen |
| `test:angband-persist` | saves/scores/user data survive; a losing tab cannot delete them |
| `test:angband-save-restore` | Ctrl-X save, reload, same character (real engine) |
| `test:angband-autosave` | a checkpoint alone survives a tab that never quit |
| `test:angband-borg` | the built-in borg plays unattended, no fatal |
| `test:angband-borg-pace` | with borg.txt's factor set as `?borg=<ms>` sets it, every inventory and store key waits the move pace, each pause holding the menu frame rather than the dungeon (the wrapper took the hook, the overlay order and the clock agree) |
| `test:angband-borg-death` | native retirement reaches a stable manual tombstone, Information inspection remains manual, and leaving the menu quits cleanly |

## Larn — `npm run test:larn`

| Group | What it pins |
| --- | --- |
| `test:larn-boot` | node smoke test: welcome page, `retcont()`, `drawscreen()`, one `parse()` round trip |
| `test:larn-seed` | the gym seed hook: one seed, one game; a different seed, a different game |
| `test:larn-repro` | two gym batches over one seed list play the same games (`src/bot/canonical.ts`) |
| `test:larn-trace` | the bot's keystrokes over five frozen seeds, byte for byte: a refactor that changed a decision fails here |
| `test:larn-persist` | Larn's writable roots survive a reload; a concurrent non-owner stays session-only and cannot reconcile the writer's files out of IndexedDB |
| `test:larn-save-restore` | an explicit S-save is consumed by the next boot, which restores the same dungeon without entering birth |
| `test:larn-autosave` | native checkpoints survive a closed tab and the next boot recovers them through `main.c`'s `++` path, with no S-save |
| `test:larn-map-contract` | the source-pinned map tap: blindness publishes no newly live state; visible trap subtypes share records and Look labels, hidden traps match floor, and pits stay distinct |
| `test:larn-status` | the status tap vs the engine's own screen: scalars, clock, items, no leaked ids |
| `test:larn-savefile` | a `savefile:` line in `.larnopts` cannot move the explicit save off the volume, is refused out loud, and the save it did not redirect really restores |
| `test:larn-gym` | one real game through the headless bot gym: bot, prompts, artifacts; an unknown `--tuning` knob is refused before the game |

## Moria — `npm run test:moria`

`test:moria-build-contract` runs first: it rebuilds Moria, and
`test:moria-play` links its native harness against the object tree that build
leaves in `build/moria/obj`, which a fresh tree does not have.

| Group | What it pins |
| --- | --- |
| `test:moria-build-contract` | what the artifact cannot show afterwards: the clean pinned source and toolchain, the exact compiled sources, seams and link flags, the seed allow-list and bytes, cache invalidation and failed-build publication, then one boot of the freshly published artifact |
| `test:moria-boot` | the canonical splash reaches the blocking bridge |
| `test:moria-play` | real original/roguelike terminal/input trace (`test-moria-native-io.mjs`, run nowhere else) and the real-artifact Worker bridge |
| `test:moria-checkpoint-native` | exact writer rollback/trailer invariance harness |
| `test:moria-map-contract` | sanitizer/cache plus live semantic map |
| `test:moria-persist` | seed/save/score/export/import and failure paths |
| `test:moria-save-restore` | Ctrl-X, reload, exact character/dungeon restore |
| `test:moria-tabs` | a concurrent loser cannot wipe writer data |
| `test:moria-autosave` | an exact turn-tail checkpoint survives a bare tab crash |
| `test:moria-overlay` | the overlay scope: upstream's unbalanced save/restore pair cannot leak and replace the vector view for the session |

The recovery, import and persistence unit tests build checkpoints from one
fixture, `moria-checkpoint-fixtures.ts`: a stock save, a valid payload, the
trailer, the commit and tombstone records, and `CHECKPOINT_DEFECTS`, every
one-defect checkpoint. Runtime recovery and import judge a checkpoint with the
same validator, so both run the whole list.
