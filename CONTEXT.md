# Vect platform — ubiquitous language

Glossary only. No implementation details. See `docs/decisions/` for decisions.

## Terms

**App** — the single versioned application: renderer, HUD, skins, input, save
management, catalog, and every game's integration code, compiled and shipped
together. There is exactly one App; nothing of Eric's ships separately from it.

**Engine Build** — the built WASM bytecode of one game engine, produced from
an Engine Repo. The only artifact the App loads that is not compiled into it.

**Engine Repo** — a repository that is fully GPL-clean: upstream engine source
plus at most a minimal stub, sufficient for anyone to reproduce its Engine
Build exactly. Not Eric's code (beyond the stub).

**Module** — the per-game integration unit inside the App: the game's
Classifier, input map, and glue, conforming to the Backplane. The
assembly-line pattern every game follows — a top-down ASCII grid translated
into vector space. A Module references exactly one Engine Build. The Engine
Build itself is never called a module.

**Backplane** — the internal interface between the App's shared layer and
each Module: the Cell grid, input events, and persistence namespace.
Versioned with the App itself, not independently. (Renamed from "Game Seam",
2026-08-02.)

**Cell** — one tile of the semantic grid a Module presents to the shared
layer. Carries a Category, a Kind, and rendering hints.

**Category** — closed vocabulary, owned by the shared layer: the set of
things the renderer and radar genuinely branch on (wall, floor, door, water,
lava, stairs, trap, being, item, effect, …).

**Kind** — open vocabulary, owned by each Module, scoped within a
Category (e.g. `mineral-vein`, `web`). The renderer must draw any unknown
Kind acceptably from its Category plus hints.

**Classifier** — the per-game code that maps engine output (glyphs/feature
ids) onto Cells. Part of the App.
