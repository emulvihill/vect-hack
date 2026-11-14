# What each engine test pins

Demoted from `AGENTS.md` (vect-hack-2dr), and completed: seven groups that
`package.json` runs were missing from the list there, which is what a count
maintained by hand does. `AGENTS.md` keeps the aggregate commands.

`npm test` runs every Module's engine tests — **there is no fast subset worth
preferring.** The per-Module groups name a failure; they are not permission to
leave a Module unrun. `npm test` stops at the first failing group and its exit
code is what matters: never pipe it.

The authority for what exists is `package.json`. If a name here disagrees with
it, `package.json` is right and this file is stale.

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
| `test:larn-killer` | three frozen seeds: the killer glyph vs Larn's own tables, a trap death and an unseen killer |

## Moria — `npm run test:moria`

| Group | What it pins |
| --- | --- |
| `test:moria-boot` | the canonical splash reaches the blocking bridge |
| `test:moria-play` | real original/roguelike terminal/input trace |
| `test:moria-checkpoint-native` | exact writer rollback/trailer invariance harness |
| `test:moria-map-contract` | sanitizer/cache plus live semantic map |
| `test:moria-persist` | seed/save/score/export/import and failure paths |
| `test:moria-save-restore` | Ctrl-X, reload, exact character/dungeon restore |
| `test:moria-tabs` | a concurrent loser cannot wipe writer data |
| `test:moria-autosave` | an exact turn-tail checkpoint survives a bare tab crash |
| `test:moria-overlay` | the overlay scope: upstream's unbalanced save/restore pair cannot leak and replace the vector view for the session |

`test:moria-overlay` samples each screen TWICE: while it is up (its scope must
be claimed, and must have been published to the view) and at the next outer
command (the scope must be gone). `e` with nothing equipped is exempt from the
first half and the table says why — it publishes no semantic state at all while
its scope is claimed, so no moment exists at which the gate could see it
(vect-hack-8r0).
| `test:moria-build-contract` | the build's own contract: source pin, link flags, relative link paths and `-ffile-prefix-map`, invalidation, atomic publication |

`test:moria-build-contract` is the only group that runs the Moria build itself,
and it runs LAST in `test:moria` because it republishes `public/modules/moria`
— the nine groups before it read those artifacts. It takes `--require-build`,
and that flag is the whole gate: without it the script prints `PENDING(build)`
and exits 0, having checked only the source pin and the npm scripts, so wiring
it in without the flag would have satisfied vect-hack-03z and changed nothing.
It pins its own npm script and the `test:moria` chain, so this file cannot go
back to being referenced by nothing.

Two of its stub-`make` fixtures had gone VACUOUS rather than merely stale once
the Look HUD added `_moria_describe`: `build-moria-wasm.sh` greps the link
output for that name before it reaches either the source-dirtied guard or the
publication path, so a stub artifact that does not carry it stops the build
early and the assertion downstream passes for the wrong reason. Their stub link
output now carries it, through one `STUB_EXPORTS` constant the readback
assertion also reads. Proved by deleting the source-dirtied guard: green
against the old fixtures, red against the repaired ones.

The rebuild that replaces an already-published `public/modules/moria` pointer
runs under a strict `mv` shim (vect-hack-ujde). The build used `mv -fT` for that
swap, which GNU mv does as a plain rename(2). uutils mv — `/usr/bin/mv` on
recent Ubuntu — follows both links instead: the new link's relative target
dangles from the temp directory it is made in, the old one resolves to a
version directory, and a non-directory onto a directory is refused. Every Moria
rebuild after the first failed on such a host, while the test stayed green on a
GNU one. The build now renames with python3's `os.replace`, and the shim refuses
as uutils does, so going back to `mv -T` fails on any host.
Proved by putting GNU mv first on PATH: green before the shim, red with it
until the build stopped using mv for the swap.

## Unit tests

`npm run test:render` is `vitest run` — every unit test, every Module and the
shared layer. `npm run typecheck` is `tsc` with no emit, and the only static
check there is: the repo has no eslint or biome.

## The layering

- `scripts/test/layering.test.ts` — the import graph. It enumerates `src/`
  itself, so a new file is covered the day it is added, and its first assertion
  refuses a walk that found nothing, because a silent empty walk would make
  every rule below it pass. Each rule is its own assertion naming the offending
  file, line and specifier; the last is a catch-all against the whole
  allow-table, so a layer added tomorrow is covered by the table rather than by
  the named rules happening to mention it. It reads code, not prose — comments
  are blanked before the scan, since this repo's comments quote import paths
  constantly, including that file's own header.

## Node, typecheck flags and lint

Node is pinned in ONE place: `.nvmrc` says 24, `package.json`'s `engines` says
`>=24`, and CI reads the file (`node-version-file: .nvmrc`) rather than repeating
the number. It is load-bearing rather than incidental — `test:larn-killer` passes
`--experimental-strip-types` and `scripts/test/bot-node-import.test.ts` loads
`.ts` straight from source (vect-hack-5a9).

`tsconfig.json` carries `noUnusedLocals` and `noUnusedParameters`, so `npm run
typecheck` is where an unused symbol is caught.

**`npm run lint` covers the `.mjs` drivers under `scripts/`, and nothing else.**
That is a measured limit, not a preference: typescript-eslint 8.68.0 declares
`typescript ">=4.8.4 <6.1.0"` and this repo is on 7.0.2. A plain install
ERESOLVEs (which would fail `npm ci` in CI), `--legacy-peer-deps` throws at
import from the plugin's own `dist/index.js`, and the only working route aliases
the root `typescript` to a TS 6 compat package — which would quietly demote
`npm run typecheck` from tsc 7 to tsc 6. So TypeScript is typecheck's job and
lint takes the ~70 `.mjs` files that `allowJs`-without-`checkJs` leaves entirely
unchecked. Revisit when typescript-eslint supports TS 7.

Lint runs in CI, first in the no-build job (1.4s), and NOT in `npm test`: that
suite needs four WASM artifacts, and its script string is `assert.equal`'d by
`test-moria-build-contract.mjs`.

The config ignores `.claude/**`. The primary checkout carries every live agent
worktree under there, each a full copy of the repo, and `eslint .` otherwise
lints them all — 242 files, 12034 errors, none about this tree. A worktree
contains no other worktrees, so this is invisible from inside one, which is
exactly where a config gets verified.

