# Backplane extraction — design

2026-08-02. Phase 2 of epic vect-hack-3vk, per the platform design's
Sequencing #2 (`docs/specs/2026-08-02-vect-platform-design.md`).
Vocabulary is binding: `CONTEXT.md` (App, Module, Backplane, Cell, Category,
Kind, Classifier). Derived from the two real consumers: NetHack's mature
integration (`src/protocol.ts`, `src/core/`, `MapModel` and everything
downstream) and the Angband spike (`src/angband/`). This is a design, not a
plan; the plan is a separate pass over this document.

Resolves bead **vect-hack-avm** (color at the Backplane, GridCell rename, keys
hardening) and places the fix-once sites for **vect-hack-1g5** (console-only
fatal) and **vect-hack-c1w** (dispatch-no-catch).

## Settled decisions (Eric, 2026-08-02)

Formerly this design's open questions; all settled by Eric, and the rest of
the document reads as decided.

1. **Storage names: renamed, no migration.** One scheme for every Module —
   mountpoint `/vect-<game>`, Web Lock `vect-<game>/persist` — NetHack
   included. No migration code, no backward compatibility; existing saves
   are knowingly orphaned once. "This is unreleased software."
2. **Color at the Backplane: 16-slot palette index primary, rgb optional hint**
   (resolves vect-hack-avm). Skins — the product identity — retint by
   index; Angband's 28 colors fold to 16 in its Classifier via upstream
   `z-color`'s own translation column. `rgb` serves tty/debug views.
3. **Directory shape: `src/modules/nethack/` + `src/modules/angband/`**
   (Eric overrode the flat recommendation). The Backplane is not a Module and
   stays `src/backplane/`.
4. **The NetHack-owned UI (TextHud, VectorView, DebugView, pointer/key
   tables, bot) moves now** into `src/modules/nethack/` — the hygiene rule
   is only enforceable when ownership is a directory, not a convention.
5. **Angband stays pre-Cell in phase 2.** The Category draft is validated
   against Angband on paper (`terrain.txt` audit, table below); a
   throwaway Classifier would validate nothing.
6. **`door` and `door-open` are two Categories** — the renderer builds
   genuinely different geometry for them, which is the membership test.

## The Backplane

Four parts, matching the platform spec: the Cell grid, input, lifecycle,
and the persistence namespace. All internal, versioning with the App —
interfaces below can change freely whenever both consumers move together.

New top-level directory `src/backplane/`. Nothing in it may import from
`src/modules/*` or `src/render/` — the Backplane is types plus small
mechanisms, owned by the shared layer.

### Cell and Category (`src/backplane/cell.ts`)

```ts
/** Closed set, shared-layer-owned: exactly what renderer and radar branch on. */
export type Category =
  | "unseen"                                    // draw nothing
  | "floor" | "corridor" | "wall"
  | "door" | "door-open"
  | "stairs" | "water" | "lava" | "trap"
  | "feature"                                   // other terrain: letterform on floor
  | "being" | "item" | "effect";

export const TERRAIN_CATEGORIES: ReadonlySet<Category>; // all but being/item/effect/unseen

export interface Cell {
  category: Category;
  /** Open, module-owned, optional. The renderer ignores it today — the
   *  strongest form of "unknown Kinds draw acceptably". */
  kind?: string;
  /** The letterform the vector font draws; also the tty character. */
  ch: string;
  /** 16-slot palette index (the ANSI-16 vocabulary, today's CLR). Skins
   *  retint by index; this is the only color the 3D renderer and radar read. */
  color: number;
  /** Engine-true 24-bit color; tty/debug views may prefer it. */
  rgb?: number;
  // Standard hints — named booleans, never engine flag words.
  hero?: boolean;
  pet?: boolean;
  /** Effect drawn as an arcing beam along ch's axis (-|/\), not a letterform. */
  beam?: boolean;
}

export class CellGrid {
  constructor(readonly cols: number, readonly rows: number);
  readonly cells: Cell[];                       // row-major, dumb data
  terrainRevision: number;                      // bumps when a TERRAIN_CATEGORIES cell changes
  hero: { x: number; y: number } | null;        // set by hero hint; modules may also write it
  /** The Cell the hero landed on when terrain was showing (the stash MapModel
   *  keeps today, generalized to the whole Cell). */
  under: Cell | null;
  cursor: { x: number; y: number } | null;
  at(x: number, y: number): Cell;
  set(x: number, y: number, cell: Cell): void;  // hero-landing stash + revision logic
  clear(): void;
}

export function isOpen(c: Category): boolean;   // stand-on-able: not unseen, not wall
export function isHostile(c: Cell): boolean;    // being && !hero && !pet — the radar/pointer rule
```

This is today's `MapModel` minus classification: the grid mechanics
(bounds, hero stash, cursor, terrain revision) are already engine-agnostic
and move verbatim. Classification — `categorize()`, `terrainKind()`, the
`GLYPH_*` offsets, the `MG_*` bits, the pet/zap glyph ranges — is NetHack's
Classifier and moves to `src/modules/nethack/classifier.ts`, which turns a
`GlyphCell` into a Backplane `Cell` before `grid.set()` is called. Dimensions
become constructor arguments (NetHack 80×21, Angband 80×24): `COLNO`/`ROWNO`
stop being render-layer constants, and the renderer's capacity numbers
(`TERRAIN_CAPACITY`, `FILL_CAPACITY`) derive from the grid instance it is
given. `DungeonRenderer` stops constructing its own map — the Module's view
passes one in.

**Verified boundary.** The claim "everything downstream of MapModel is
engine-agnostic" is *almost* true and this design closes the gap: the
downstream consumers (`TerrainBuilder`, `EntityLayer`, `pick`, `Radar`)
branch only on `category`/`terrain`, `ch`, `color`, and the `MG.HERO`/
`MG.PET` flag bits plus `MapModel.isPet`. The MG bits and CLR indices are
NetHack vocabulary leaking through; they become the `hero`/`pet` hints and
the shared 16-slot index. `render/colors.ts` (CLR names) is promoted to the
Backplane's shared color vocabulary rather than duplicated.

### First Category draft — audited against both consumers

Columns prove each Category is genuinely shared (both games produce it) or
genuinely branch-worthy (the renderer builds distinct geometry for it even
if only one game produces it — a Module never has to produce every
Category). Angband column from `external/angband/lib/gamedata/terrain.txt`
and `trap.txt`; NetHack column from today's `categorize()`/`terrainKind()`.

| Category | Renderer branch | NetHack | Angband (4.2.6) |
|---|---|---|---|
| unseen | nothing drawn | blank / unexplored glyphs | unknown grid |
| floor | faint grid + region outline | `.` room floor, ice | open floor |
| corridor | path strokes | `#` corridors | — (corridors are open floor); branch-worthy |
| wall | wireframe ridges + depth mask | `|` `-` walls | granite/permanent wall; magma/quartz veins (kind `mineral-vein`), secret door |
| door | slab + rails | `+` closed door | closed door |
| door-open | jambs | brown `|`/`-` | open door, broken door (kind `broken`) |
| stairs | nested-square well | `<` `>` | up/down staircase |
| water | crest rows | `}` pools, moats | — (no water terrain in vanilla 4.2); branch-worthy |
| lava | taller crests, hot gain | red/orange `}` | lava |
| trap | danger frame | `^` `"` `~` (webs, vibrating square) | known traps (trap.txt) |
| feature | small letterform on floor | fountain, altar, throne, sink, grave, tree | rubble, store entrances (kind `store`) |
| being | tall letterform, rings, radar blip | monsters, hero, pets | monsters, `@` |
| item | small letterform | objects, corpses, statues, piles | items, gold |
| effect | bright letterform, or arc beam via hint | zaps (beam), explosions, swallow | bolt/beam/explosion chars |

Fourteen Categories; every current renderer branch is covered and nothing
speculative is added. `corridor` and `water` are NetHack-only today —
acceptable because the Backplane versions with the App: if phase 3 or a later
audit finds them wrong, they change then, cheaply.

### Session and lifecycle (`src/backplane/session.ts`)

Both sessions are the same 50 lines with different unions; the copy already
duplicated two open bugs (1g5, c1w). The shared layer owns the mechanism;
the Modules own the message vocabularies.

```ts
/** Lifecycle messages every Module's worker→main union must include. */
export type LifecycleToMain =
  | { type: "notice"; text: string }   // out-of-band player message
  | { type: "fatal"; message: string };

export interface SessionDelegate<In, Out> {
  onNotice(text: string): void;
  /** Player-facing wording for an engine death (checkpoint wording is
   *  NetHack's; Angband's says reload-to-restart). Routed to onNotice. */
  fatalNotice(message: string): string;
  /** Handle one game message; a returned message is posted to the worker. */
  dispatch(msg: In): Promise<Out | null>;
  /** The reply that unwedges the Asyncify-suspended engine when dispatch
   *  throws — cancel-shaped, per message type. null = no reply owed. */
  fallback(msg: In): Out | null;
}

export class EngineSession<In extends { type: string }, Out> {
  constructor(workerUrl: URL, delegate: SessionDelegate<In | LifecycleToMain, Out>);
  terminate(): void;
}
```

`EngineSession` owns: worker spawn, the `?trace` flag, `notice`/`fatal`
routing to `onNotice` (fixing vect-hack-1g5 once — an engine death becomes
an on-screen notice in every Module), and a try/catch around `dispatch`
that posts `fallback(msg)` and notices the failure (fixing vect-hack-c1w
once — a throwing view can no longer strand a suspended engine). NetHack's
fallback table is cancel-shaped: ESC for `nhgetch`/`nh_poskey`, `def` for
`yn_function`, `null` (cancel) for `getlin`/`select_menu`, no-reply-value
for display events. Angband's is `{code: ESC, mods: 0}` for `getKey`.

`ready` stays in each Module's own union — the payloads genuinely differ
(NetHack ships the engine's constants table; Angband ships nothing) and
inventing a common payload would be Backplane over-fitting. Same for Angband's
`quit` (currently mislabeled `fatal`): it becomes a Module message routed
to `onNotice` with quit wording, not a shared lifecycle case.

### Input (`src/backplane/keyQueue.ts`)

The Backplane's input contract is structural, and deliberately thin:

- Engines pull keys; they never receive DOM events. Each Module owns its
  `KeyboardEvent → engine key` map (`modules/nethack/ui` key tables,
  `modules/angband/keys.ts`).
- The App owns the keyboard chrome: function keys never reach a Module
  (house rule, both consumers already comply); Meta/Alt is per-Module policy,
  not a platform rule — NetHack folds Alt into its classic `M(c)` because the
  engine expects it, Angband leaves both to the browser.
- One shared mechanism: the buffer-or-waiter queue both consumers have
  independently written (TextHud's key queue, TtyView's `buffer`/`waiter`):

```ts
export class KeyQueue<K> {
  push(k: K): void;
  /** wait=false answers immediately (null = none); wait=true may block. */
  next(wait: boolean): K | null | Promise<K | null>;
}
```

Nothing more. Movement resolution, count prefixes, NumLock behavior,
prompts and menus are Module UI.

### Persistence namespace (`src/backplane/volumes.ts`)

```ts
export interface ModuleVolume {
  /** IDBFS mountpoint; also the IndexedDB database name. */
  mountpoint: string;
  /** Web Lock electing the single writing tab. */
  lock: string;
}
export const VOLUMES: Record<"nethack" | "angband", ModuleVolume> = {
  nethack: { mountpoint: "/vect-nethack", lock: "vect-nethack/persist" },
  angband: { mountpoint: "/vect-angband", lock: "vect-angband/persist" },
};
```

The registry is the namespace: one volume per Module, hard isolation, and
the mountpoints must differ because IDBFS keys its database by mountpoint
within the shared origin. NetHack's legacy names (`/persist`,
`vect-hack/persist`) are simply abandoned — no migration, no compat
(decision #1); saves under the old database are orphaned once. The platform spec's "shared layer owns volume
lifecycle (mount, flush, enumerate)" is deliberately **not** mechanized in
phase 2: `persist.ts`'s mount machinery (run dependency, syncfs timeout,
lock election) looks generic, but extracting it with one real consumer is
exactly the over-fitting this epic's sequencing exists to avoid. It is
extracted in phase 3, when Angband's saves make it a two-consumer Backplane —
same doctrine that deferred Categories past the spike. Until then the
registry constant is the whole shared surface, and Angband's spike
`ANGBAND_VOLUME` constant moves here.

## What moves where

Target layout (decision #3: Modules under `src/modules/`, the Backplane apart):

```
src/backplane/            cell.ts, session.ts, keyQueue.ts, volumes.ts   [new]
src/modules/nethack/ the NetHack Module
  protocol.ts        from src/protocol.ts
  worker.ts, session.ts, engineBoot.ts, evalShim.ts, wasmAbi.ts   from src/core/
  persist.ts, checkpoint.ts, recoverSave.ts                       from src/core/
  classifier.ts      extracted from src/render/MapModel.ts
  ui/                TextHud, commandMenu, keys, moveKeys, keyBindings,
                     pointerActions      from src/ui/hud/
                     VectorView          from src/ui/three/
                     DebugView           from src/ui/debug/
  bot/               from src/bot/
src/modules/angband/ from src/angband/ (native/ moves with it);
                     conformance edits, nothing else
src/render/          shared; MapModel.ts deleted, imports retargeted to the Backplane
src/ui/              shared only: Radar.ts, gpuSupport.ts
src/skins/           unchanged
src/main.ts          App composition root (unchanged role)
```

Migration inventory — destination and what changes beyond the move:

| File | Destination | Beyond the move |
|---|---|---|
| `src/protocol.ts` | `src/modules/nethack/protocol.ts` | worker→main union extends Backplane `LifecycleToMain` |
| `src/core/session.ts` | `src/modules/nethack/session.ts` | reimplemented on `EngineSession`; gains the fallback table; `WindowPortHandler` stays the Module's view interface |
| `src/core/worker.ts` | `src/modules/nethack/worker.ts` | none (already posts notice/fatal in the Backplane shape) |
| `src/core/persist.ts` | `src/modules/nethack/persist.ts` | mountpoint/lock read from `backplane/volumes.ts` — renamed per decision #1, old `/persist` saves orphaned |
| `src/core/checkpoint.ts`, `recoverSave.ts`, `engineBoot.ts`, `evalShim.ts`, `wasmAbi.ts` | `src/modules/nethack/` | none — Module-private, see below |
| `src/render/MapModel.ts` | split | grid mechanics → `backplane/cell.ts` `CellGrid`; `categorize`/`terrainKind`/`MG`/offsets/pet/zap ranges → `src/modules/nethack/classifier.ts` emitting Backplane `Cell`s (hero/pet/beam hints replace flag words) |
| `src/render/colors.ts` | stays (shared) | documented as the Backplane's 16-slot color vocabulary |
| `src/render/TerrainBuilder.ts` | stays | branches on `Category` instead of `TerrainKind` (1:1 rename); reads dims from the grid |
| `src/render/EntityLayer.ts`, `pick.ts` | stay | `MG.HERO`/`isPet` → `cell.hero`/`cell.pet`; `cell.zap` → `cell.beam`; category names `monster/object` → `being/item` |
| `src/render/DungeonRenderer.ts` | stays | takes a `CellGrid` (or dims) in its constructor instead of `new MapModel()`; capacities derived |
| `src/ui/hud/Radar.ts` | stays (shared) | consumes `CellGrid` + hints; drops `MG`/`isPet` imports |
| `src/ui/hud/TextHud.ts`, `commandMenu.ts`, `keys.ts`, `moveKeys.ts`, `keyBindings.ts`, `pointerActions.ts` | `src/modules/nethack/ui/` | `pointerActions` branches on Category; `heroActions` takes the `under: Cell` |
| `src/ui/three/VectorView.ts` | `src/modules/nethack/ui/VectorView.ts` | owns the pipeline `print_glyph → classifier → grid.set`; constructs the 80×21 `CellGrid` |
| `src/ui/debug/DebugView.ts` | `src/modules/nethack/ui/DebugView.ts` | none |
| `src/ui/gpuSupport.ts` | stays (shared) | none |
| `src/bot/*` | `src/modules/nethack/bot/` | `BotModel` consumes the classifier instead of `MapModel` |
| `src/angband/*` | `src/modules/angband/` | conformance edits (next section); `native/` moves with it |
| `src/main.ts` | stays | import paths; still the `?game` branch — no Module registry abstraction at N=2 |
| `scripts/test/*`, `scripts/dev/*` | stay | import paths only, except classifier/grid tests split to match |

`AGENTS.md`'s project map and the page-side `dumpMap` helper follow the
moves (`__nhView.renderer.map` keeps its name; `CellGrid.cells` is public
so the helper keeps working honestly instead of through a private).

## What the NetHack Module keeps private

Conservative by design — nothing generalizes until Angband demonstrates the
same need (phase 3):

- **checkpoint.ts / recoverSave.ts** — welded to NetHack's
  `save_currentstate()`, Asyncify-nested windowport answering, and on-disk
  save layout (per the platform spec, explicitly Module code). The
  `RECOVER_QUERY` interception in worker.ts likewise.
- **persist.ts's layering** — the symlink farm, bones-by-copy
  reconciliation, score files. Only the registry constant is Backplane.
- **TextHud and the whole windowport UI** — menus, prompts, status
  formats, message history are windowport-shaped. Angband draws its own
  status into its term grid; a shared HUD shell is a phase-3 derivation if
  the two views turn out to want one.
- **The bot**, pointer actions, command menu, key/movement tables — all
  speak NetHack key codes.
- **`WindowPortHandler`** stays NetHack's view interface. There is no
  shared "GameView" interface in phase 2: the two view contracts (windowport
  events vs tty events) share only `onNotice`, and one method is not a
  Backplane contract.

## Angband conformance

The spec tension, reconciled: the spike carried the **structural** Module
shape; the **semantic** Backplane (Categories) is derived here from both
consumers — but *derived* means the vocabulary is audited against Angband's
data (the table above), not that Angband must emit Cells before its
Classifier exists. Angband conforms structurally in phase 2 and semantically
in phase 3. Concretely, phase 2 changes in the Angband Module (today's
`src/angband/`, moving to `src/modules/angband/`):

- `session.ts` reimplemented on `EngineSession` — picks up the fatal notice
  and dispatch guard (closing the second sites of 1g5/c1w). `AngbandHandler`
  gains `onNotice`; TtyView renders it as a message line.
- `worker.ts`: `quit()` posts a distinct quit message (Module vocabulary)
  instead of masquerading as `fatal`.
- `protocol.ts`: `ANGBAND_VOLUME` moves to `backplane/volumes.ts`; the comment
  claiming rgb is folded worker-side is corrected (it is folded in
  `main-wasm.c`'s `rgb_from_attr`). `attr` stays in the protocol — unused
  today, but it is the input the phase-3 Classifier folds to the Backplane's
  16-slot index; `rgb` stays for the tty view.
- `grid.ts`: `GridCell` renamed `TtyCell` (clearing the name for the Backplane's
  `Cell`, per vect-hack-avm). The grid itself stays Module-internal —
  deliberately not a Backplane type; DebugView's ad-hoc grid is not unified with
  it (two tty scratch surfaces do not make a Backplane).
- `keys.ts`: `Object.hasOwn` guard on the `SPECIAL` lookup (vect-hack-avm).
- `TtyView.nextKey` reimplemented on `backplane/KeyQueue`.

Out of scope, restated from the epic: Angband's Classifier, 3D view, and
saves are phase 3.

## Testing

Hard requirement (Eric): the extraction is guarded by NetHack tests that
catch major regressions in the NetHack interface. Rules, in order of
authority:

- `npm test` green at **every commit** — typecheck, the vitest suites, the
  five NetHack node engine tests, `test:angband-boot`.
- The five NetHack engine tests (`test:wasm-boot`, `test:persist`,
  `test:save-restore`, `test:tabs`, `test:autosave`) are the
  **merge-blocking regression net for the epic**: they run the real engine
  through the real worker/session/persist code and are the proof the
  reshaping changed no behavior. Eric also manually playtests before any
  merge (vect-hack-3vk.4), but automated coverage has to catch major
  interface breakage first — a playtest is confirmation, never the net.
- `npm run preview` is the no-GPU check that the Category rename produced
  identical geometry; `check:browser`/`check:controls` run at wave
  boundaries and before merge (GPU + dev server; not in `npm test`).

### Coverage map — Backplane-touched area → what fails if the refactor breaks it

| Backplane-touched interface area | Pinned by |
|---|---|
| Engine boot, shim decode, wasm ABI (worker.ts, wasmAbi, evalShim) | `test:wasm-boot`; `wasm-abi.test.ts`; `eval-shim.test.ts` |
| Menu round trips (select/message/yn/ext-cmd, overlay ownership) | `menu.test.ts`, `message-menu.test.ts`, `yn-chips.test.ts`, `action-menu-cancel.test.ts`, `stand-on-menu.test.ts`, `overlay-ownership.test.ts`, `command-menu*.test.ts` |
| Glyph flow → classification → grid → geometry | `dungeon-model.test.ts`, `atmosphere-wiring.test.ts`, `wall-fill.test.ts`, `pick.test.ts`, scene preview |
| Radar over the grid | `radar.test.ts`, radar preview |
| Key handling (chords, remap, movement resolution, non-ASCII, alt/meta) | `keys.test.ts`, `move-keys.test.ts`, `remap.test.ts`, `key-bindings.test.ts`, `alt-meta-key.test.ts`, `non-ascii-key.test.ts`, `first-person.test.ts` |
| Persistence lifecycle (volume, locks, checkpoint mirror, recovery) | `test:persist`, `test:tabs`, `test:autosave`, `persist.test.ts`, `recover-save.test.ts` |
| Full command loop through a view (save → reload → restore) | `test:save-restore`, `debug-view-flush.test.ts` |
| The bot as a Backplane-shaped consumer (decoder of every input event) | `bot-model/policy/player/prompts.test.ts` |
| Backends, bloom, camera settle; first-person composition | `check:browser`, `check:controls` (manual GPU gates) |

### Gaps — unpinned behavior this design moves

The rule, calibrated by Eric: coverage has to prove **major** functionality
is unaffected, not be comprehensive. Where a *major* path moves (or is
redesigned) while unpinned, a characterization test is written **before**
the move, as an explicit early plan step — one honest test per major path,
no exhaustive fixtures. Checked against the migration inventory:

- **vect-hack-1vf** — `getlin`/`lineInput` (TextHud getLine/finishLine):
  zero coverage on an engine-blocking input path, and this design's
  `fallback` table redesigns exactly that reply path (a cancelled getlin
  becomes the fallback's `null`). **Qualifies** — pin submit and cancel
  before TextHud moves; the fallback guard then adds the second layer
  (even a broken getLine can no longer strand the engine).
- **Status-line assembly** (found in this audit) — `STATUS_FMT` /
  `decodeMixed` / condition bits have no assertion; no node engine test
  routes through TextHud. Major visible surface, moves with TextHud →
  **qualifies**: one representative status-frame test.
- **vect-hack-c2g** — checkpoint.ts's time gate is never exercised (tests
  pass `minIntervalMs: 0`). Checked: the reshaping moves the file but not
  its wiring — worker.ts's `createCheckpointer` call moves verbatim, no
  Backplane code touches it. A real production gap, but not one this refactor
  can widen: its bead stands on its own, **not** a phase-2 gate.
- **vect-hack-ca5** — modifier-only keydown dismissing overlays: an edge
  path, does not qualify for a blocking characterization test. It moves
  untouched; the bug and its test remain on the bead, outside this epic.

### Tests that move or are new

Moved with their code: `dungeon-model.test.ts`'s classification assertions
become `nethack-classifier.test.ts` — same glyph fixtures, now asserting
emitted `Cell`s, pinning that the split changed no classification.
Grid-mechanics assertions (hero stash, revision, cursor) move to the Backplane
suite.

**New Backplane-level unit tests (small, mechanism-focused):**

- `backplane-cell.test.ts` — `CellGrid` set/clear/under/revision with
  hand-built Cells, no game imports; `isHostile`/`isOpen` truth tables.
- `backplane-session.test.ts` — a mock worker: `fatal` reaches `onNotice`
  (1g5); a throwing `dispatch` still posts `fallback`'s reply and notices
  (c1w). Both Module delegates' fallback tables get their own case each.
- `key-queue.test.ts` — buffer/waiter ordering, wait=false immediacy.
- A compile-time check is enough for `volumes.ts` (distinct mountpoints
  can be a one-line assertion in the session tests).

Not worth writing: renderer-vs-Category golden tests beyond the existing
preview images, and any Angband Cell tests (no Cells until phase 3).

## Risks

- **Backplane over-fitting** — the standing risk, mitigated by policy above:
  Kind optional and renderer-ignored, `ready` payloads unshared, volume
  machinery unextracted, view interfaces unshared, tty grids unshared. The
  rule applied throughout: a mechanism is extracted only when the second
  consumer exists in code, not in prospect.
- **Big-refactor breakage.** ~60 files import across the moving boundary.
  The design is sequence-friendly and the plan should exploit it in three
  waves, each independently green: (1) `src/backplane/` lands beside the
  existing code and NetHack consumers flip in place, with `MapModel.ts`
  temporarily a re-export shim so tests flip gradually; (2) Angband
  conformance; (3) directory moves last — pure `git mv` plus mechanical
  import rewrites, no semantic edits allowed in that wave. Semantic changes
  and moves never share a commit.
- **Behavioral deltas hiding in a "pure" refactor.** Two are intended and
  should be called out in the plan: fatal/quit becomes player-visible
  (1g5), and a throwing handler now cancels instead of wedging (c1w). One
  is forbidden: any change to what NetHack classifies (pinned by the
  classifier tests). Watch `EntityLayer`'s skip-list (`none|terrain` →
  `unseen|terrain-group`) — an off-by-one there draws walls as letterforms.
- **Storage continuity: none, by decision.** The volume rename (decision
  #1) orphans existing saves once — known and accepted, no migration or
  compat code exists to go wrong. The persistence suites prove the new
  names round-trip; the old `/persist` database is simply dead weight in
  IndexedDB.
- **HMR / live games.** Every wave touches `src/`, so each refactor session
  torches any live game (AGENTS.md rule). Playtest verification belongs
  between waves, never during; the autosave suite is the safety net for the
  reload path the churn will constantly exercise.
- **Angband's Classifier will need more than the tty stream** (noted now,
  bites in phase 3): Angband's term grid carries no semantic ids — `#` is
  wall or vein by attr only, and known traps arrive as bare glyphs. The
  Classifier will likely tap `map_info`/grid data from the C front end
  rather than parse tty output. The Backplane already accommodates this (a
  Module produces Cells however it likes), but it means phase 3 touches
  `main-wasm.c`, not just TypeScript — worth remembering before assuming
  phase 3 is JS-only.
- **Epic merge gates are downstream but constrain the Backplane now.** Eric's
  gates for the epic branch (vect-hack-3vk.4: the Angband borg playing in
  3D crash-free, plus his manual playtest) are phase-3+ deliverables, and
  phase 2 must not make the borg path harder. The borg is engine-internal
  C (`ALLOW_BORG`, an Engine Build concern — currently compiled empty):
  it drives the game from inside the engine, emitting the
  same term stream and simply pulling fewer keys. Checked against this
  design: the Backplane holds no assumption a borg would violate — input is
  pull-model (`KeyQueue.next` may just never be asked), the grid is
  event-driven with no display-follows-player-key assumption, and nothing
  in the Backplane knows who is playing. The borg stays invisible to the Backplane.
- **Camera/`__nhView` external contracts.** `browser-check.mjs` drives
  `DungeonRenderer`'s diagnostics accessors and the AGENTS.md page helpers
  read `renderer.map` — both survive by keeping those names stable through
  the moves; the plan should treat them as frozen API.
