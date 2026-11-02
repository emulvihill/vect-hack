# Stand-on menu — clicking your own cell, and auto-open on stepping onto an item

Date: 2026-07-30. Bead: `vect-hack-0m1`.

## Why

The pointer layer deliberately punts on the hero's own cell: `dirTo(0,0)` is
null, so both `primaryAction` and `applicableActions` fall out at the
`dir === null` gate and a click on your own `@` does nothing. The stand-on
verbs (pick up, look here, the stairs) were routed to the global command menu
(be3.7) because the hero cell draws as `@` and `MapModel` cannot see what is
underneath.

That reasoning was right about *adjacent* cells but leaves the most expected
click dead: you step onto an item, the game says "You see here a long sword.",
and clicking the very cell you occupy does nothing. Some menu action is almost
expected there.

## What ships

1. **Clicking (left or right) your own `@` opens a stand-on menu** — Pick up,
   Look here, plus Go up / Go down when the hero is known to be standing on
   stairs. Left and right click behave identically here: unlike a monster or a
   door there is no single obvious verb for your own cell, so both open the
   menu rather than guessing one.
2. **Stepping onto an item auto-opens the same menu in pass-through mode** —
   any key closes it and acts normally, so keyboard play never stalls; a mouse
   user finds Pick up already on screen.
3. No change to the be3.2 rule: still no click-to-move, and the adjacent-cell
   menus are untouched.

## Design

### 1. Menu contents — plain data, not new Actions

The stand-on rows are `{label, code}` pairs like `commandMenu.ts`'s, **not**
new `Action` names. be3.7's rationale holds unchanged: an `Action` exists so
one verb resolves identically from a key, a click or a menu row *against a
direction*; these have no direction and no rebinding story.

New function in `pointerActions.ts` (it is pointer-contextual, unlike the
static command menu):

```ts
export function heroActions(under: UnderCell | null): { label: string; code: number }[]
```

| Row | Key | Shown |
|---|---|---|
| Pick up | `,` | always |
| Look here | `:` | always |
| Go up stairs | `<` | only when `under.ch === "<"` |
| Go down stairs | `>` | only when `under.ch === ">"` |

All compiled-in defaults from `external/NetHack/src/cmd.c`, same letters the
command menu already uses. The `dir === null` early return in
`applicableActions` **stays** — the hero path never reaches it (VectorView
branches on `t.isHero` first), so the be3.7 resolution of the review note is
still accurate; its comment gains a pointer to `heroActions` as the
non-directional home.

### 2. `MapModel` — remember what the `@` covered

The hero glyph overwrites the cell, so `MapModel` gains a one-cell stash:

```ts
/** What the hero's cell held before the hero glyph landed on it. */
under: { terrain: TerrainKind; ch: string } | null
```

In `set()`, when the incoming glyph has `MG.HERO` **and the cell's current
content is not already the hero** (guards in-place redraws from clobbering the
stash with `@`): stash `{terrain, ch}` if the outgoing cell was terrain,
else `null` (an object or monster was showing — terrain underneath unknown,
so no stairs rows; Pick up and Look here still apply). `clear()` nulls it.

Known limitation, accepted: a full redraw while the hero stands still (level
change, Ctrl-R) repaints the hero cell straight from `clear()`, so the stash
is null until the hero next moves. Cost: temporarily missing stairs rows,
nothing wrong ever shown — NetHack itself answers a misplaced `<` with "You
can't go up here."

Object detection deliberately does **not** use a glyph stash (approach B,
declined): items dropped or created under the hero never repaint the cell
while the hero stands on it, so the stash goes stale silently in exactly the
cases that matter. The engine's own messages are the source of truth instead
(§4).

### 3. VectorView — the hero branch

Both the `click` and `contextmenu` handlers gain one branch before their
existing logic: if `t.isHero`, open
`showActionMenu(heroActions(map.under).map(row => ({label, run: () => sendKeys([code])})))`
and stop. Everything else is unchanged, including the drag guard and the
outside-dismissal handshake.

### 4. Auto-open on the engine's own "item here" announcement

NetHack announces every step onto loot: "You see here a long sword." for one
item, "There are several objects here." / "There are many objects here." for
piles (when the pile overview window is suppressed). Matching those messages
is the detection mechanism — the engine is the source of truth, no false
positives, and it covers items dropped onto the hero's square by monsters.

- `pointerActions.ts` exports the matcher so it is unit-testable:
  `export function itemHereMessage(text: string): boolean` — true for
  `/^You see here /` and `/^There are (several|many) objects here\./`.
  Deliberately narrow: "There is a staircase up here." and other feature
  announcements do not auto-open (clicking `@` covers them), and the blind
  "You feel here" variant is out of scope.
- `TextHud` gains an optional `onMessage?: (text: string) => void` hook,
  called from `message()` — the single funnel every NHW_MESSAGE putstr
  already goes through.
- `VectorView` sets it: if the text matches, the hero stand-on menu opens
  **auto-mode** (§5). Guarded: skip when a prompt, an engine menu/overlay, or
  any action menu is already up (`showActionMenu`'s existing `busyWithPrompt`
  gate plus an explicit actionMenu/activeMenu check) — in particular the
  pile-overview overlay owns `#overlay` and must not be torn down by an
  auto-menu.

String-matching is brittle in principle; acceptable here because the NetHack
revision is pinned (`build-wasm.sh` refuses others) and we run default
options. The matcher's unit test doubles as the tripwire if the pin moves.

### 5. Pass-through mode in `showActionMenu`

`showActionMenu(rows, opts?: { passthrough?: boolean })`. For a passthrough
menu, `onKey`'s action-menu branch changes from "swallow everything but
Escape" to: close the menu, then **fall through to normal key handling** —
the movement key both dismisses and moves. Escape closes and is consumed
(it must not leak to the game and cancel a count or a prompt the next event
starts). Click-a-row, click-outside and engine-window teardown behave exactly
as today.

The pointer-opened menus (right-click, command menu, hero click) stay modal —
the player asked for them; only the unasked-for auto-open must never cost a
keystroke.

## Testing

- `pointer-actions.test.ts` — `heroActions`: base rows always present and in
  order; stairs rows keyed off `ch` (`<` up only, `>` down only, floor and
  null neither); every code is the compiled-in default byte.
  `itemHereMessage`: the three positive forms; negatives for "There is a
  staircase up here.", "You see a door in the distance.", empty string.
- `dungeon-model.test.ts` — `under` stash: set on hero landing over terrain
  (kind + ch), null over an object, survives an in-place hero redraw, nulled
  by `clear()`.
- New `stand-on-menu.test.ts` (DOM, alongside `action-menu-cancel.test.ts`) —
  passthrough menu: a letter key closes the menu AND reaches `feedKey`;
  Escape closes and does not; a modal menu still swallows letters. Auto-open
  guard: no menu while an overlay or prompt is up.
- `npm run typecheck`, `npm test` gate; browser playtest on the tutorial
  level (items in the first room) verifies the felt behavior.

## Out of scope

- Click-to-move / travel (declined, be3.2).
- Naming the item in the menu ("Pick up the long sword") — needs message
  parsing beyond a boolean, or engine-side inventory queries; the plain verb
  is enough.
- Auto-open for the blind "You feel here" case.
- Quaff/sit/other feature verbs on the hero cell (fountains, thrones) — add
  as `heroActions` rows later if wanted; same shape.
