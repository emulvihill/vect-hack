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

## Additional component licenses and required notices

Every Module contains permissively licensed components. They remain under
their own grants, and their conditions — attribution, notice reproduction,
and for BSD-3 a non-endorsement term — apply on top of the row above. None of
them changes the term on which the Module is distributed as a whole, because
each is more permissive than the row's license; that is why they live here
rather than in the map.

- **Larn** — six NetBSD-era files: five University of California 3-clause
  (`bill.c`, `data.c`, `fortune.c`, `store.c`, `pathnames.h`; 1988, 1990 and
  1991 Regents copyrights) and one Christos Zoulas 2-clause (`extern.h`).
  Reproduced in [LICENSE.LARN](LICENSE.LARN).
- **Angband** — `message.c/.h`, `wiz-stats.c`, `z-textblock.c/.h` and
  `sound.h` are BSD-2-clause and compile into `angband.wasm`.
- **NetHack** — Lua 5.4.8 (MIT) is compiled into `nethack.wasm`, and
  `src/isaac64.c` is CC0 / public domain rather than NGPL.
- **All four** — the Emscripten runtime (MIT/NCSA) and parts of musl libc
  (MIT, with its own separately licensed portions).

Everything except the Larn set is reproduced in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## The combined distribution

The built application is an **aggregation of separable works** — a shared MIT
host plus four self-contained Modules, each in its own Web Worker behind a
message protocol. This is the project's documented position, not a settled
legal conclusion; whether a larger combination would be judged one derivative
work is fact-dependent. It matters because the licenses cannot be reconciled
into one: GPL-2.0-only and GPL-3.0-or-later alone cannot both govern a single
combined derivative work under the present grants, and the NGPL and Morgan's
grant add further terms of their own. Keeping the Modules separable is
therefore a design constraint, not just a tidy structure.

Hosting the app is distribution — the browser downloads the wasm binaries and
bundles. Three consequences:

- **NGPL:** a work containing NetHack must be licensed at no charge (¶2b).
  ¶2c still permits a fee for the physical act of transferring a copy.
- **Source offer:** a link to this repository is the *archive-information*
  route of ¶3b, which is available only for noncommercial distribution — not
  ¶3a, which is accompany-with-source.
- **Larn:** the project relies on free, ad-free hosting satisfying Morgan's
  no-profit condition. "Profit" is undefined in the 1986 grant and browser
  delivery postdates it, so any revenue-linked distribution of the Larn
  Module needs separate review.

The GPL Modules expressly permit commercial distribution, and the NGPL permits
a transfer fee; the constraints above are conditions, not a ban. As project
policy, VectHack still routes any commercial redistribution past counsel
first — chiefly because of Morgan's undefined "profit" and the ¶3b
noncommercial limit, which are the two genuinely unsettled points.

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
