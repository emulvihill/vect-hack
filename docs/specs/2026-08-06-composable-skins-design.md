# Composable skins — design

2026-08-06. Status: approved. Bead: vect-hack-jn0.
Validated by the `worktree-skins-prototype` throwaway branch (prototype
commits 3c636a4, 21126b7 — palette values and the solid-floor look were
picked from its rendered previews).

## Goal

Five color palettes and stackable settings, combinable into named skins; a
curated sampling offered from an in-game selector. Solid floors — the picked
look — become real geometry instead of the prototype's scanline hack.

## Decisions already made

- Floor treatment: **filled translucent planes** (prototype Variant B), not
  brighter wireframe.
- Palettes: **Quadrascan** (current default), **Amber**, **Crimson**,
  **Vapor**, **Ice** — the prototype JSONs' values are the starting points,
  tunable during implementation via `npm run preview`.
- Selector: **in-game menu**, not a page-chrome dropdown; switching remains a
  reload by design.
- Sampling now, fine-tuning later: the menu lists curated presets; the
  underlying `+` grammar is the future fine-tuning surface and costs nothing
  extra today.
- No backward compat: the stored skin name and the ghost/high-contrast skin
  files are reshaped freely (nothing is released).

## Architecture

### Skin model: palette × mods

- A skin **name** is `<palette>[+<mod>]*`, e.g. `amber+solid`,
  `quadrascan+ghost`. Resolution deep-merges: complete base (quadrascan)
  ← palette delta ← each mod delta, left to right. Tokens merge over the
  vendored quadrascan.json as today.
- **Palettes** (`src/skins/palettes/*.json`): color-only deltas — `clr`,
  `ink`, `hudClr`, `css`, `radar`. `quadrascan.json` stays the one complete
  skin and doubles as its palette. `high-contrast` becomes a sixth palette
  holding only the current high-contrast.json's colors (clr, ink, hudClr,
  css).
- **Mods** (`src/skins/mods/*.json`): palette-independent settings deltas.
  - `solid` — `gains: { floorFill: 0.5 }`. The fill quad's color comes from
    the palette's `ink.floor`/`ink.corridor`, so one mod serves all palettes.
  - `ghost` — `walls: { opacity: 0.8 }` (the current ghost.json, renamed).
  - `sharp` — the current high-contrast.json's legibility settings:
    `strokes: { terrainWidth: 2.6, entityWidth: 3.2 }`,
    `gains: { floorInterior: 0.55 }`, `tokens: { glow: { beam_layers: 2 } }`.
    (Its `walls.opacity: 1` is the base value and is dropped.) Combines with
    any palette — `amber+sharp` is a legible amber.
- An unknown palette or mod token falls back to the default skin, same as an
  unknown name today. The whole combo string is what `?skin=`, `VECT_SKIN`,
  and localStorage (`SKIN_STORAGE_KEY`) carry; active-at-module-evaluation
  and reload-on-change semantics are untouched.

### Presets — the sampling the menu shows

| Label            | Name                    |
|------------------|-------------------------|
| Quadrascan       | `quadrascan`            |
| Quadrascan Solid | `quadrascan+solid`      |
| Amber Solid      | `amber+solid`           |
| Crimson Solid    | `crimson+solid`         |
| Vapor Solid      | `vapor+solid`           |
| Ice Solid        | `ice+solid`             |
| Ghost            | `quadrascan+ghost`      |
| High Contrast    | `high-contrast+sharp`   |

Exported as an ordered `PRESETS` list from `src/skins/`, consumed by the
menu. Wireframe-only palette combos (`crimson`, `amber`, …) remain valid
names for the URL/env even though the menu does not list them.

### Solid floors: the FloorFill layer

- New `src/render/FloorFill.ts` beside WallFill: additive-blended,
  non-depth-writing horizontal quads at y=0, vertex-colored. Unlike
  WallFill's depth-only mask, these write color.
- `buildTerrain` gains an optional color-fill sink (interface in
  TerrainBuilder next to `FillSink`): `quad(corners…, color, gain)`. It emits
  one quad per open cell when `GAIN.floorFill > 0`, color =
  `ink.corridor` for corridors else `ink.floor`, gain = `floorFill × light`
  (the per-cell light field stays visible in the fill, as validated).
- **Occupied-cell rule** (from the prototype fix): a cell whose category is a
  being/item/effect with no terrain underlay is walkable — it fills as floor.
  Cells `terrainOf` calls unseen and true wall cells never fill.
- The prototype's scanline hack and the `floorFill` scanline loop are not
  carried over; `floorFill` stays a skin gain key.
- `DungeonRenderer` owns the FloorFill mesh exactly as it owns WallFill.

### Selector: F4 skin menu

- `src/ui/skinMenu.ts` (shared chrome, game-free): a small overlay listing
  `PRESETS` with the active one marked. Arrow keys + Enter, or click, to
  pick; Escape or F4 closes. Function keys stay view chrome — F4 never
  reaches an engine.
- Picking writes `SKIN_STORAGE_KEY`, strips any `?skin=` from the URL (it
  would override the new choice on reload), and calls `location.reload()`.
  Reload drops any unsaved-since-checkpoint progress; the menu is chrome,
  not an engine event, and NetHack autosaves checkpoints — same exposure F5
  already has. Picking the already-active preset just closes the menu.
- Wired once in `src/main.ts` for both Modules, like F3's save download.

### Preview support

`scripts/dev/scene-preview.test.ts` learns to rasterize the color-fill
quads: project the four corners, scanline-fill the polygon additively at the
quad's color × gain. `VECT_SKIN` already accepts any name, combos included.
The preview stays the tuning loop for palette values.

## Testing

- Skin resolution unit tests: combo parsing, merge order (palette then mods,
  later mod wins), unknown-token fallback, storage round-trip of combo names.
- TerrainBuilder fill-emission tests: quad per open cell, corridor vs floor
  ink, occupied-cell rule, no quads at `floorFill` 0, light scaling.
- Skin menu unit tests with an injected reload hook: writes storage, strips
  `?skin=`, reloads; Escape leaves storage untouched.
- `npm run preview` renders `VECT_SKIN=amber+solid` in CI-less form — the
  images are the visual regression surface.
- `npm run check:browser` unchanged; a follow-up GPU look at the quads rides
  an existing run.

## Out of scope

- A fine-tuning config UI (the `+` grammar is the hook for it later).
- Live, no-reload skin switching.
- Per-Module skin selections.
- New palettes beyond the five (drafts ember/verdant were not picked).
