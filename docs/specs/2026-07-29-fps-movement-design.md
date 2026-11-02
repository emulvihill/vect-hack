# First-person movement: walk where you are looking

Bead: `vect-hack-be3` (first of several — see Out of scope).

## Problem

F2 puts the eye inside the dungeon (`VectorView.ts:27-33`), but movement stayed what
it was in the orbital view: `TextHud`'s `KEYMAP` (`TextHud.ts:69-73`) turns the arrow
keys into `h j k l`, which are absolute compass directions. Standing in a corridor
facing west, pressing Up walks you sideways across the screen. The camera and the
controls disagree about what "forward" means, and the camera is the one the player is
looking at.

Two constraints shape the fix:

- **NetHack movement is eight absolute directions**, one cell per keypress. There is no
  continuous heading to feed it — whatever the camera is doing has to collapse to one
  of eight characters.
- **Every letter is a live command.** `w a s d` are wield, apply, search and drop, and
  `TextHud.onKey` forwards them verbatim. The FPS keys cannot be WASD without
  displacing four commands, and the bead requires classic keys keep working.

## Design

### 1. `src/ui/hud/keys.ts` — one place a key code is written down

Today the codes are literals whose meaning lives in a comment: `104, 106, 107, 108`
for `h j k l` and `121, 98, 117, 110` for `y b u n` (`TextHud.ts:70-72`), plus `113`
and `110` for q/n in `ynFunction` (`TextHud.ts:253`). A rebinding layer cannot be built
on top of that, and the comments are the only thing keeping them correct.

```ts
export const key = (ch: string) => ch.charCodeAt(0);
export const ctrl = (ch: string) => key(ch) & 0x1f;

export const ESC = 27, CR = 13, SPACE = 32, BACKSPACE = 8;

/** NetHack's eight movement commands, clockwise from north (cmd.c). */
export const DIRECTIONS = ["k", "u", "l", "n", "j", "b", "h", "y"] as const;
```

`TextHud` imports these; no call site keeps a numeric literal for a character again.
The existing `ESC`/`CR`/`SPACE`/`BACKSPACE` consts move here rather than being
duplicated.

### 2. Two layers, because rebinding and game semantics are different concerns

**Layer 1 — physical key to named action.** Plain data, the table a rebinding UI will
eventually edit and persist:

```ts
export type Action =
  | "move-fwd" | "move-back" | "move-left" | "move-right"
  | "run-fwd"  | "run-back"
  | "turn-left" | "turn-right";

export const DEFAULT_BINDINGS: Record<string, Action> = {
  "ArrowUp": "move-fwd",        "Shift+ArrowUp": "run-fwd",
  "ArrowDown": "move-back",     "Shift+ArrowDown": "run-back",
  "ArrowLeft": "turn-left",     "ArrowRight": "turn-right",
};
```

Keys are serialized by one exported function, `chord(e: KeyboardEvent): string`, so a
lookup and a future saved config cannot disagree about whether it is `"Shift+ArrowUp"`
or `"shift+ArrowUp"`. Modifier order is fixed: `Ctrl+Alt+Shift+<key>`.

**Layer 2 — action to NetHack code.** A pure resolver holding the compass math. Not
user-editable: rebinding "north" to mean south is not a preference.

```ts
export type Resolved =
  | { kind: "key"; code: number }    // feed this to the engine
  | { kind: "turn"; delta: number }  // swing the camera, feed nothing
  | null;                            // unbound: fall through to KEYMAP
export function resolve(action: Action | undefined, yaw: number): Resolved;
```

A turn has to carry its direction, so the two outcomes are a tagged union rather than a
number and a sentinel. Applying the turn is the caller's job — the resolver stays pure.

`move-left`/`move-right` are in the type but unbound by default — the chosen scheme
turns with Left/Right rather than strafing. They exist so the alternative is a
one-line binding change, not a code change.

### 3. The compass math, and which yaw it reads

`camera.rotation.set(pitch, yaw, 0)` with YXZ order (`FirstPersonCam.ts:92`) puts the
camera's forward at `(-sin yaw, 0, -cos yaw)`. Cells are placed at world `(x, ·, y)`,
so `-z` is decreasing map y — north. Yaw 0 is north, and **positive yaw turns left**
(west), matching `OrbitCam.ts:71-75`.

```ts
const index = Math.round(-yaw / (Math.PI / 4)) & 7;   // clockwise from north
const ch = DIRECTIONS[index];
```

`move-back` uses `index + 4 & 7`. `run-*` uppercases the character, which is already
NetHack's rush-in-that-direction. `turn-left` is `+PI/4` and `turn-right` is `-PI/4` —
sign follows from positive yaw turning left. Nothing is fed to the engine for a turn,
so no game time passes while the player looks around.

**The resolver reads the target yaw, not the eased current yaw.** A player who presses
Right then Up inside the ease window must walk the direction they asked for, not an
intermediate angle that rounds to the old cell.

### 4. `FirstPersonCam` gains an eased turn

`yaw` is currently written straight from pointer drag (`FirstPersonCam.ts:117`). It
gains a `yawTarget` that drag writes alongside `yaw` — so dragging stays 1:1 and
immediate — and a turn method that snaps to the 45° lattice before stepping, so a turn
after a free-look drag lands on the lattice rather than 12° off it:

```ts
turnBy(delta: number): void {
  this.yawTarget = Math.round(this.yawTarget / (Math.PI / 4)) * (Math.PI / 4) + delta;
}
get heading(): number { return this.yawTarget; }   // what the resolver reads
```

`update()` eases `yaw` toward `yawTarget` on a `TURN_TAU` of the same order as
`FOLLOW_TAU`, so a keyboard turn feels like the drag rather than like a cut. `azimuth`
keeps returning the eased `yaw`, so the radar swings with the view.

`turnBy` joins the `DungeonCamera` interface as optional. `OrbitCam` does not implement
it; turning the orbital camera from the keyboard is not part of this work.

`TURN_STEP` — the eighth-turn lattice — is declared in `DungeonCamera.ts`, not in the
key mapper. The camera layer must not import from `src/ui/`: the dependency runs
ui → render and adding the reverse edge for one constant would be backwards. The mapper
imports it from the render layer instead.

Yaw stays **unbounded**. Drag already accumulates it without wrapping
(`FirstPersonCam.ts:117`), and normalizing would put a ±PI discontinuity inside the
turn ease — a real bug, traded for a precision loss that needs on the order of 1e10
radians of dragging to appear.

`setMode` hands the outgoing camera's bearing to its replacement
(`DungeonRenderer.ts:166`). It hands over `heading` rather than `azimuth`, so toggling
F2 mid-turn lands on the direction the player committed to instead of the angle the
ease happened to be passing through.

### 5. Wiring, and where the hook sits

`TextHud` gains one injected seam, consulted in `onKey` immediately before
`keyCode(e)` (`TextHud.ts:231`):

```ts
remap: ((e: KeyboardEvent) => number | "consumed" | null) | null = null;
```

`TextHud` never learns what a turn is: it feeds a `number`, swallows `"consumed"`, and
falls through on `null`. Translating a `{ kind: "turn" }` into a camera swing happens in
`VectorView`, which is the object that owns the camera.

`null` falls through to the existing `KEYMAP` path, which is what keeps orbital mode and
every unbound key exactly as they are.

**The early returns in `onKey` are not enough to scope this.** `getlin` is covered by
`lineInput` (`TextHud.ts:287`) and full menus by `activeMenu` (`TextHud.ts:348`), but
there are three `readKey()` call sites (`TextHud.ts:158, 250, 274`) and only the first
is a command:

| Call site | What is waiting | Remap? |
|---|---|---|
| `nhgetch` / `nh_poskey` (`:158`) | the command loop | yes |
| `ynFunction` (`:250`) | a prompt — and with empty `choices` it returns *any* key (`:251`) | no |
| `messageMenu` (`:274`) | a prompt whose answer is checked against inventory letters | no |

Left unscoped, a remapped `ArrowUp` would answer a y/n prompt with `k`, or pick an
inventory item in `messageMenu` if `k` happened to be its accelerator — and a turn,
which feeds nothing, would leave a prompt sitting there looking ignored.

So `TextHud` tracks what it is waiting for. A `prompting` counter, raised around the
two prompt awaits inside the `try/finally` blocks they already have, gates the hook:

```ts
const mapped = this.prompting ? null : this.remap?.(e) ?? null;
```

Routing gaze-relative directions into NetHack's own "In what direction?" prompt
(`getdir()` reaches this port as `yn_function` with empty choices, `cmd.c:3989`) is a
real improvement and a natural follow-up — but it is a deliberate feature with its own
prompt-shape detection, not something to acquire by accident from an unscoped hook.

`VectorView` installs the hook and owns the mode check, because it is the only object
holding both the HUD and the renderer:

```ts
this.hud.remap = (e) => {
  if (this.renderer.mode !== "first") return null;
  const r = resolve(DEFAULT_BINDINGS[chord(e)], this.renderer.heading);
  if (r?.kind === "turn") { this.renderer.turn(r.delta); return "consumed"; }
  return r ? r.code : null;
};
```

`DungeonCamera` gains a required `readonly heading: number` — the bearing movement
resolves against, which leads the eased `azimuth` while a turn is in flight — and an
optional `turnBy(delta)`. `OrbitCam` returns its `azimuth` for `heading` and does not
implement `turnBy`. `DungeonRenderer` republishes both as `get heading()` and
`turn(delta)`, the latter a no-op wherever `turnBy` is absent.

### 6. Discoverability

The F2 message (`VectorView.ts:30-32`) names the controls when the mode is entered:
arrows walk where you look, Left/Right turn, Shift runs.

## Testing

`resolve()`, `chord()` and the binding lookup are pure functions of their arguments —
no GPU, no DOM, no engine. They unit-test under vitest as part of `npm test`:

- every 45° of yaw resolves to the expected character, including the wrap at ±PI and
  the halfway cases that `Math.round` decides;
- the sign of the mapping, which is the part most likely to be wrong and the part a
  comment cannot prove: yaw `-PI/2` must resolve to `l`, not `h`;
- `move-back` is the opposite index, at every yaw;
- `Shift+ArrowUp` resolves to the uppercase of what `ArrowUp` resolves to;
- turns feed nothing;
- an unbound chord returns `null` so `KEYMAP` still sees it.

The hook's *scope* needs its own tests, because that is where this design was wrong
before review: with a mapper installed, a `yn_function` prompt and a `message_menu`
must both receive the raw key, and only the `nhgetch` path may be remapped. These run
against the document stub `message-menu.test.ts` already uses.

`npm run typecheck` does **not** cover them — `tsconfig.json:16` includes only `src`.
Test files are type-checked by vitest at run time and nothing else; a plan step that
claims otherwise is wrong.

`FirstPersonCam.turnBy` tests without a renderer too: it constructs against a stub
element, so the lattice snap and the ease are assertable directly.

The feel — that the ease reads as a turn and not a cut — is what
`npm run check:browser` is for, by hand.

## Out of scope

`vect-hack-be3` as filed bundles four independent subsystems: this movement layer,
click-to-move with travel-command pathfinding, contextual action menus on entities, and
inventory overlays replacing tty menus. Only the first is designed here; the rest want
their own specs and should be split into child beads.

Also deliberately excluded:

- **The rebinding UI and its persistence.** Layer 1 is a constant a later bead swaps
  for a loaded one; nothing here reads storage.
- **Orbital-mode remapping.** Arrows stay absolute outside first person.
- **`Home`/`End`/`PageUp`/`PageDown`.** They keep giving absolute diagonals through
  `KEYMAP`; the first-person layer is the four arrows only.
- **Numpad.** Digits are NetHack count prefixes and are not touched.
