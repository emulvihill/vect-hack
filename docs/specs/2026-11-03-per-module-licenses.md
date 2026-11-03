# Per-Module license pages — plan

2026-11-03. Status: proposed.

## Goal

Each game's "Licenses & source" link shows VectHack's own terms plus that
game's terms, and nothing about the other three games. The build stages each
game's set separately, so the copy step reads one folder per game and needs no
per-file exception list.

## What attaches to each game

Every game page carries the **VectHack set**, because every game loads the
shared host and every engine is compiled by Emscripten:

| Component | License | Source of the text today |
|---|---|---|
| VectHack's own code | MIT | `LICENSE` |
| three.js 0.185.1 | MIT | `THIRD_PARTY_NOTICES.md` § three.js |
| Emscripten 6.0.4 runtime | MIT / University of Illinois-NCSA | `THIRD_PARTY_NOTICES.md` § Emscripten |
| musl libc (parts, in every wasm) | MIT, plus separately licensed portions (e.g. qsort, Lynn Ochs, MIT) | `THIRD_PARTY_NOTICES.md` § musl |

Then each game adds only its own:

| Game | Governing license | Notices carried within | Source of the text today |
|---|---|---|---|
| **NetHack 5.0** | NGPL | Lua 5.4.8 (MIT), compiled into `nethack.wasm`; `src/isaac64.c` (CC0 / public domain); `recoverSave.ts` is a port of `util/recover.c` (NGPL) | `LICENSE.NETHACK`; `THIRD_PARTY_NOTICES.md` § NetHack, § Lua; `NOTICE` ¶1 |
| **Angband 4.2.6** | GPL-2.0-only | BSD-2-clause files `message.c/.h`, `wiz-stats.c`, `z-textblock.c/.h`, `sound.h`; front end adapted from Shelob's `main-emscripten.c` (GPLv2 elected) | `LICENSE.GPL2`; `THIRD_PARTY_NOTICES.md` § Angband; `NOTICE` ¶2 |
| **Umoria 5.7.15** | GPL-3.0-or-later | none: every upstream source file and our `src/modules/moria/native/` carry `GPL-3.0-or-later` (to be re-confirmed in step 1) | `LICENSE.GPL3` |
| **Larn 12.0** | Noah Morgan's 1986 no-profit grant | five UC Regents BSD-3-clause files and one Christos Zoulas BSD-2-clause file, reproduced inside `LICENSE.LARN` | `LICENSE.LARN` |

Source offer, per game (`SOURCE.txt`): the commit and repository are common.
The NGPL ¶3(b) "noncommercial only" note belongs on the NetHack page only;
Angband cites GPLv2 §3, Umoria GPLv3 §6; Larn's grant requires no source offer
(we give one anyway).

## Repository layout

The four governing license files stay where they are. Moving them gains
nothing: the stage step picks files by name either way. Only the two files
that mix games get split, following the existing `LICENSE.<GAME>` naming:

| File | Today | After |
|---|---|---|
| `LICENSE`, `LICENSING.md` | root | unchanged |
| `LICENSE.NETHACK`, `LICENSE.GPL2`, `LICENSE.GPL3`, `LICENSE.LARN` | root | unchanged |
| `THIRD_PARTY_NOTICES.md` | all components | the VectHack set only: three.js, Emscripten, musl |
| `NOTICE.NETHACK` | new | from `THIRD_PARTY_NOTICES.md` § NetHack and § Lua, plus `NOTICE` ¶1 |
| `NOTICE.ANGBAND` | new | from `THIRD_PARTY_NOTICES.md` § Angband, plus `NOTICE` ¶2 |
| `NOTICE` | NetHack + Angband paragraphs | deleted; both paragraphs moved |

`stage-licenses.mjs` replaces its flat `LICENSE_FILES` list with one table,
keyed by the `?game=` id `main.ts` already dispatches on:

```js
export const VECTHACK_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
export const MODULE_FILES = {
  nethack: ['LICENSE.NETHACK', 'NOTICE.NETHACK'],
  angband: ['LICENSE.GPL2', 'NOTICE.ANGBAND'],
  moria:   ['LICENSE.GPL3'],
  larn:    ['LICENSE.LARN'],
};
```

## Build output

`scripts/build/stage-licenses.mjs` writes one page per game from the table:

```
dist/licenses/
  index.html             the four games, one link each, plus LICENSING.md
  nethack.html           VECTHACK_FILES + MODULE_FILES.nethack, SOURCE text inline
  angband.html  moria.html  larn.html
  LICENSE*  NOTICE.*  THIRD_PARTY_NOTICES.md  LICENSING.md  SOURCE.txt
                         every raw text, copied as-is, as today
```

Pages stay flat files linked by name, for the same reason as today: a host
that rewrites only `/`-suffixed URLs still serves them. The dist still holds
every text, because one deploy serves all four games. Only what each page
shows is narrowed.

## The link

`index.html`'s `#licenseslink` gets its `href` from the booted game
(`licenses/<game>.html`), set in the same place the game id is resolved.
`?game` is never implicit, so with no game the link keeps
`licenses/index.html`.

## Steps

1. Re-audit the per-game rows above against the trees: grep each
   `external/<engine>` and native adaptation for non-governing license
   headers; confirm the bundle each `?game=` loads (the `check:payload` gate
   already proves no game fetches another Module's JS).
2. Split `THIRD_PARTY_NOTICES.md` and `NOTICE` into `NOTICE.NETHACK` and
   `NOTICE.ANGBAND`; update the links in `LICENSING.md`, `LICENSE`'s trailer,
   `README.md` and `docs/RELEASE-CHECKLIST.md`.
3. Rewrite `stage-licenses.mjs` around the table; fail the build if a `?game`
   id has no `MODULE_FILES` entry or an entry names no known game (missing
   files already fail through `copyFileSync`).
4. Set `#licenseslink` per game; extend `scripts/test/licenses-page.test.ts`:
   each page names its own governing license, names no other game's, and
   carries the VectHack set; the link resolves to the booted game's page.
5. Decision file under `docs/decisions/`; `npm test`, `npm run build`,
   inspect `dist/licenses/`.

## Open question

Whether `dist/licenses/index.html` should list all four games or show only
the VectHack set. The deploy contains all four games, so all texts stay in
`dist/` either way.
