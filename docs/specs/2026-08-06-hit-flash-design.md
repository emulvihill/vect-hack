# Hit flash — design

2026-08-06. Status: approved.

## Goal

A visible animation when a creature takes a hit: a brief red pulse on the
letterform at the victim's cell — hero and monsters both, in both Modules and
both views (orbital and first-person). Atmospheric, not cheesy: same envelope
physics as the existing effect glow, tinted red instead of white.

## Constraints

- Neither engine reports the victim's position. Angband messages carry a typed
  `messageType` (MSG_HIT family, MSG_MON_HIT, MSG_SHOOT_HIT…); NetHack's shim
  carries only message text. Position is inferred; a wrong guess costs one
  cosmetic flash on a neighbor, so heuristics are acceptable — but a miss or an
  ambiguous case produces **no pulse**, never a guessed one.
- Render layer stays game-free (Backplane rule); token rule: adapters,
  not new physics.

## Architecture

### Shared (Backplane + render)

- **Hit event**: a victim cell, produced by each Module's view and handed to the
  renderer as `hitFlash(x, y)` — no `target` discriminator shipped, because the
  pulse is the same for the hero and for a monster. No protocol change —
  inference runs view-side from events the workers already send.
- **`src/render/effects/hitFx.ts`**: the envelope's constants
  (`HIT_RELEASE_S`, `HIT_POP`) and `flashRed(base, energy)`, the per-channel
  lerp toward the skin's red. The field itself is a second `EnergyField` inside
  `MapFx` (`hit(x, y)` fires it, `hitAt(x, y)` reads it, stepped with the
  effect glow's), so `DungeonRenderer` wiring stays one object; the renderer's
  seam is `hitFlash(x, y)`.
- **`EntityLayer`**: where it now heats effect strokes toward white
  (`heat(clr, fx.energyAt)`), a being's color additionally lerps toward the
  skin's red slot by `hitAt`, with a matching brightness pop. An effect glyph is
  the blast, not its victim: it keeps dwell heat and never pulses.

  **Amended 2026-08-06 (as shipped).** The envelope's numbers live in
  `hitFx.ts`, not in the skin tokens: `src/render/quadrascan.json` is the vendored
  token file and stays pristine — the rule is write
  adapters, not edit upstream. The colour is still themed, because the pulse
  lerps to `clr(CLR.RED)`: a skin that redefines red redefines the flash.
- The `EntityFx` interface grows the accessor.

### Per module — one inference file each

**Amended 2026-08-06 (as shipped).** Both contracts below are what the code
does; the approved sketch under-read how ambiguous each engine's signals are.

- **`src/modules/angband/hitInference.ts`**: `messageType` (list-message.h
  positions, pinned 4.2.6) → victim cell. MSG_MON_HIT → the hero's own cell.
  The hit types split in two: a **melee-only** set (MSG_HIT, HIT_HI_GREAT,
  HIT_HI_SUPERB — the ranged critical table tops out at SUPERB, so the HI_
  tiers never come off a bow) resolves to hero + `lastDir` or to nothing; an
  **ambiguous** set the engine emits for melee *and* ranged crits (HIT_GOOD,
  HIT_GREAT, HIT_SUPERB, SHOOT_HIT) takes hero + `lastDir` when a direction is
  fresh and falls back to the last effect cell otherwise. MSG_MISS and every
  unlisted type → no pulse.

  Freshness is the view's bookkeeping. `lastDir` is stamped only from a
  command-level keypad direction — a direction typed into a prompt or a menu is
  an answer, not a step — and every other key clears it. `lastEffect` is set by
  each `EVENT_MISSILE`/`EVENT_BOLT` cell, is spent by the one message that
  follows it, and is cleared on every key send. Both die with the level: the old
  level's cells no longer exist.
- **`src/modules/nethack/hitInference.ts`**: two regexes over message text.
  YOU_HIT ("You hit/smite/strike/… the|a|an|it …") → hero + `lastDir`, minus
  the shapes that are not a melee on a creature: `kick` is out (dokick.c prints
  "You kick %s." identically for a monster and a floor object), `your` is out
  (pets arrive through mon_nam() as "the little dog", so "your" here is
  self-injury), and a scenery object — rock, door, fountain, statue — is out.
  HITS_YOU ("The newt bites!", "The bee stings you.") → the hero's cell; a verb
  with an object after it is a pet fighting something else and does not pulse.
  Anything else — ranged, off-screen fights — no pulse. This is the documented
  "limited abilities" Module: text is all the shim provides.

  One more accepted false negative, on the safe side: the `F`+direction fight
  command never aims a pulse — its direction key is consumed by `getdir()`'s
  prompt, so `command` is false at consumption and `lastDir` is cleared rather
  than stamped. A hit lands with no aim, which reads as no flash instead of a
  flash on the wrong cell. Pointer attacks are NOT in this bucket: a click on a
  hostile sends one bare direction letter through `sendKeys`, which refuses to
  feed while a prompt is open, so the key is consumed at command level and the
  pulse aims correctly. The two-key menu verbs whose direction is eaten by
  `getdir()` (open, kick, chat, …) never stamp an aim either — but none of
  their messages are in the YOU_HIT set, so nothing is lost.

  `lastDir` is stamped at key **consumption** (`TextHud.readKey`, the key
  queue's single consumer), not at entry: the queue buffers, so a key typed
  ahead of a prompt would otherwise be stamped command-level and aim a pulse at
  whatever "y" points to. By consumption time the actual reader is known, and a
  prompt answer clears the aim instead.

Both files are pure functions so tests need no engine. The signatures are not
identical: Angband takes message type + hero + last-direction + last-effect-cell,
NetHack takes message text + hero + last-direction — it has no ranged signal, so
there is no last-effect-cell to take. Both answer `cell | null`.

## Testing

- `hitFx` envelope unit test: fire → red fraction rises and decays to zero.
- Per-module inference tests from message fixtures (typed for Angband, text for
  NetHack), including the no-pulse cases.
- **Amended 2026-08-06 (as shipped).** The mid-pulse colour is pinned by
  `scripts/test/hit-flash.test.ts` instead of a new preview image: it runs the
  real `buildEntities` into a recording `LineBatch` and asserts the segment
  colours and gain at zero and full hit energy, which is the same measurement a
  rasterized frame would have carried and one that names the failure. No new
  `npm run preview` artifact.

## Out of scope

- Damage magnitude → pulse intensity (no reliable signal in either engine).
- Death animation (separate feature; the glyph disappearing already reads).
- Engine/C changes of any kind.
