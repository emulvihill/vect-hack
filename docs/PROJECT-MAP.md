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
  `build-nethack-wasm.sh` pins the commit (`SUPPORTED_NETHACK_COMMIT`) and the
  release (`SUPPORTED_NETHACK`), and refuses a different one or a modified
  tree, because `src/modules/nethack/recoverSave.ts` depends on NetHack's
  on-disk save layout. Moving the pin means re-checking that port — and checking whether
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
  modified checkout.

## The scripts

- `scripts/build/` — the four `build-<game>-wasm.sh` engine builds with their makefiles and
  `setup-toolchain.sh`, plus what the app build and the dev server load from here.
- `scripts/dev/` — tools run by hand: the bot gym, the offline and mobile previews,
  and `serve-www.mjs`.
- `scripts/browser-check/` — the render gates behind `npm run check:*`, real Chromium and
  none part of `npm test`, with their shared utils.
- `scripts/test/` — what `npm test` runs: the vitest unit tests (`*.test.ts`, one folder per
  Module or area, `tooling/` for the scripts themselves) and each Module's engine tests
  (`test-<game>-<name>.mjs`, run through `<game>.engine.ts`).
