# Autosave: an in-progress game survives a closed tab

Bead: `vect-hack-9ui`. Interacts with `vect-hack-4ho` (one tab owns the volume).

## Problem

`src/restore.c:928` deletes the save file on every normal restore, and `autoPersist`
propagates the unlink to IndexedDB within a tick. From then until the player types
`#save`, nothing on disk describes the game. Level files — which do describe it — stay
in MEMFS by the decision in `persist.ts:11-13` and die with the worker. A closed tab
loses the character outright.

Two things are true and shape everything below:

- **A save cannot be written at unload.** `visibilitychange`/`pagehide` give no async
  time, and the engine is ASYNCIFY-suspended behind a `postMessage` round trip.
  Checkpoints must happen *during* play.
- **`dosave0()` cannot be used for them.** It runs `WRITING | FREEING` (`save.c:156`),
  deletes every level file (`save.c:214,222-223`), and clears
  `something_worth_saving`. The game is unplayable afterwards; that is why `dosave()`
  terminates.

## Mechanism

NetHack already ships the whole feature; this build has it switched off.

- `INSURANCE` is unconditional (`config.h:435`) and the `checkpoint` option defaults On
  (`optlist.h:230`), so `save_currentstate()` (`do.c:1374`) already writes a
  **non-destructive** full checkpoint — the current level file plus `level.0` carrying
  all non-level state — on every level change. It sets `nhfp->mode = WRITING` with no
  `FREEING`, so `release_data()` is false throughout and nothing is freed.
- `recover_savefile()` (`files.c:2861`) rebuilds a real save file out of those orphaned
  level files, in-engine, and `getlock()` offers it at boot. It is gated on
  `SELF_RECOVER`, which `unixconf.h:126` leaves commented out — and
  `cross-pre2.500:389` does `override CFLAGS = $(WASM_CFLAGS)`, discarding the
  `-DSELF_RECOVER` that `hints/linux.500:296` would otherwise supply.

So: turn `SELF_RECOVER` on, call `save_currentstate()` more often than level changes,
and give the level files somewhere to survive.

## Design

### 1. Build flags

`scripts/build/build-wasm.sh` gains two additions to `EMCC_CFLAGS`:

- `-DSELF_RECOVER`
- `-sEXPORTED_FUNCTIONS='["_main","_shim_graphics_set_callback","_repopulate_perminvent","_malloc","_save_currentstate"]'`

The link rule is `$(TARGET_CC) $(TARGET_LFLAGS) $(TARGET_CFLAGS) -o $@`
(`src/Makefile:3415`) and `TARGET_CFLAGS` begins with `$(EMCC_CFLAGS)`
(`src/Makefile:1539`), so our export list lands after upstream's and wins. No submodule
patch — `external/NetHack` stays trivially rebasable, per the 2026-07-25 decision.

The four inherited names are restated verbatim from `cross-pre2.500:325`. The build
script asserts they still match upstream, so a rebase that changes them fails loudly
instead of silently dropping an export.

Flag changes do not invalidate `.o` files, so this needs a clean rebuild.

### 2. Drop `MAXPLAYERS` from the runtime sysconf

`worker.ts` writes `/sysconf` in `preRun`. Today it contains `MAXPLAYERS=1`, which makes
`libnhmain.c:455-456` set `gl.locknum = 1`. That routes `getlock()` into the
`alock`/`block` branch (`unixunix.c:140-167`), which has **no recovery path at all** —
it only ages locks out or dies with "Too many hacks running now." The recover branch
lives exclusively in the `gl.locknum == 0` arm (`unixunix.c:217-227`).

With `MAXPLAYERS` gone, `sysopt.maxplayers` keeps its default 0 (`sys.c:61`), the lock
becomes `/0<plname>.0` (`getuid()` is 0 under emscripten), and per-level files are
`/0<plname>.<ledger>`. One tab already owns the volume by Web Lock, so nothing else
depended on `MAXPLAYERS`.

### 3. `src/core/checkpoint.ts` — policy and mirror

New module, owning one job: decide when to checkpoint, and mirror the result.

**Trigger.** `maybeCheckpoint()` is called from `worker.ts`'s `shim_nh_poskey` branch,
*before* it awaits the main thread. Two conditions, both required: at least
`CHECKPOINT_COMMANDS` (100) player commands since the last checkpoint, and at least
`CHECKPOINT_MIN_MS` (20 s) of wall clock.

Command count is a proxy for turns, chosen deliberately: the true turn counter reaches
JS only through `BL_TIME` status updates, which NetHack suppresses when the player's
`time` option is off. A proxy that always works beats an exact number that silently
stops.

**Reentrancy.** `_save_currentstate()` is an ordinary nested wasm call at that point.
`winshim.c:264` runs our handler synchronously inside `Asyncify.handleSleep`'s
`startAsync`, while `Asyncify.state` is still `Normal` and the unwind has not begun
(`libasync.js:339-346`); the nested export pushes and pops `exportCallStack` before
`setDataRewindFunc` reads it.

That is not sufficient on its own, and the reason is worth recording because it is
invisible and it silently produces a mirror that cannot be recovered. **The checkpoint
does reach the windowport**, twice, on its normal success path: `mark_synch()` is the
first statement of `currentlevel_rewrite()` (`do.c:1331`), and `savegamestate()` pulls
`getmsghistory()` through `save_msghistory()` (`save.c:1058`). Since the bridge is
`async`, each of those resolves on a microtask, so `handleSleep` starts a real unwind
that runs straight out of `save_currentstate` — which returns having written nothing.
Measured against the real engine: four "successful" checkpoints, `level.0` present, and
no current-level file at all. `recover_savefile()` requires level `savelev`
(`files.c:2978`), so the set is worthless.

The fix is to answer those two calls **synchronously**. For the duration of the
reentrant call the bridge is swapped for a handler returning a thenable that invokes its
callback in place, so `wakeUp()` runs before `handleSleep` sets `reachedAfterCallback`
and emscripten takes its "happening synchronously" path (`libasync.js:354-357`) instead
of unwinding. Return types still matter — `getmsghistory` must get a string, and `""` is
both correct and what `TextHud` already returns.

`shim_mark_synch` and `shim_getmsghistory` are the entire expected set. Any other name
means the checkpoint tried to talk to the player — `pline1(whynot)` or `done(TRICKED)`
from a failed `create_levelfile` — and marks autosave dead rather than reaching the main
thread. winshim's own `reentryMutexLock` guard logs a "will crash emscripten Asyncify"
error on every checkpoint; with the synchronous answer it does not crash, and the guard
is left alone because the outer call needs `shimFunctionRunning`.

`checkpoint.ts` does not touch `globalThis.nethackShimBridge` itself — installing the
answerer is a `CheckpointDeps` callback that `worker.ts` supplies, so the module stays
ignorant of the shim.

**Liveness check.** `do.c:1388-1389` returns on `!nhfp` without decrementing
`program_state.in_checkpoint`, which permanently disables checkpointing via the guard at
`do.c:1381` — an upstream bug reachable in a browser when MEMFS runs out. After each
call, compare `level.0`'s size and mtime against the previous checkpoint. If two
consecutive checkpoints leave it untouched, stop trying and post a `notice` so the
player knows autosave died rather than discovering it at the reload.

**Mirror.** After a successful checkpoint, copy every `/0<plname>.<n>` whose size or
mtime changed into `/persist/recover/`, then write `/persist/recover/manifest.json`
(plname, `savelev`, the file list with sizes, a format version) **last**, then
`flush()`. The manifest is the commit record: a set without a matching manifest is
ignored at boot. Steady-state cost is `level.0` (~33 KB) plus the current level
(~15-33 KB) per checkpoint; other levels are rewritten only when the hero leaves them.
Nothing is written per stair.

**Clearing.** The mirror is removed at `shim_exit_nhwindows`, which covers `#save`,
death, and quit alike — a save file exists or the game is over, so in both cases the
recovery set is stale. It is also removed once a boot has consumed it.

### 4. `src/core/persist.ts` — restoring the set at boot

After the populate sync and before `main()` runs (still inside the run dependency),
`persist.ts` copies `/persist/recover/*` back to the FS root, but only when all of:

- the manifest exists, parses, and its format version matches;
- every file it lists is present with the recorded size;
- `/persist/save` is empty (a real save file always wins);
- `level.0` is at least the 209-byte header, and the `savelev` at offset `0x04` names a
  level file that is present.

Otherwise the set is deleted and the game boots fresh. This validation is not
belt-and-braces: `getlock()` answers a failed `recover_savefile()` with
`error("Couldn't recover old game.")` (`unixunix.c:225`), which kills the process. A
half-written mirror must never reach the engine.

The header layout is fixed by the wasm32 ABI — `int hpid`, `int savelev`,
`char savename[54]`, `char indicator`, `char cscsize`, `uchar cscbuf[80]`,
`version_info[12]`, `int pltmpsiz`, `char plbuf[49]`. Only `savelev` is read.

Restoring the mirror stays inside the writer-election that already exists: a tab that
did not win the lock never mounts the volume, so it can neither read nor clear a mirror.

### 5. Silent resume

With a lock file present, `getlock()` asks
`"Old game in progress. Destroy [y], Recover [r], or Cancel [n]?"` through
`yn_function`. `worker.ts` answers `r` itself on an exact query match rather than
forwarding it — the player closed a tab and reopened it; they should find their game,
not a question about NetHack's locking. Every other `yn_function` is untouched.

## Known side effects

Taking a checkpoint more often than upstream does is not free:

- `savemonchn()` calls `forget_temple_entry()` for every priest on each checkpoint
  (`save.c:883`), zeroing `intone_time`, `enter_time`, `peaceful_time`, `hostile_time`.
  Upstream pays this once per level change. This is the main reason the interval is 100
  commands and not 10.
- `dmonsfree()`/`dobjsfree()` run per checkpoint (`save.c:516-520`); they purge only
  already-dead entities.
- `urealtime` accrues per checkpoint (`save.c:282-284,318`) — correct accounting.
- `u.ustuck_mid`/`u.usteed_mid` are zeroed (`save.c:312-313`); scratch fields set moments
  earlier in the same call.

`recover_savefile()` re-stamps the synthesized save with the **running** binary's version
(`store_version`, `files.c:2987`) instead of copying level.0's through. A mirror written
by one wasm build and recovered by another therefore claims a version it does not have.
Level data format changes between NetHack builds are the real risk; the manifest carries
a build stamp and a mismatch discards the set.

## Testing

- `scripts/test/test-autosave.mjs` — boot, play past the checkpoint threshold, drop the
  module without saving (the closed tab), reboot, assert the same character comes back
  and the mirror was consumed. Follows the `test-save-restore.mjs` driver shape.
- A negative case in the same file: a mirror with a truncated `level.0` must be discarded
  and the boot must succeed as a new game rather than dying in `error()`.
- `test-tabs` gains an assertion that a non-writer tab never creates `/persist/recover`.
- Both run in `npm test`.

## Out of scope

Bones files (`vect-hack-nvx`) and message-history round-tripping — `getmsghistory`
returns `""` and `putmsghistory` is unhandled today, so the engine's own scrollback is
lost across any restore, autosave or not. Both are pre-existing and tracked separately.
