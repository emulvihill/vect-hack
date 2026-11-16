# Project map

One entry per directory, what lives there and the rules that hold it
together.

The layering, which the import graph obeys today and
`scripts/test/layering.test.ts` asserts on every `npm run test:render`:

```text
backplane -> backplane only        (0 outward edges, and no DOM)
skins     -> skins only            (0 outward edges: leaf data)
render    -> backplane, skins
ui        -> backplane, render, skins
bot       -> backplane
modules/X -> backplane, bot, render, ui, skins
modules/X -> modules/Y             (none: no Module imports another)
anything  -> main.ts               (none)
```

## The engine sources

- `external/NetHack` — official source, submodule pinned to the `NetHack-5.0` branch tip
  (release-tag wasm bugs were fixed on the branch). Never
  patched: it stays a clean external dependency anyone can compile as instructed.
  `build-nethack-wasm.sh` pins `SUPPORTED_NETHACK` and refuses to build a different
  release, because `src/modules/nethack/recoverSave.ts` depends on NetHack's on-disk save
  layout. Moving the pin means re-checking that port — and checking whether
  `sys/libnh/libnhmain.c` has learned to clear `program_state.in_self_recover`,
  which is the upstream bug the port exists to route around.
- `external/angband` — official source, submodule pinned to 4.2.6-166
  (f0f6bd223). Never patched, same rule as NetHack;
  `build-angband-wasm.sh` pins the commit and refuses to build anything else.
- `external/umoria` — official source, clean submodule pinned to
  `3bf8abc4f76812810e59d738492c7b61fb8f1bb6`. Never patch it;
  `build-moria-wasm.sh` pins source/toolchain/flags/seed bytes, stages the
  12-file runtime seed itself (the allow-list `MORIA_RUNTIME_FILES` in
  `src/modules/moria/persist.ts` mirrors), and copies the JS/WASM/data set
  into `public/modules/moria/` like the other engines.
- `external/larn` — NetBSD's BSD Larn 12.0 (`src/games/larn`, David
  Holland's 2008 modernization) under Morgan's no-profit permission; see
  `LICENSING.md` before distribution changes. A submodule of
  `emulvihill/netbsd-larn`, which is that one directory split out of
  `github.com/NetBSD/src` with its history (its README says how), because the
  whole NetBSD tree is too heavy to submodule. Pinned to `908b4c9`; never
  patched; `build-larn-wasm.sh` pins the commit and refuses a different or
  modified checkout. NetBSD's copy rather than HunterZ 12.3/12.4: theirs have
  static-after-extern conflicts, hard clang errors no `-W` flag downgrades,
  so they need source patches; NetBSD's compiles cflags-only.