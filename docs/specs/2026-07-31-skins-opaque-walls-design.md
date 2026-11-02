# Skins + opaque walls — design

Date: 2026-07-31. Status: approved.

## Goal

Walls that occlude — you can no longer see through them — and a skin
configuration system so the client can ship different look-and-feels: the
default Quadrascan look with opaque walls, a semi-translucent variant, and a
low-vision high-contrast palette. Skins are data files; a new look should not
require touching renderer code.

## Decisions taken during brainstorming

- **Occlusion applies in both cameras.** Walls are only `WALL_HEIGHT` (1.1
  cells) tall, so the orbital 3/4 view still sees into rooms over their walls,
  like a physical model — but not through them at grazing angles.
- **Selection: URL flag + saved setting.** `?skin=name` for dev/testing,
  persisted to localStorage, applied at boot. No in-game picker in v1; a skin
  change is a page reload.
- **Scope: renderer + HUD/radar.** Colors, wall opacity, gains, stroke widths,
  bloom layer count, plus TextHud's palette and the chrome CSS colors.
- **Shipped skins:** `quadrascan` (default, opaque), `ghost` (semi-translucent,
  0.35), `high-contrast` (low-vision).
- **Approach: boot-time skin module** (no live-switch plumbing — YAGNI given
  reload-to-switch), JSON deltas deep-merged over a complete default.

## 1. Skin files and schema

New `src/skins/`:

- `types.ts` — the `Skin` interface and a small typed deep-merge.
- `quadrascan.json` — the **complete** default skin: the current look with
  `walls.opacity: 1`. The hand-tuned values currently scattered through the
  code move here: `palette.ts`'s LIFTED_BLACK / LIFTED_BLUE / NEUTRAL /
  WALL_LIFT products, the `INK` role colors, TextHud's 16-color array, and
  index.html's chrome colors.
- `ghost.json` — delta: `walls.opacity: 0.35`.
- `high-contrast.json` — delta: brighter/lifted palette, thicker strokes,
  fewer bloom layers (halo blur hurts low vision), opaque walls.
- `index.ts` — registry of shipped skins + `resolveSkin()`.

Schema — every section optional in a delta, merged over the default:

| Key | Contents |
| --- | --- |
| `background` | Clear color. |
| `tokens` | Overrides for the vendored quadrascan token values (`semantic`, `track_palette`, `glow`). |
| `clr` | The 16 CLR_*→hex entries used by the 3D view (`clr()`). |
| `ink` | The structural roles: wall, wallTop, floor, corridor, door, stairs, hero, heroRing, pet, water, lava, trap, cursor. Final colors — the WALL_LIFT multiply happens when authoring quadrascan.json, not at load. |
| `walls` | `{ opacity }`: 0 = no fills (fully see-through), 1 = solid, between = translucent via the ghost pass. The ghost pass's alpha split is `1 − walls.opacity` — one value drives both the fill mask and the LineBatch split, not two. |
| `strokes` | `{ terrainWidth, entityWidth }`. Bloom layer count is not here — it lives in `tokens.glow.beam_layers`, the vendored token file's own field, so there is one way to say it rather than two. |
| `gains` | Partial override of TerrainBuilder's GAIN table. |
| `hudClr` | TextHud's 16 CSS colors. |
| `radar.backdrop` | The radar's clear/background colour, read the same way `clr()` and `INK` are. |
| `css` | Map of CSS custom properties for the chrome; index.html's hard-coded colors become `var(--…)` with their current values as defaults. |

Ink specs (`clr` and `ink` entries) are `string | [hex, gain]`: additive
compositing wants channel values above 1 as brightness, which a plain hex
triplet cannot express — a `[hex, gain]` tuple multiplies after parsing (e.g.
the default skin's wall ink, `#1030ff` x2.2, is the old `WALL_LIFT`).

## 2. Wall opacity — the render technique

The strokes are additive-blended with `depthWrite: false`; nothing in the
scene writes depth, which is why everything shows through everything. The fix
is a depth mask, not visible geometry:

- `emitWall`'s existing exposed-face walk also emits **fill quads** — each
  exposed side face (0→`WALL_HEIGHT`) plus a top cap per wall cell — into a
  plain indexed mesh with `colorWrite: false, depthWrite: true`. It renders in
  the opaque pass before the additive lines; the line materials already
  depth-test, so strokes behind walls clip. Against the black background the
  mask reads as solid black wall. Rebuilt whenever the terrain batch is.
- **Partial opacity (0 < α < 1):** `LineBatch` grows a ghost option — a second
  set of layer meshes sharing the same geometry with `depthTest: false` and
  per-layer alpha scaled by α, while the main set's alphas scale by 1−α.
  Additive blending makes this exact: unoccluded strokes sum to full
  brightness, occluded ones show at α. Both terrain and entity batches get it.
- **Endpoints cost nothing:** α = 1 creates no ghost meshes; α = 0 creates no
  fill mesh (today's renderer, unchanged).

## 3. Boot-time plumbing

`resolveSkin()` runs synchronously before the renderer is constructed:
`?skin=name` wins and persists to `localStorage`; otherwise the saved choice;
otherwise `quadrascan`. Unknown names warn and fall back to the default.

- `palette.ts` builds `CLR_COLORS`, `INK`, and the merged `TOKENS` from the
  active skin instead of module-level hard-coded constants. `Radar`,
  `LineBatch`, and the effects already read through `TOKENS`/`clr()`, so they
  re-theme without edits.
- `DungeonRenderer` takes stroke widths and wall opacity from the skin,
  passes opacity into the terrain build (fill mesh) and both LineBatches
  (ghost pass).
- The main entry applies `skin.css` to `:root` and hands `hudClr` to TextHud.
- The skin *source* (URL / localStorage read) is injectable so node tests and
  `npm run preview` can select a skin without a browser.

## 4. Testing

- Deep-merge behavior (nested sections, arrays replaced not merged).
- `resolveSkin` precedence: URL > localStorage > default; unknown → default.
- Ghost-pass invariant: per layer, main alpha + ghost alpha = original alpha.
- Wall-fill quad emission against a small known map: quad counts and
  positions, mirroring the existing edge-dedup expectations.
- Shipped-skin validation: every skin in the registry resolves fully — all 16
  `clr` entries, all `ink` roles, colors parseable.
- `npm run preview` gains skin selection via env var so `.preview/scene.png`
  can be eyeballed per skin. Limitation, documented: the depth mask is
  colorless, so occlusion fidelity only shows on the GPU
  (`npm run check:browser`); the software rasterizer draws lines only.
- `check:browser` unchanged: its halo ratio compares the bloom on/off gain, so
  opaque walls shrinking the visible stroke set does not break it.

## Out of scope

- In-game skin picker / live switching.
- Camera-facing wall fade (the 3/4-view cutaway).
- User-supplied skins loaded from outside the bundle.
