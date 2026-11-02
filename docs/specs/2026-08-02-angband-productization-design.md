# Angband Module productization — design

2026-08-02. Phase 3 of epic vect-hack-3vk, per the platform design's
Sequencing #3 (`docs/specs/2026-08-02-vect-platform-design.md`).
Vocabulary is binding: `CONTEXT.md` (App, Module, Backplane, Cell, Category,
Kind, Classifier). Builds directly on the backplane design
(`2026-08-02-backplane-design.md`) — its Category table's Angband column, its
"keeps private" list, and its deferred-to-phase-3 notes are this document's
starting obligations. Every engine claim below was verified against the pinned
submodule (4.2.6-166, f0f6bd223), not remembered. This is a design, not a
plan; the plan is a separate pass over this document. A Codex deep review
(2026-08-02) is folded in throughout — its two confirmed defects reshaped the
underlay claim and the dirty-set design.

Resolves bead **vect-hack-3vk.5** (top-glyph model: terrain holes + rebuild
churn), absorbs most of **vect-hack-skw** (quit UX), and makes the merge gate
**vect-hack-3vk.4** (borg plays in 3D crash-free) runnable. The parked
attitude question from **vect-hack-avm**'s last comment is answered (it stays
parked, with the reason).

## Settled decisions (Eric, 2026-08-03)

Eric accepted all eight recommendations as written on 2026-08-03. They are
binding for the implementation plan.

1. **Terrain underlay: an additive `Cell.terrain` field, not a separate
   terrain layer** (resolves the terrain-holes half of vect-hack-3vk.5, and
   the monster-step revision churn). One optional field the Classifier fills
   with the covered terrain Cell; renderer reads it in two places; Modules
   that don't supply it (NetHack) render byte-identically. A second grid
   layer would double the set() traffic and force every view and the page
   helpers through a two-surface API for the same information. It does
   **not** by itself bound borg-paced terrain rebuilds — the renderer also
   rebuilds on every hero move because lighting is baked into terrain
   geometry (`DungeonRenderer.frame`); that is a distinct problem with its
   own risk entry below.
2. **Classifier input: a `map_info` tap in `native/main-wasm.c`, batched per
   frame — not tty parsing.** The backplane design's risk bullet predicted
   this; the audit below confirms the tty stream cannot carry the semantics.
   The tap uses only public engine API (`event_add_handler`, `map_info`,
   `grid_data_as_text`) — the submodule stays unpatched.
3. **The CellGrid is dungeon-sized (198×66), not term-sized.** Angband's term
   shows a scrolling panel of a level up to `z_info->dungeon_wid×hgt` =
   198×66 (`lib/gamedata/constants.txt:104-107`); the 3D view escapes the
   viewport entirely and the camera pans a whole level, as it does for
   NetHack's 80×21.
4. **No shared HUD shell.** Judged from the code, not doctrine: TextHud is
   windowport-structured (typed menus, status fields, prompts as events);
   Angband's chrome arrives as painted term text. The only shareable piece
   would be a message `<div>`. Angband's HUD is the mirrored term — three
   chrome strips plus a full-term overlay while `screen_save_depth > 0` —
   reusing the spike's `AngbandGrid`/`gridToHtml` wholesale.
5. **Checkpointing calls the engine's own `save_game_checked()`
   (ui-game.c:1046) on a TS-owned cadence.** Angband's savefile is a single
   atomic, non-destructive file (`savefile.c:400-434`: write `.new`, swap,
   delete `.old`) and the engine already autosaves on every level change
   (`ui-display.c:2543-2547`). No mirror, no `recoverSave` analogue, no
   suspended-bridge machinery — NetHack's whole checkpoint apparatus exists
   to route around engine behaviors Angband simply doesn't have.
6. **Borg: `-DALLOW_BORG` in the Engine Build plus a `?borg` App flag that
   types the activation keys.** The borg is engine-internal C
   (`src/borg/`, 177 files, already linked as empty translation units); the
   App's whole contribution is keystrokes, the `?bot` precedent.
7. **vect-hack-skw absorption: caveats (1) and (2) absorbed, (3) parked.**
   The protocol carries quit nullness; wizard-mode `quit("user choice")`
   (cmd-wizard.c:2151) classifies as a quit, not a death. The bridge-level
   abort response stays parked on skw — speculative until a real dispatch
   failure lands in a keymap editor.
8. **No Angband pointer verbs in phase 3.** The pointer drags the camera;
   click-to-act is NetHack Module UI (`pointerActions` speaks NetHack keys)
   and porting it is post-gate polish, not productization. Parked, not
   declined.

## The Classifier

### Why map_info, not the tty stream

The term grid fails four ways, each verified:

- **Ambiguity.** `#` is granite, permanent wall, secret door, *or lava*
  (terrain.txt: GRANITE `#:W`, PERM `#:z`, SECRET `#:w`, LAVA `#:r`) — lava
  vs wall by color alone repeats NetHack's `}` hack at higher stakes, and
  `%` is a vein or a web (trap.txt). `'` is an open or broken door.
- **Coordinates.** The term draws a scrolled panel with a 13-column sidebar
  and message/status rows (`ROW_MAP`/`COL_MAP`, ui-term.h:257-274); cell
  (x, y) means nothing stable in dungeon space.
- **Covered terrain.** The term carries only the top glyph — exactly the
  3vk.5 defect. `map_info` hands over occupant *and* terrain at once.
- **Overlays.** Menus, stores and the birth screen paint straight over the
  map region; a tty-parsing classifier would classify an inventory list.

`map_info(struct loc, struct grid_data *)` is public core API (cave.h:237,
included directly by upstream front ends), and `struct grid_data`
(cave.h:146-159) carries everything a Cell needs: `f_idx`, `m_idx`,
`is_player`, `first_kind`/`multiple_objects`/`unseen_object`/`unseen_money`,
`trap`, `lighting`, `in_view`, `hallucinate`. `grid_data_as_text`
(ui-map.h:19) resolves it to a foreground attr/char pair **and a separate
terrain attr/char pair** (`*tap`/`*tcp` — upstream keeps the underlay for its
own transparency effects, which is the *feature* underlay handed to us for
free). One precision the Codex review pinned: `*tap`/`*tcp` is captured
*before* the trap overlay is applied (ui-map.c:188-192), so a being standing
on a known trap gets its `terrain` underlay from the record's separate trap
pair (`g->trap`), not from tap/tcp — feature pair as the fallback.

### The native tap (main-wasm.c; the submodule stays unpatched)

- Register handlers with the public `event_add_handler` (game-event.h):
  - **EVENT_MAP** — fired per changed grid with dungeon coords in
    `data->point` (cave-map.c:259), or the `(-1, -1)` sentinel meaning
    "everything". The handler marks grids dirty (sentinel = all of
    `cave->width × cave->height`); nothing is posted yet.
    **Known gap (Codex-confirmed):** object detection updates knowledge
    without firing EVENT_MAP — `DETECT_OBJECTS`/`DETECT_GOLD` mark only
    `PR_ITEMLIST` (effect-handler-general.c:1737, 1757), and
    `object_see`/`object_sense` emit nothing. An event-only dirty set
    misses detected floor objects. The plan must add a dirty source;
    candidate: a full-grid sweep on the next flush after any non-EVENT_MAP
    game event batch (bounded — the sentinel path already handles a full
    sweep per flush), verified against a live detection cast before
    narrowing.
  - **EVENT_NEW_LEVEL_DISPLAY** — posts a `level` event: the view clears the
    grid and recentres (the `clear_nhwindow` analogue).
  - **EVENT_MESSAGE** — posts `{text, type}` (message.c:417/444): clean typed
    messages for the HUD strip, no term scraping.
  - **EVENT_BOLT / EVENT_MISSILE / EVENT_EXPLOSION** — posts effect events
    from the union payloads (game-event.h:106-198): coords, `proj_type`,
    and `bolt.beam`. These are the only transient visuals that never appear
    in `map_info`.
- At **TERM_XTRA_FRESH** (the frame boundary the term already gives us) the
  dirty set is resolved — `map_info` + `grid_data_as_text` per grid — and
  posted as **one packed `Int32Array` of grid records** (transferable).
  One postMessage per frame kills the per-square message storm that
  vect-hack-yzk measured (28-80 tasks per town step) before it ever reaches
  the 3D path.
- A grid record carries: `x, y, f_idx, flags (is_player | monster | pile |
  object | unseen_object | unseen_money | hallucinate | in_view), lighting,
  top attr/char, terrain attr/char, trap attr/char` (zero when no visible
  trap — `get_trap_graphics` is static, but its ~6 lines read only the
  public `trap_x_attr`/`trap_x_char` tables (ui-prefs.h:42-43) and the
  `TRF_VISIBLE` flag, transliterated into the tap).
- Both attrs are posted **already folded**: `color_table[a].color_translate
  [ATTR_VGA]` (z-color.h:66-102 — the 16-color translation column, upstream's
  own fold, e.g. VIOLET→L_PURPLE, TEAL→BLUE, MUSTARD→YELLOW) plus the
  `rgb_from_attr` 24-bit value the spike already computes. Engine-true fold,
  zero vendored tables in TS.

The tty stream (`text`/`wipe`/`curs`/`clear`/`flush`) continues unchanged
beside all of this — TtyView and the HUD chrome consume it.

### Category and Kind mapping

Grounded in `terrain.txt` (25 features) and `trap.txt` (37 traps); refines
the backplane design's Angband column. Category from `f_idx` — semantic ids,
not glyph guessing. Kinds are advisory (renderer ignores them today).

| Engine (f_idx / grid_data) | Category | Kind | Notes |
|---|---|---|---|
| FEAT_NONE | unseen | | unknown grid |
| FLOOR | floor | | |
| CLOSED | door | | SECRET mimics GRANITE until found, so it arrives as wall — free |
| OPEN | door-open | | |
| BROKEN | door-open | broken | |
| LESS / MORE | stairs | up / down | |
| STORE_* (1-8), HOME | feature | store | town digits; letterform on floor |
| RUBBLE / PASS_RUBBLE | feature | rubble | impassable/passable is the engine's business |
| MAGMA, QUARTZ | wall | mineral-vein | `%` |
| MAGMA_K, QUARTZ_K | wall | mineral-vein | `*`, gold-tinted by color |
| GRANITE | wall | | |
| PERM | wall | permanent | |
| LAVA | lava | | `#` red, PASSABLE+FIERY — Category, not glyph, is what saves this from rendering as a wall |
| visible trap (grid_data.trap) | trap | trap kind's short name | webs (`%`), wards (`;`), runes, pits — all trap |
| monster (m_idx) | being | | |
| is_player | being | + `hero` hint | |
| first_kind / pile / unseen obj/money | item | | |
| bolt/missile/explosion events | effect | | `beam` hint from `bolt.beam`; ch from the proj_type glyph the tap computes the way display_bolt does |

`corridor` and `water` are never produced (vanilla 4.2 has neither), exactly
as the backplane table predicted — a Module never has to produce every
Category.

### Hints

- **hero** — `grid_data.is_player` (map_info encodes player occupancy as this
  bool, m_idx zeroed).
- **pet** — never set; vanilla Angband has no allied monsters.
- **beam** — from EVENT_BOLT's `beam` flag; explosions and missiles are
  letterform effects.
- **attitude** (parked in vect-hack-avm's last comment) — **stays parked.**
  The doctrine is a hint needs a consumer and a producer; Angband vanilla has
  no peaceful/neutral beings to report, and NetHack's windowport never learns
  peacefulness. Neither consumer can produce it, so adding it now would be
  Backplane over-fitting by the design's own rule. `isHostile`'s
  approximation stands.

## Terrain underlay — the one Backplane change

`src/backplane/cell.ts` gains one optional field:

```ts
export interface Cell {
  // ... unchanged ...
  /** Terrain beneath a being/item/effect Cell, when the Module knows it.
   *  Category must be in TERRAIN_CATEGORIES; hints on it are ignored. */
  terrain?: Cell;
}
```

Semantics, and the two renderer touch-points (both game-free, hygiene-clean):

- `terrainOf(c)` (cell.ts) becomes: the cell's own Category when terrain,
  else `c.terrain?.category ?? null`. Consequence: a monster stepping across
  supplied-underlay floor is floor→floor — **no `terrainRevision` bump from
  monster movement**. Honest scope (Codex-corrected): this kills the
  revision-churn half of 3vk.5, but the renderer *also* rebuilds terrain on
  every hero move (lighting is position-baked; `DungeonRenderer.frame`'s
  `builtHero` check), so borg-paced rebuild cost is a separate risk with its
  own entry below.
- `TerrainBuilder.kind()` (and WallFill through it): a non-terrain cell
  answers with `cell.terrain?.category ?? "unseen"` instead of collapsing to
  unseen. Covered floor/trap/stairs stay in the static geometry — the
  terrain-holes fix. The `isOpen` widening trap documented in cell.ts
  resolves the right way for free: callers keep asking about terrain, and
  now occupied tiles have terrain to answer with.

Audited against both consumers, as the hygiene rule requires:

- **Angband** supplies it always (map_info's `*tap`/`*tcp` pair, plus the
  trap overlay when visible) — its correctness and its rebuild rate under
  the borg depend on it.
- **NetHack** does not supply it (print_glyph carries only the top glyph),
  and with the field absent both touch-points reduce to today's exact
  behavior — pinned by the classifier tests and byte-identical previews.
  The field is also the honest generalization of the hero-under stash
  `CellGrid` already keeps; folding the stash into it is noted as a future
  cleanup, deliberately not done in phase 3 (no NetHack behavior changes in
  an Angband phase).
- **Renderer-safe for Modules that don't supply it** by construction:
  `undefined` short-circuits to the current code path.

Rejected alternative (bead's other candidate): a separate terrain layer —
a second grid doubles set() traffic, complicates `clear()`/revision/page
helpers, and forces every consumer to learn a two-surface API for
information that is per-cell anyway.

## The 3D view

`src/modules/angband/ui/VectorView.ts`, mirroring the NetHack view's shape:
owns the pipeline **grid records → classifier → `grid.set()`**, constructs
`new CellGrid(ANGBAND_COLS, ANGBAND_ROWS)` (198×66, constants owned by
`classifier.ts` exactly as `NETHACK_COLS/ROWS` are), passes it to the shared
`DungeonRenderer`, and wires the shared `Radar` (isHostile works unchanged:
every Angband being that isn't the hero is fair game). `level` events clear
the grid and recentre, the `display_nhwindow`-analogue is the frame-boundary
flush that already exists.

- **TtyView stays**, twice over: unchanged as the `?view=debug` analogue
  (`?game=angband&view=debug`), and its grid/renderer reused as the overlay
  surface below.
- **HUD chrome, from the mirrored term** (decision #4): the sidebar columns
  (0..COL_MAP-1) render as a side panel, the bottom row into `#status`, and
  EVENT_MESSAGE feeds `#messages` (history for free); term row 0 mirrors
  into a prompt strip — it is where `prt()` prompts and `-more-` land.
  vect-hack-skw's "empty strips" resolve by being used, not removed.
- **Full-term overlay**: while `screen_save_depth > 0` (public,
  ui-output.h:96) or `!character_generated`, the whole term grid renders
  over the canvas — inventory, stores, birth, options, the death screen, all
  with zero new UI code, because Angband's own textui is the menu system.
  Coverage claim, stated precisely: bare `menu_select` does not itself
  save the screen (ui-menu.c:767) — the full-screen textui flows are covered
  because their *callers* screen-save or run outside the world
  (`!character_generated`), which a live-game sweep of the flows above
  verifies. The tap posts the depth transition on flush.
- **Pointer**: camera drag only (decision #8).

## First person

- **F2 parity is free at the renderer**: `DungeonRenderer.toggleMode()` is
  already game-free; the Angband view wires the same F2 listener and message
  the NetHack view has. Function keys remain App chrome (house rule).
- **What generalizes** (both consumers now want it): the pure gaze
  arithmetic — `compass()`, the eighth-turn `STEP_OF` offsets, `dirTo`,
  the `Resolved` shape, `chord()` naming — extracted to shared
  `src/ui/gaze.ts` (src/ui is the shared-UI home; the Backplane stays out of
  it — movement resolution is Module UI, per the backplane design, and this
  is arithmetic, not resolution).
- **What stays Module-owned**: binding tables and key emission. Angband's
  resolver maps compass index → **a digit keycode with
  `KC_MOD_KEYPAD`, plus `KC_MOD_SHIFT` to run** (ui-event.h:48-52) — the
  stock `pref.prf` keymaps translate `{K}digit` → walk (`;N`) and
  `{SK}digit` → run (`.N`) in the engine, so movement is one keystroke and
  engine-native. `keys.ts` gains real `mods` (the spike hardcoded 0);
  Shift+arrow then runs even in the un-remapped tty view, for free.
- **The prompt gate, done better than NetHack's**: `gatherKey` grows a `cmd`
  flag computed engine-side at the moment of the wait —
  `character_generated && inkey_flag && screen_save_depth == 0`.
  `inkey_flag` is upstream's own command-loop discriminator (documented at
  ui-input.c:150, set in `textui_get_command`); main-win.c gates Save/Exit
  on it (main-win.c:3554) — our predicate is a strict tightening of that,
  not a verbatim copy. The getKey request carries it on **both** wait modes
  (the command loop polls `wait=false` before blocking), so the view remaps
  arrows only when answering a command-loop request. NetHack's
  `prompting`-counter heuristic exists because the windowport can't see this;
  Angband can, so "a prompt never sees a remapped arrow" is structural, not
  inferred.

## Persistence

### The extracted mount machinery (the phase-3 obligation from the backplane design)

`persist.ts`'s generic layer moves to `src/backplane/persistFs.ts` now that
the second consumer exists: volume mount with `autoPersist`, the
populate/flush `syncOnce` with its 10s timeout, Web Lock writer election with
its 5s timeout, the run-dependency bracket, and the `PersistHandle` shape
(`ready/persistent/reason/flush/release`). Signature in the spirit of
`mountVolume(mod, VOLUMES.<game>, { locks, seed, onMounted })` — the Module
passes what to do inside the mounted volume.

NetHack keeps, Module-private and behaviorally untouched: the symlink farm
and its path list, bones mirroring, score files, the recovery-set restore,
`RECOVER_QUERY`. Its five engine tests are the proof the extraction changed
nothing.

### The Angband volume

`VOLUMES.angband` (`/vect-angband`, `vect-angband/persist`) — already
registered, now mounted. Angband roots everything under the `--preload-file`
mount `/lib` (init_file_paths("/lib/")), so the writable directories are
symlinked into the volume before `main()` runs: `/lib/save`, `/lib/scores`,
`/lib/user` (prefs, and `borg.txt`), `/lib/panic` → `/vect-angband/{save,
scores,user,panic}`. `create_needed_dirs()` tolerates them existing;
`savefile_save`'s `.new`→swap rename stays inside one mount. preRun ordering
against the file packager (which also populates `/lib` in preRun) is a plan
detail to verify; worst case the tap's preRun creates `/lib` first, which the
packager tolerates. Losing the lock election means session-only MEMFS, same
UX and wording as NetHack.

### Save model and checkpointing — why there is no checkpoint.ts port

The two Modules' engines differ exactly where NetHack forced complexity:

| | NetHack | Angband |
|---|---|---|
| Save file | deleted on restore | persists; atomic write (`.new`/`.old` swap, savefile.c:400) |
| Death | save gone | savefile overwritten in place with the dead character |
| Mid-game save API | `save_currentstate()` export, windowport calls answered in-place under Asyncify | `save_game_checked()` (ui-game.c:1046), a public call upstream front ends make from their input hooks |
| Engine autosave | level change only, mirror needed | level change, built in (`upkeep->autosave` consumed at ui-display.c:2543 — active via our `init_display()`) |

So: **no mirror, no manifest, no rebuild port.** The design is three small
pieces:

1. `main-wasm.c`'s `TERM_XTRA_EVENT` path asks JS `wasm_checkpoint_due()`
   (sync EM_JS) before suspending; when true — and only when
   `character_generated && inkey_flag && !screen_save_depth`, the main-win
   gate, in the exact call context main-win's menu handler uses — it calls
   `save_game_checked()`. No Asyncify hazard: the call happens before the
   suspend, and every term write it makes (`prt("Saving game...")`,
   `Term_fresh`) is a one-way post.
2. The cadence policy lives worker-side in TS (`angbandCheckpoint.ts`):
   commands counted per `cmd`-flagged getKey, the same
   100-commands/20s-interval defaults, unit-testable like NetHack's.
3. `autoPersist` flushes the write; the worker also awaits an explicit
   flush before surfacing `quit`, so the `close_game()` save has landed
   before the player is told to reload.

Boot changes from `play_game(GAME_NEW)` to **`play_game(GAME_LOAD)`**:
`start_game(false)` (ui-game.c:700) loads an existing savefile, falls
through to `textui_do_birth()` when the file is missing **or holds a dead
character** — resume, new-game and after-death flows in one engine-owned
branch, including its own panic-save offer. The upstream panic-save *writer*
is signal-driven and dormant under wasm; the checkpoint cadence is what
bounds loss from a killed tab.

### Death and quit

Death runs Angband's own death screen (through the overlay), `close_game`
saves the dead character, `play_game` returns, `quit(NULL)` fires → the quit
notice. Next boot births a new character from the same volume; scores
accumulated in `/lib/scores` persist. No special casing in the Module.

## Borg readiness (the vect-hack-3vk.4 gate)

- **Engine Build**: add `-DALLOW_BORG` to `angband-wasm.mk` CFLAGS
  (upstream's own `Makefile.std:66` flag). The borg objects are already in
  BASEOBJS compiling empty; the define fills them. This is an Engine Build
  concern only — no Backplane or Module API is involved, as the backplane
  design verified.
- **The canary rule, restated as a hard step**: `game_event_dispatch` in
  `ASYNCIFY_REMOVE` is inert only while the linker warns it cannot resolve
  it. Whether an ALLOW_BORG build arms it is *unknown* — the function is
  `static` (game-event.c:33), so the symbol may never externalize; the rule
  is checked empirically, not assumed. After the first such build, if the
  warning is gone the entry MUST be deleted
  (angband-wasm.mk's comment; vect-hack-3vk.4). Shelob's dropped
  `borg_sort_aux`/`borg_notice`/`borg_notice_aux1` entries are *not*
  restored blindly: 4.2.6's borg is a rewrite, and anything re-added to
  ASYNCIFY_REMOVE must first be audited unable to reach a suspend
  (Term_xtra EVENT/DELAY), same discipline as the existing list.
- **Runtime**: Ctrl-Z → `do_cmd_try_borg` (command table ui-game.c:227;
  keys.ts's KTRL fold already produces 0x1a) → first activation asks the
  NOSCORE confirmation (cmd-misc.c:117), so the scripted sequence is
  **`^Z y z`** — then the borg command menu (`do_cmd_borg`); `z` starts
  continuous play. Its abort-key polling is `Term_inkey(…, false, true)`
  (borg.c:437) — the `wait=false` immediate-answer path the spike already
  implements, which must stay synchronous-fast. The borg replaces the input
  source via `inkey_hack` (ui-input.c:225) — our front end routes every key
  through the stock `inkey()` machinery, so it engages with no front-end
  work. While it plays, blocking `getKey` requests simply stop arriving
  (the pull-model indifference the backplane design promised); its
  stop-check polls arrive as `wait=false` requests, which the spike already
  answers. `borg.txt` self-creates in `ANGBAND_DIR_USER` → persisted in the
  volume. It sets `NOSCORE_BORG`, so score-file hygiene is upstream's.
- **`?borg` App flag** (main.ts, `?bot` precedent): scripted birth
  keystrokes, then `^Z z`, wired only in main.ts. The gate run is this flag
  plus the 3D view for a sustained session — which is precisely the load the
  terrain-underlay change exists to survive: without it every borg step
  rebuilds 198×66 worth of terrain geometry.

## Quit / fatal UX (vect-hack-skw absorbed)

- `wasm_quit_js` carries nullness (`msg == NULL` flag) instead of collapsing
  NULL and `""` (caveat 2); `quitMessage` branches on it plus one documented
  allowlist entry: `"user choice"` — the only user-initiated non-NULL
  `quit()` in the tree (cmd-wizard.c:2151) — classifies as quit, not death
  (caveat 1).
- Quit wording gains the save state: with a mounted volume, "Angband exited —
  your game is saved. Reload to continue." (session-only keeps the current
  reload-to-restart wording). Death reads differently from quit only in what
  the engine already painted (death screen through the overlay).
- The `#messages`/`#status` strips are used, not removed (skw's (a)).
- Parked on skw: the bridge-level abort/disconnect reply (caveat 3).

## Testing

`npm test` stays green at every commit of the plan. New coverage, in the
established molds:

- **`angband-classifier.test.ts`** — packed grid records → Cells: every
  terrain.txt feature to its Category/Kind, trap overlay to `trap`,
  occupant records carrying `terrain` underlay, hero hint, the VGA fold
  values as posted (fixtures use upstream's numbers). The Angband analogue
  of `nethack-classifier.test.ts`.
- **`backplane-cell.test.ts` grows underlay cases** — `terrainOf` through
  `set()`: occupant-with-underlay causes no revision bump; occupant without
  (NetHack shape) keeps today's bump; TerrainBuilder's kind() fallback
  truth table.
- **`gaze.test.ts`** — the extracted arithmetic, moved assertions from
  `move-keys.test.ts`; NetHack's suites keep pinning its emission tables.
- **`angband-keys.test.ts` grows mods** — Shift/keypad mods, digit+mods
  movement emission, the cmd-flag gate (a remapped arrow never answers a
  `cmd:false` request).
- **Node engine tests** (real engine, real worker):
  - `test:angband-persist` — savefile + scores + `user/` round-trip through
    a real IDBFS volume at the new mountpoint.
  - `test:angband-save-restore` — scripted birth, Ctrl-X save, reload,
    `GAME_LOAD` resumes the same character.
  - `test:angband-autosave` — forced cadence: checkpoint lands mid-play, the
    worker is killed, the reboot resumes from the checkpoint.
  - **No `test:angband-tabs`.** The election it would exercise is now the
    shared `persistFs.ts`, pinned live by NetHack's `test:tabs` and by
    backplane unit tests with fake locks; a second two-engine boot buys
    minutes of CI for no new code path.
- **`backplane-persist.test.ts`** — the extracted mount/lock/sync mechanism
  against fake FS/locks: election loss → session-only, sync timeout →
  reason set, release() hands over.
- The NetHack five remain the merge-blocking net proving the extraction
  changed nothing; previews must stay byte-identical (NetHack supplies no
  underlay, so any preview delta is a bug).
- **`npm run preview` gains an Angband fixture scene** (classifier-fed grid
  through the real builders) — the no-GPU check for the new mapping.
- **GPU gates at wave boundaries**: `check:browser` learns
  `?game=angband`; a controls pass proves the composition (forward walks the
  gazed cell via digit+mods, turns send nothing, a store menu never sees a
  remapped arrow). The gate itself: a long `?borg` session in the 3D view,
  crash-free, then Eric's playtest (vect-hack-3vk.4).

## Risks

- **Sentinel storms.** `EVENT_MAP (-1,-1)` full-redraw signals fire from
  several core paths (player-calcs.c:2709 among them); each costs a
  198×66 `map_info` sweep and a ~420 KB post. Frame batching bounds it to
  one per flush, but the rate under borg play is unmeasured — measure early
  (the yzk methodology), and fall back to sweeping only known-bounds if it
  shows up.
- **Hero-move terrain rebuilds under the borg (Codex-confirmed defect in
  the original draft).** `DungeonRenderer.frame` rebuilds terrain whenever
  the hero moves, revision or not — lighting is baked per-vertex at build
  time (`fx.lightAt`). The underlay change cannot help with that; at 198×66
  under continuous borg play this is a full ~209 k-segment rebuild per step.
  Mitigations, in escalation order, chosen by measurement during the gate
  run: (a) capacity/rebuild scoped to live `cave->height/width` (town is
  66×22, most levels are far under max); (b) lighting moved out of the
  rebuild — a per-cell light attribute updated in place, geometry rebuilt
  only on revision. Both are renderer-only and hygiene-clean; neither is
  assumed done in phase 3 unless the gate run's frame rate demands it.
- **Effect erasure.** Bolt/explosion Cells written from events must be
  cleaned by the engine's follow-up EVENT_MAP signals on the affected grids;
  if any path skips them, ghost effects linger. Verify against a live game
  before building on it (the `__nhView.handle`-monkeypatch method); the
  fallback is a TTL on effect Cells, which MapFx-adjacent code can host
  without game semantics.
- **Capacity memory.** 198×66 at 16 edges/cell is ~209 k terrain segments
  (~8× NetHack) preallocated in `LineBatch` and `WallFill`. Likely fine on
  the target hardware, but check allocation cost on the WebGL fallback; the
  mitigation (capacity from live `cave->height/width` per level, town is
  66×22) is a renderer-safe change kept in reserve.
- **`save_game_checked()` in the wasm context.** Upstream calls it from the
  same Term_xtra-driven input context (main-win's message pump), but wasm is
  its first Asyncify neighborhood; `disturb`/`handle_stuff` inside it must
  not reach a suspend. Audit the call graph in the plan's first persistence
  task, and the autosave engine test exercises it against the real engine.
- **ALLOW_BORG changes the link.** New symbols, new code on Asyncify stacks,
  and the canary scenario armed. The first borg build re-audits the
  ASYNCIFY_REMOVE list and the canary warning before anything else lands on
  it; Safari stays the tuning risk it was in phase 1.
- **Pref-file drift.** The tap reads `feat_x_attr`/`trap_x_attr` etc. after
  `textui_init` loads `pref.prf`, so posted glyphs are the engine's own; but
  a future user-pref feature that rewrites visuals mid-game would need a
  full-redraw nudge. Not phase 3's problem; noted so it isn't rediscovered.
- **Underlay must be invisible to NetHack.** The one Backplane edit touches
  `terrainOf` and `TerrainBuilder.kind()` — both on NetHack's hot path. The
  guard is mechanical: classifier tests unchanged, previews byte-identical,
  the five engine tests green; any deviation is a defect in the change, not
  a new baseline.
- **Two views, one Module, no shared view interface — still.** The Angband
  view speaks grid-record/term events, NetHack's speaks windowport events;
  the temptation to invent a GameView interface returns with the second 3D
  view. Resisted for the same reason as phase 2: the contracts share almost
  nothing, and the Backplane stays thin.
