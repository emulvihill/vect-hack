# Licensing

VectHack is one application built from four independent game engines, each
keeping its own license. VectHack's own code is MIT.

## The map

| What | License |
|------|---------|
| **VectHack's own code** — renderer, HUD, backplane, skins, UI, bots, build scripts, and every file not listed below | MIT ([LICENSE](LICENSE)) |
| **The NetHack Module** — `external/NetHack`, `src/modules/nethack/recoverSave.ts` (a port of NetHack's `util/recover.c`), and the built `public/modules/nethack/*` plus the NetHack worker bundle they compile into | NGPL ([LICENSE.NETHACK](LICENSE.NETHACK)) |
| **The Angband Module** — `external/angband`, `src/modules/angband/native/`, and the built `public/modules/angband/*` | GPL-2.0-only ([LICENSE.GPL2](LICENSE.GPL2)) |
| **The Umoria Module** — `external/umoria`, `src/modules/moria/native/`, and the built `public/modules/moria/*` and `public/modules/moria-versions/*` | GPL-3.0-or-later ([LICENSE.GPL3](LICENSE.GPL3)) |
| **The Larn Module** — `external/larn`, `src/modules/larn/native/`, and the built `public/modules/larn/*` | Noah Morgan's no-profit grant ([LICENSE.LARN](LICENSE.LARN)) |
| **Bundled runtime components** — three.js, the Emscripten runtime, musl libc, Lua | MIT / NCSA ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) |

A Module means everything that engine needs: the upstream source, the
VectHack adaptation named in the row, and the compiled `.wasm`/`.js`/`.data`
plus that Module's worker bundle. The license in the row is the term on which
that Module is **distributed as a whole**. Two things it does not mean:

- **It is not the only license inside.** Each upstream tree also contains
  separately licensed files — Larn's NetBSD BSD files, Angband's BSD-licensed
  sources, NetHack's public-domain `isaac64.c`. Those keep their own grants
  and conditions, which apply cumulatively. See the next section.
- **It does not reach the rest of the Module.** Each Module's classifier,
  views, key tables, HUD and bot are original VectHack code under MIT, so the
  renderer and per-game views stay reusable on their own.

For the three copyleft Modules the row's license does reach the named
adaptation, because our code links or ports the engine. **Larn is different:**
Morgan's grant is a bare permission, not copyleft, so it cannot re-license
anything. There, the row names the condition that binds redistribution of the
Module as a whole, while `src/modules/larn/native/` remains VectHack's own MIT
code and the NetBSD files remain under their BSD terms. All of those
conditions apply at once; none displaces another.

No single standard SPDX expression is used for the repository as a whole, so
`package.json` says `SEE LICENSE IN LICENSING.md` and this file is the map.

## The combined distribution

The built application is an **aggregation of separable works** — a shared MIT
host plus four self-contained Modules, each in its own Web Worker behind a
message protocol. Keeping the Modules separable is a design constraint, not just a tidy structure.

## Corresponding source

`npm run build` stages every license and notice text into `dist/licenses/`,
so a copied `dist/` carries its own terms. It also writes
`dist/licenses/index.html`, which carries every text inline together with
`SOURCE.txt`; the game's Saves panel links it as "Licenses & source", so the
notices and the source offer are one click from every Module.

The source for each Module is this repository — the pinned upstream tree plus
VectHack's native adaptation and build script — with one exception worth
naming: **Lua 5.4.8 is not in this repository.**
`scripts/build/build-nethack-wasm.sh` downloads it (sha256-verified) from
lua.org into the gitignored `external/NetHack/lib/`, and it is compiled into
`nethack.wasm`. The repository pins and verifies Lua; it does not contain it.

Upstream pins: NetHack tracks the `NetHack-5.0` branch tip and its build
script refuses any release other than 5.0.0 (a version check, not a commit
pin); Angband is pinned to commit 4.2.6-166 and Umoria to
`3bf8abc4f76812810e59d738492c7b61fb8f1bb6`, both enforced exactly; Larn is a
vendored NetBSD 12.0 snapshot.

NetHack's own source files carry prominent copyright and license notices —
every file in `src/` except the public-domain `isaac64.c`. Those notices
travel with the source; when redistributing the wasm in object-code form,
what must accompany it is `LICENSE.NETHACK` (verbatim from
`external/NetHack/dat/license`) together with the source or the ¶3b
information above.

Umoria is GPL-3.0-or-later per upstream's official representation (its
LICENSE, per-file SPDX tags, and the 2008 relicensing recorded in AUTHORS).
Some AUTHORS entries still record historical "GPL v2" grants; VectHack relies
on upstream's completed relicensing rather than independently warranting each
one.
