# Look HUD — point at anything and the engine names it

Date: 2026-08-18. Bead: `vect-hack-kew` (epic; tasks filed with the plan).

## Why

The biggest playability gap: in the 3D view you cannot tell what a glyph is.
Every engine has a look command (`;` in NetHack, `l` in Angband, `l` in
Moria; Larn has none), but each is a keystroke ritual with a cursor. Since the
UI is being reinvented anyway, identifying what is around you should be
instant and discoverable in every Module, without learning a key.

This spec covers the first of three pieces: **point-and-look**. Inventory
visibility and discoverable actions are a follow-on spec that builds on the
seam defined here.

## What ships

1. **Hover names things.** Move the pointer over any cell in the vector view
   (orbital or first person) and a label beside the pointer shows the
   engine's own description — `Jackal (unhurt, asleep)`, `Orange potion`,
   `Wall`, `Unexplored area`. A wireframe ring marks the cell being pointed
   at. Tap or click does the same for touch and pen.
2. **One shared seam, four Modules.** A Backplane request
   `describe(x, y) → string | null` answered by each Module's worker from a
   read-only native query that uses the engine's own naming code. NetHack,
   Angband, Larn and Moria all answer it.
3. **Nothing else changes.** No key injection, no idle gating, no change to
   the map batch ABIs, `Cell`, classifiers, or key handling. Each engine's
   own look command keeps working.

Not in this spec: a pinned/expanded card, keyboard look-mode, menu
integration, inventory or action panels.

## Design

### 1. Why a pure native query (the choice among four)

Four shapes were weighed:

- **A — names in the map batch.** Every exporter attaches a name to each
  cell. Fails on cost and contract: Angband's packed word batch and Moria's
  sanitized seven-word record carry no strings, so both ABIs would grow a
  string table; NetHack would run one description per changed glyph on the
  shim's synchronous path for cells nobody hovers; and a look answer carries
  state (`peaceful`, `asleep`, `called Hachi`) that does not belong in the
  Backplane `Cell`.
- **B — drive the engine's own look command silently.** Fails on safety:
  NetHack's `getpos` (farlook, travel, `#jump`, polearm targeting) and
  `getdir` both read through `nh_poskey`; only `program_state.input_state`
  tells them apart and JS cannot see it, so a hover during "Where do you want
  to hit?" would pick that square. It is not uniform either: Larn has no look
  command, and Moria's/Angband's are full-screen prompts.
- **C — hybrid** (B for NetHack, native for the rest). Inherits B's hazard
  for the Module that matters most, and gives one Module a different latency
  and availability from the other three.
- **D — uniform pure native query** (chosen). Every Module answers the same
  request from a side-effect-free native function. NetHack's
  `do_screen_description` (pager.c) is exactly that: its body makes no
  windowport call — the `curs`/`flush_screen`/`pline` live in its caller
  `auto_describe`. (One escape hatch: `look_at_monster` can reach
  `impossible()` on a defensive branch, so the worker makes the call under the
  checkpointer's non-unwinding bridge swap. See the amended read-only bullet
  below for what the call does cost.) A spike (2026-08-18) exported it, called it from a later
  macrotask while the engine sat at its command prompt, read the answer, and
  resumed the engine normally. Angband, Larn and Moria get a ~30-line function
  in the exporters this repo already owns.

D never touches keys or input state, so it cannot misfire; it works during
menus, prompts and level changes; the map ABIs stay as they are; and because
the query is cheap and pure, a later push consumer (nearby list, labels, the
bot) can loop it over the few being/item cells per turn — A becomes a layer
over D, not a rival.

### 2. The shared seam — `src/backplane/describe.ts`

Modelled on `saveExport.ts` (a page→worker round trip with a reply table).

- `DescribeRequest = { type: "describe"; id: number; x: number; y: number }`
- `DescribeReply = { type: "describeReply"; id: number; text: string | null }`
- **Main-thread half** `Describes`: an in-flight table keyed by id, a timeout,
  and stale-reply dropping. Mounted on `EngineSession` as
  `describe(x, y): Promise<string | null>`. Hover fires often, so a newer
  request supersedes older ones — the caller only ever sees the answer to the
  latest position; superseded promises resolve `null`.
- **Worker half** `answerDescribeRequest(msg, describer)`: calls the Module's
  `describer(x, y)` and always posts a reply. A throw becomes `text: null`;
  the handler never throws (a message handler that throws loses the request
  and leaves the page waiting).
- Every Module worker adds one case: `"describe"` → `answerDescribeRequest`.

Coordinates are the Module's own grid coordinates, the ones its map records
already carry. The Backplane imports nothing from modules, render, or ui, as
before.

### 3. The four native seams

Common contract for every `describer`:

- **Read-only.** It must not print, prompt or sleep. It reads only what the
  engine already displays or knows.

  Amended 2026-08-18, after review: this bullet originally also said "or
  advance the game RNG", and NetHack's answer cannot honour that. The
  `didlook:` tail of `do_screen_description` (pager.c:1590) calls `lookat()`,
  which through `object_from_map` may `mksobj()` a temporary object for a
  remembered glyph that is no longer there, and `mksobj` reaches
  `next_ident()` — `svc.context.ident += rnd(2)`, the *game* RNG, and saved
  state (mkobj.c:521). It also sets `t->tseen` on a trap it names.
  This is accepted, not worked around, because it is exactly what NetHack's
  own cursor already does: `auto_describe()` (getpos.c:640) calls the same
  function once per cell as a farlook, travel or targeting cursor is walked
  across the map, with `iflags.autodescribe` on by default. Our hover fires at
  the same rate — once per cell entered — so pointing costs the engine no more
  than upstream's own cursor does, and the alternative is patching
  `external/NetHack`, which this project does not do. The other three Modules'
  describers, which this repo owns, do honour the original bullet.
- **Legal whenever worker JS runs.** Worker JS runs only while the engine is
  Asyncify-suspended in an input request; a pure export is a legal nested
  call then (the same rule the NetHack checkpoint relies on). The one
  forbidden window — inside a bridge callback after its first `await` — never
  applies to a message handler.
- **`null` when there is nothing honest to say:** before the first map is
  drawn, after the engine exits, out of range, and on a hallucinated grid in
  Angband/Moria (their own look would print random text and, in Angband,
  spend game RNG doing it).
- **A short phrase, not a sentence:** what the engine's own look would put in
  its concise line. The HUD capitalizes the first letter and never rewrites.
- **The hero's own cell** answers too: NetHack's `firstmatch` already names
  the hero (`dwarven valkyrie called player`); Angband, Moria and Larn return
  `you`.

**NetHack.** `scripts/build/build-nethack-wasm.sh` adds
`_do_screen_description` and `_free` to its `-sEXPORTED_FUNCTIONS` (the
guard checks upstream's list; ours is a superset — no source patch). The
worker's describer allocates a 4-byte `coord` (two `int16`: clang's wasm32
ABI passes the by-value struct as a pointer to a temp), a 256-byte `out_str`
and a `firstmatch` pointer; calls `_do_screen_description(cc, 1, 0, out,
fm, 0)`; returns `firstmatch` — the phrase autodescribe itself shows
(`dwarven valkyrie called player`, `wall`, `unexplored area`). `out_str` is
the long form with a `\G…` mixed-glyph escape and the class phrase; not
shown in v1. Identification is honoured because the path goes through
`lookat`/`xname`; hallucination uses NetHack's display RNG by upstream
design, so it needs no gate. The describer answers `null` before the first
`print_glyph` and after `exit_nhwindows`. Marshalling lives in `wasmAbi.ts`
next to the other pointer helpers, so it is unit-testable without an engine.

**Angband.** `EMSCRIPTEN_KEEPALIVE const char *vect_angband_describe(int x,
int y)` in `src/modules/angband/native/main-wasm.c`, next to `pack_grid`.
Calls `map_info()` and answers in priority order: `g.m_idx` →
`monster_desc(…, MDESC_IND_VIS)` plus `look_mon_desc()` (the two calls the
`l` command composes); `g.first_kind` → the first known object from
`square_object(player->cave, grid)` through `object_desc(…, ODESC_PREFIX |
ODESC_FULL, player)`, or the pile wording when `g.multiple_objects`;
`g.unseen_object` → `unknown object`; else `square_apparent_name(cave,
grid)`. Returns a static buffer; the worker reads it with
`ccall(…, "string", …)`.

Amended 2026-08-18, after review, on three points this section got wrong:

- **Hallucination is gated before `map_info`, not on `g.hallucinate` after
  it.** `map_info`'s own tail (cave-map.c:179-188) is the RNG spender —
  `one_in_(128)` twice — and in ~126 of 128 empty grids it then sets
  `g->hallucinate = false`. Gating on the flag afterwards would therefore
  both read out the true terrain while hallucinating and spend game RNG
  doing it. The describer tests `player->timed[TMD_IMAGE]` and returns
  `NULL` before calling `map_info` at all, which is where upstream's own
  `aux_hallucinate` (ui-target.c:472) gates too. The hero's own cell is the
  one exception, and sits above that gate (final review, M1): a player knows
  where they are standing however addled they are, so `x == player->grid.x &&
  y == player->grid.y` answers `you` first — the order Larn and Moria already
  use, and the one Moria's harness asserts.
- **A monster is named only if `monster_is_obvious`.** `map_info` clears
  `g->m_idx` for `!monster_is_visible`, which still leaves camouflaged
  mimics — creeping coins, lurkers — whose glyph the map deliberately draws
  as an object. `aux_monster` requires `monster_is_obvious` (ui-target.c:526)
  for exactly that reason; naming one would tell the player something the
  map, the monster list and the `l` command all conceal.
- **Traps are named**, between the monster and the object branch, from
  `g.trap->kind->desc` — upstream's own order (ui-target.c's `aux_trap`), and
  what Larn and Moria already do below. The original ordering here simply
  omitted them. `desc` and not `name`: `name` is the code name parsed from
  trap.txt's first field ("pit", "strange rune"), which only the wizard
  branch prints; `aux_trap` shows the player `->desc` ("spiked pit", "rune of
  summoning"), and that is what "the engine's own concise line" means here.

The object branch also applies `map_info`'s own skips (`unknown_gold_kind`,
`unknown_item_kind`, `ignore_known_item_ok`) when it picks the pile head and
counts it, so the phrase names the glyph the map actually drew.

**Moria.** `extern "C" EMSCRIPTEN_KEEPALIVE const char *moria_describe(int
x, int y)` in `src/modules/moria/native/semantic-wasm.cpp`, added to
`moria-wasm.mk`'s `EXPORTED_FUNCTIONS`. Mirrors upstream's static
`lookSee()`: a lit, visible monster → `creatures_list[id].name`; a known
treasure → `itemDescription(buf, item, true)` — Moria's doors, stairs, rubble
and store entrances are treasure objects, so this one call names those
features too; else wall/floor from `tile.feature_id`. `py.flags.image` →
`NULL`.

**Larn.** Amended 2026-08-18, after review: this section originally specified
no perception gate, and the describer it produced was a blindness-defeating
radar. The Larn map tap deliberately refuses to publish live state while
`c[BLINDCOUNT]` is set — it replays a shadow of the last public batch instead
(`main-wasm.c`'s own comment: "querying them to move the semantic hero would
reveal state showcell deliberately suppressed") — but the describer read
`item[]`, `mitem[]` and `know[]` straight. Reproduced against the real engine:
with the hero blind, the map draws a vacated cell as bare floor while
`vect_larn_describe` answered `gold`. So the describer returns `NULL` while
`c[BLINDCOUNT]` is set, after the hero's own cell branch — the blind delta does
publish the hero, and the player knows where they are standing. Angband gates
`TMD_IMAGE` and Moria gates `py.flags.image` for the same reason; Larn was the
one Module left reading raw engine state.

`EMSCRIPTEN_KEEPALIVE const char *vect_larn_describe(int x, int
y)` in `src/modules/larn/native/main-wasm.c`. Larn has no look command, so
this follows Larn's own step-on wording: an `mitem[x][y]` the map draw
itself would show (the same known/invisible test as Larn's cell drawing) →
`monster[id].name`; `item[x][y]` under `know[x][y]` → `objectname[item]`,
except potions/scrolls read `potionname[iarg]`/`scrollname[iarg]` and fall
back to Larn's `magic potion`/`magic scroll` while those are blank; gold →
`gold`; fixtures (altar, throne, fountain, stairs, traps) from the same
table the classifier's `kind` already uses.

Amended again 2026-08-18, after the final review: a hidden trap answers
`floor`, not `NULL`. Larn's four concealed trap variants are drawn blank and
published byte-for-byte as a bare floor record, so a `NULL` answer made the
label say what the map refuses to — hover along a corridor, every cell reads
`Floor`, and the one that goes silent is the trap. `NULL` is reserved for "I
cannot see this at all"; a concealed thing is answered with its disguise, which
is what the siblings already do (Moria names a secret door `a granite wall`;
Angband lets an unseen trap fall through to `square_apparent_name`). One test
covers all five blank cells: `objnamelist[it] == ' '` is empty floor and the
four variants and nothing else (`external/larn/data.c:179`).

Every native function is a table lookup and a string format; none allocates
per call.

### 4. The shared HUD — `src/ui/hud/Look.ts`

`LookHud` is game-free and built by every `VectorView` next to `Radar`, given
the canvas and the renderer. `main.ts` connects it in one line per Module,
the same shape as the save-menu wiring:
`view.look.describe = (x, y) => session.describe(x, y)`. No Module view
learns anything about descriptions.

- **Pointer move** → `renderer.pickCell()` (already shared; works in both
  cameras). Same cell as before → nothing. New cell → highlight at once
  (local), then `describe` after a ~50 ms debounce. The answer becomes the
  label; `null` hides it. Replies for a superseded cell are dropped.
- **Highlight** is a wireframe ring on the cell, drawn by the renderer via a
  new `setHighlight(cell | null)` in `src/render/` — colour from a skin
  token, additive like everything else. It shows *which* glyph is under the
  pointer before the text arrives. `DungeonRenderer` exposes the highlighted
  cell through a diagnostics accessor for the browser gate.
- **Label** is a DOM element beside the pointer, styled from skin tokens
  (vector font, phosphor colour, glow). Text is the engine's phrase with the
  first letter capitalized.
- **Tap / click** shows the same label for the picked cell for a few seconds
  — the touch and pen path. It does not `preventDefault` or stop propagation,
  so NetHack's click verbs and right-click menu keep working; the label names
  what you are about to act on.
- **Leaving the canvas**, a fatal notice, or a failed `describe` clears ring
  and label.
- **Discoverability:** the first time the pointer enters the canvas in a
  session the label reads "Point at anything to name it" for a moment — the
  FPS controls' one-shot notice pattern.

### 5. Testing and gates

Unit (vitest, in `npm test`):

- `scripts/test/describe.test.ts` — the request table, mirroring
  `save-export.test.ts`: reply settles; a stale reply is dropped; a superseded
  request resolves `null`; timeout fails cleanly; the worker helper answers
  `null` on a throwing describer and never throws.
- `scripts/test/look-hud.test.ts` — `LookHud` with a fake `pickCell` and a
  fake describer: same cell → no second request; a newer cell wins over a
  slower older reply; `null` hides; leave clears; click shows; the one-shot
  hint fires once. jsdom, as `command-menu-ui.test.ts` does.
- `scripts/test/nethack-describe-abi.test.ts` — the `coord`/`out_str`/
  `firstmatch` marshalling against a fake `mod`, pinning the 4-byte `int16`
  layout the spike proved.
- `scene-preview.test.ts` gains a highlighted cell in the fixture so the ring
  shows in `.preview/*-scene.png` without a GPU.

Engine tests (already in `npm test`, one assertion each):

- NetHack `test-nethack-save-restore.mjs`: at the first command prompt, call
  the describer on the hero cell from a later macrotask; require a non-empty
  phrase and that the engine asks for the next key.
- Angband borg test, Larn gym, Moria play test: describe the hero cell and
  one visible monster/item cell from the batch the classifier already sees;
  require non-`null` for the hero, `null` out of range, no fatal afterwards.

Browser gate (`npm run check:browser`): on each Module/backend, move the
pointer over the hero, wait, and require the label to contain text and the
renderer's highlight accessor to report that cell — accessors, never a
private (vect-hack-azf).

Build guards: `build-nethack-wasm.sh` greps the artifact for
`_do_screen_description` (as it does for `_save_currentstate`); the Angband,
Larn and Moria builds grep for their `describe` symbol.

### 6. Work breakdown

One epic; one task per section: the Backplane seam; each of the four native
seams (independent, parallelizable); the HUD plus renderer ring; the gates.
The plan orders the Backplane seam and the HUD first against a fake describer,
then the four seams, then the gates.

## Follow-on

The next spec (inventory + actions) builds on this seam: a "detail" line from
NetHack's `out_str` long form and Angband's monster recall; a pinned card with
the actions that apply to the pointed cell; a shared command palette; and an
inventory rail. A "nearby" list, if wanted, is `describe` looped over the
being/item cells of the current grid once per turn.
