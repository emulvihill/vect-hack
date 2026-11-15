# Dev URL flags, camera and keys, and the pointer HUDs

Demoted from `AGENTS.md` (vect-hack-2dr). AGENTS.md keeps the flag list and
the invariants; this file keeps what each flag builds and why.

- **Function keys are view chrome — they never reach a native core.**
- **`?game=<module>` is never implicit.** A URL without it redirects to
  `?game=nethack`, keeping every other flag; no code may depend on a default.
- **A URL without `?touch` builds none of the touch scheme.**
- The Look HUD **sends the engine nothing**, so each engine's own look
  command is untouched.
- An ambiguous hit **deliberately draws nothing** rather than a guessed pulse.

## The flags

Dev URL flags: `?trace` logs every windowport call; `?view=debug` swaps the 3D
view for the tty-style one; `?gl` forces the WebGL backend; `?skin=name`
(`quadrascan` | `ghost` | `high-contrast`) picks the active skin and persists
to localStorage — `VECT_SKIN=name` selects it for `npm test` / `npm run
preview` instead; `?bot` runs the self-playing bot at one second per turn (`?bot=fast` unthrottles it, `?bot=<ms>` picks the pace; `src/modules/nethack/bot/`, wired only in `main.ts`).
`?return=<url>` (every Module) shows a **Quit to main page** row in the Saves
panel linking to that URL, same-origin only; without it there is no row
(`docs/SAVES.md`).
`?touch` (NetHack only, vect-hack-21k) adds the touch scheme: a nine-key thumb
pad over the shared gaze layer, a seven-slot action bar, and a first-person
toggle — the shared layer is `src/ui/touch/` and the adapter is
`src/modules/nethack/ui/touchAdapter.ts`. A URL without the flag builds none of
it, and `npm run check:touch` drives it in real Chromium at 390x844 and fails
if the page ever receives a keyboard event.
`?game=<module>` names the Module (`nethack` | `angband` | `larn` | `moria`), each with its own
worker and view; a URL without it redirects to `?game=nethack`, keeping every
other flag — no code may depend on an implicit default game. For Angband, add
`?borg` to hand it to Angband's own built-in borg, which births a
character and then plays unattended (`src/modules/angband/ui/BorgPlayer.ts`) —
`?borg=<ms>` paces it like `?bot=<ms>`, via the engine's own
borg_delay_factor in the volume's borg.txt (`src/modules/angband/borgConfig.ts`);
the borg never pauses inside a menu, so the front end holds each inventory
and store menu frame on screen for that same pace before the borg's next key
(`native/main-wasm.c`).
When the borg dies or retires, the native tombstone menu hands input back to
the player for inspection and quitting. The borg stops pressing keys throughout
those screens. Angband writes the dead character's save after the player leaves
the death menu; merely reaching the tombstone does not flush that save.

## Camera and keys

The shared non-touch menu/text overlay is centered horizontally and vertically
in the viewport. Its width and height caps keep long terminal screens scrollable
inside the panel. The `?touch` layout retains its explicit top anchor and smaller
height cap, leaving the action bar exposed.

In-game, **F2** toggles the first-person camera (function
keys are view chrome — they never reach a native core). Direction keys are
screen-relative in the vector views (in first person, left/right arrows turn instead of move), keypad 5 (Clear) resets the bearing to
north-up, and the NumLock-on keypad types NetHack count prefixes. The view
binds no letter: every letter is a live engine command (`w a s d` are NetHack's
wield, apply, search and drop), so the gaze keys are the arrows and the
NumLock-off pad, and the vi-keys stay absolute rather than rotating. Moria's
original mode sends keypad digits; a shifted camera movement is the source's
two-read run command (`.` then a literal direction).

A direction key becomes screen-relative movement only when it answers the
engine's outer command read; a nested prompt (direction, menu, store, count)
always gets the literal key. Each Module learns which read it is from its own
engine: Angband's front end sends `cmd = character_generated && inkey_flag &&
screen_save_depth == 0` with every key request and only a parked request with
`cmd` set is remapped; Moria's marks its reads `outer-command`; Larn's seam is
the `__wrap_yylex` flag. NetHack's windowport cannot see the difference, so
`TextHud` infers it from its `prompting` counter.

## The hit flash

A being that takes a hit flashes red for a moment in **NetHack, Angband and
Moria**. No engine reports the victim's position, so each of those three infers
the cell from its own engine messages — a per-Module `hitInference.ts`, because
the message grammars have nothing in common — and an ambiguous case
deliberately draws nothing rather than a guessed pulse.

**Larn has no `hitInference.ts` and never flashes.** Three Modules flash and
one does not; `src/modules/larn/ui/VectorView.ts` never calls `hitFlash()`.
Adding one means reading Larn's own combat messages first, the way the other
three were read.

## The Look HUD

Pointing at any cell in a vector view names it: a wireframe ring marks the
cell and a label beside the pointer shows the engine's own description
(`src/ui/hud/Look.ts`), answered by the Backplane's `describe(x, y)` round
trip (`src/backplane/describe.ts`) from a read-only native query per Module —
NetHack's own `do_screen_description`, and a `describe` function in each of
the Angband/Larn/Moria exporters. Tap or click does the same on touch. It
sends the engine nothing, so each engine's own look command is untouched.

A query, not a silent look keystroke, because the keystroke cannot be made
safe: NetHack's farlook, travel and targeting cursors and its direction prompt
all read through `nh_poskey`, and only `program_state.input_state`, which JS
cannot see, tells them apart — a hover during "Where do you want to hit?"
would pick that square.

**The label never says what the map refuses to draw.** Every describer answers
the hero's own cell first, above every gate (a player knows where they are
standing), then returns null while the hero cannot honestly see — Angband under
`TMD_IMAGE`, Moria hallucinating or blind, Larn blind, whose map replays a
shadow then — and names a concealed thing by its disguise rather than null:
Larn's hidden traps answer `floor`, Moria's secret door `a granite wall`, and
Angband names a monster only when `monster_is_obvious`, so a mimic reads as the
object it is drawn as. Null means "cannot see this at all"; a null among
neighbours that read `Floor` is a trap detector. NetHack's pager handles
hallucination and blindness itself, so its describer has no gate of its own.

The orbital camera zooms on the wheel and on a **two-finger pinch**
(`src/render/OrbitCam.ts`, vect-hack-lxd). Two fingers are a pinch and the orbit
drag stands down for the whole gesture, so a pinch that started as a drag never
leaves the bearing mid-swing; when one of the two lifts, the survivor takes the
drag over from where it *is*, and `pointercancel` is the same path. A mouse only
ever produces one pointer, so none of it can reach a desktop. **First person has
no pinch and no wheel** — it has no radius to zoom, and the only zoom it could
offer is the field of view, which is a distortion rather than a framing; what it
does do is ignore a second pointer, so a stray pinch cannot smear the look.

The **opening framing is a width of MAP, not a distance**:
`radius = 14 * max(1, 1.6 / aspect)`. Below a 1.6:1 stage the camera pulls back
until the same ~21 map columns still fit; at and above it the radius is pinned
at the historical 14, so every desktop opens exactly where it always did — a
1280x800 window leaves a ~1.9:1 stage, comfortably on the pinned side. That is
why a change to a shared render file was safe for `check:browser`: the desktop
is untouched *by construction*, not by luck. At 390x844 the view went from 7 map
columns across its middle to 21.

The rule reads the viewport and **not** the `CellGrid`, on purpose. Every
Module's map is wider than the framed width (Larn's 67 is the narrowest), so a
grid clamp is code that could not fire; and framing a *fraction* of the map is
the wrong target — Moria's 198 columns across a 390px phone is two pixels a
cell. A player needs a fixed number of cells of context, and every Module gets
the same. The framing stays the viewport's to revise (rotate the phone, drag the
window narrow) until the player zooms: assigning `OrbitCam.radius` is what
records that the choice is now theirs, and a mode swap carries that flag with
the framing (`OrbitFraming`).


## Teardown

**Every view has a `dispose()`, and it removes exactly what its constructor
added** (vect-hack-a8r). `document`, `#cmdbtn`, `#prompt`, `#overlay` and the
canvas all belong to `index.html` and outlive any view, so a listener bound to
one as an anonymous closure can never be un-bound — which is what a restart, an
F2-style view swap or a session replacement used to leave behind, one duplicate
delivery per view ever built. Handlers are named fields for that reason alone.
The bead named one leaking listener; there were twelve.

`dispose()` also cancels the view's `KeyQueue`, hands on to the parts that bind
to nodes they do not own (`LookHud`, `Radar`, and the cameras through
`DungeonRenderer.dispose()` — three that already had a `dispose()` nobody
called), and is idempotent. Each Module's session calls it from its teardown
**after** the worker is gone: a view disposed while the graceful release is
still in flight would answer the engine's last question "no key".

**Nothing calls that teardown in the browser yet** (vect-hack-67py). The
contract is pinned so the leak does not come back the day `pagehide` is wired.

## Effects and the hit flash

Angband's `MON_HIT` is the one type whose inference also reads the message text.
It is a blow-METHOD type, so `mon-blows.c` emits it for a monster hitting
another monster as well (the command-monster mechanic), and nothing typed tells
the two apart. A `MON_HIT` that does not name the player is
known-not-the-hero, not ambiguous, and draws nothing — the same answer as
always, reached from the one place the two messages differ (`act:hits {target}`
expands to the literal "you" for the player). Angband otherwise infers from the
typed `messageType` and NetHack from text alone; this is a deliberate,
single-type crossing of that line, and the reasoning lives in
`hitInference.ts`'s header (vect-hack-xqg).

An effect Cell has a **minimum on-screen lifetime of its own**
(`EFFECT_LIFETIME_S`, `src/render/effects/mapFx.ts`). Nothing in a record stream
retracts an effect Cell — the engine's own repaint clears it — and Angband paces
that repaint with `delay_factor`, an option the player can set to 0 from the
options menu, at which point the set and the repaint arrive in one batch and no
frame ever samples the blast. The fix is **not** a grid-level TTL:
`MapFx.observe()` samples the grid per frame and cannot see a Cell that never
survived one. The Module's view signals the event instead
(`DungeonRenderer.effectFired(x, y, cell)`), and `EntityLayer` draws that
residue for a fixed wall-clock envelope — but only where the engine is currently
showing terrain or nothing, so it fills the hole the erase left and never covers
the blast's own target. The grid stays engine truth and `Cell.terrain` shows
through once the envelope closes. Only Angband signals it today; the other
Modules' engines do not collapse their animations (vect-hack-auo).

The WebGPU phosphor trail's tail length is set by the linear
`persistence_drain_per_s` (0.10/s), not by the 0.30 s half-life
(`src/skins/tokens/quadrascan.json`, `persistence.ts` `drain`). The camera
follows the hero, so a long tail ghosts the whole scene on every move; on a
phone the exponential alone smeared the `?bot` demo for seconds after each
step. Measured there against a 0.10 s half-life, the drain won: it ends the
tail at about 1.4–2.3 s and leaves the first tenths of a second, the part that
reads as phosphor, nearly unchanged. Frame time was not the cause — the phone
ran at 60 fps.
