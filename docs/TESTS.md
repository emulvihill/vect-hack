# What each engine test pins

Every test group `package.json` runs, and what each one pins.

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
