# Orbital view: direction keys rotate with the camera

## Problem

In the orbital (default) view, dragging the camera rotates the map but not the
keys: `TextHud`'s `KEYMAP` always turns ArrowUp into `k` (map-north) and the
numpad cluster (Home/End/PgUp/PgDn with NumLock off) into the absolute
diagonals. With the camera swung 180°, "up on the screen" walks the hero down.
First-person mode already solved this — `VectorView`'s remap resolves arrows
through `moveKeys.resolve()`, which snaps the camera heading to the nearest of
eight compass points — but the remap is explicitly gated to `mode === "first"`.

One adjacent gap comes along for the ride: even in first person, only the
four arrows are bound; Home/End/PgUp/PgDn fall through to `KEYMAP` unrotated.

## Decisions (from brainstorming, 2026-08-01)

- **Orbital arrows move, never turn**: all eight direction keys are
  screen-relative moves (ArrowLeft walks screen-left). Camera rotation stays
  on mouse drag. First person keeps its turn-on-left/right scheme.
- **NumLock is the pad's mode switch** (revised 2026-08-01, superseding an
  `e.code` physical-match design): keys are matched by `e.key` as today.
  NumLock off, the pad emits the named keys (`ArrowUp`, `Home`, `Clear`, …)
  and is a rotated directional pad; NumLock on, it emits digits that reach
  NetHack untouched as count prefixes, like the top row.
- **Numpad5 (`Clear`) resets azimuth only** — swings the bearing back to
  north-up so the keys match classic NetHack again. Elevation and zoom
  untouched. Works in first person too (faces north). Digit `5` stays a
  count prefix.
- Rotating the vi letters was rejected: every letter is a live NetHack
  command and reaches the engine untouched (existing invariant).

## Design

### 1. `moveKeys.ts` — diagonal actions, orbital table, reset

Key naming is untouched: `chord()` already yields the named keys the numpad
emits with NumLock off (`ArrowUp`, `Home`, `Clear`, …), which are the same
names the main cluster uses — one table entry serves both. With NumLock on
the pad emits digits, which no table binds, so they fall through to the
engine as count prefixes.

- `CAMERA_ACTIONS` gains `"move-fwd-left"`, `"move-fwd-right"`,
  `"move-back-left"`, `"move-back-right"`, and `"reset-facing"`. The
  `Action` type and `keyBindings.ts`'s validator derive from the array, so
  they become bindable automatically.
- `Resolved` gains `{ kind: "reset" }`.
- `resolve()` handles the diagonals with compass steps 7/1/5/3 (fwd-left,
  fwd-right, back-left, back-right) in the existing
  `DIRECTIONS[(compass(yaw) + step) & 7]` arithmetic, and answers
  `"reset-facing"` with `{ kind: "reset" }`.
- A second layer-1 table, `ORBITAL_BINDINGS`: arrows → fwd/back/left/right,
  Shift+ArrowUp/Down → run-fwd/run-back, `Home` → fwd-left, `PageUp` →
  fwd-right, `End` → back-left, `PageDown` → back-right, `Clear` →
  reset-facing. The NumLock-off numpad emits exactly these names, so the pad
  and the main cluster share every entry.
- `DEFAULT_BINDINGS` (first person) gains the `Home/End/PageUp/PageDown`
  diagonals and `Clear` → reset-facing, so diagonals rotate there too,
  closing the existing gap; arrows keep their turn semantics.

### 2. Cameras — `resetFacing()`

`DungeonCamera` gains optional `resetFacing?(): void` beside `turnBy?`.

- `OrbitCam` adopts FirstPersonCam's split: `azimuthTarget` chased by
  `azimuth` in `update()` with a short time-constant; drag writes both (1:1,
  never chased). `heading` returns the target (the committed bearing), same
  rationale as `FirstPersonCam.heading`. `resetFacing()` sets the target to
  the nearest multiple of 2π, so the swing takes the short way round.
- `FirstPersonCam.resetFacing()` sets `yawTarget` to the nearest multiple of
  2π (yaw eases there through the existing turn animation).
- `DungeonRenderer.resetFacing()` delegates `this.cam.resetFacing?.()`,
  mirroring `turn()`.

### 3. `VectorView` — mode picks the table, gate removed

```ts
this.hud.remap = (e) => {
  const table = this.renderer.mode === "first" ? this.bindings : ORBITAL_BINDINGS;
  const r = resolve(table[chord(e)], this.renderer.heading);
  if (r?.kind === "turn") { this.renderer.turn(r.delta); return "consumed"; }
  if (r?.kind === "reset") { this.renderer.resetFacing(); return "consumed"; }
  return r?.kind === "key" ? r.code : null;
};
```

Saved overrides (`loadBindings()`) keep applying to the first-person table
only; the orbital table ships as defaults until someone asks for orbital
rebinding.

Direction prompts come free: the remap is already consulted for NetHack's
"In what direction?" prompts, so orbital answers them rotated too.

The radar already turns with `heading`; no change.

### 4. Error handling

Nothing new can fail at runtime: `resolve()` stays pure, unknown chords still
fall through to `KEYMAP`, and `resetFacing?.()` is a no-op on a camera that
doesn't implement it. A stale saved override naming a new action was already
impossible (validator derives from `CAMERA_ACTIONS`).

## Testing

- **Unit (`moveKeys` tests)**: each orbital key resolves to the right letter
  at representative snapped azimuths (0, 90°, 180°, −45°, and an accumulated
  multi-turn value); diagonal step arithmetic; `reset-facing` → `{kind:
  "reset"}`; digits are bound in neither table (count prefixes fall through).
- **Unit (OrbitCam)**: reset from an accumulated azimuth eases to the nearest
  2π multiple; heading reports the target during the swing.
- **`npm run check:controls`** gains an orbital pass: rotate the camera ~180°
  (drag or direct azimuth write), press ArrowUp, assert the engine received
  `j` not `k`; press Clear (Numpad5), assert ArrowUp sends `k` again.

## Out of scope

- Orbital rebinding/overrides UI.
- Shift+numpad run variants.
- NetHack's `number_pad` option (letters remain the wire format).
