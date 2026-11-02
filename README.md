# VectHack

Classic roguelike engines running as WebAssembly in Web Workers, presented as
glowing arcade-vector dungeons in Three.js. VectHack currently ships explicit
routes for official NetHack 5.0, Angband 4.2.6, BSD Larn 12.0, and official
Umoria 5.7.15. Game logic, AI, saves, and RNG remain in the native cores; the
TypeScript client owns their I/O adapters, shared CellGrid, renderer, cameras,
HUD, and browser persistence.

By Eric Mulvihill.

## Dedication

Dedicated to my old friend Ethan Sicotte, RIP. His devotion to winning these games inspired me to delve deeper, both then and now. We miss ya, dude.

## Architecture

```text
native game source -> Emscripten module -> Web Worker protocol
                                            |
                              terminal prompts + semantic CellGrid
                                            |
                       Three.js vector view / exact debug TTY
```

Every game is selected explicitly with `?game=nethack`, `?game=angband`,
`?game=larn`, or `?game=moria`. A URL without `game` redirects to NetHack while
preserving all other flags. Add `&view=debug` for the terminal view, `&gl` to
force WebGL, or `&skin=ghost` / `&skin=high-contrast` for another palette.

In game, **F2** switches orbital and first-person camera. The **Saves** button
bottom-left, **F3** and **F4** are the one save affordance every game shows:
F3 downloads the selected game's whole volume as one `.vhsave` file, F4 loads
one back, and a third row deletes the stored save outright. Pointing at any
cell names it, using the engine's own description.

## Requirements

The scripts assume a **Linux/GNU userland**: every `test:*` script wraps its
driver in GNU `timeout`, and all four WASM build scripts call `nproc`. Nothing
here has been run on macOS or Windows.

- Node 24 (what this is developed and tested on; the node test drivers import
  `.ts` sources directly) and npm.
- `git`, `bash`, `make`, `curl`, `sha256sum` — the build scripts fetch pinned
  sources and verify their digests.
- `python3`, for the Emscripten SDK's own installer.
- A GPU and a readable `/dev/dri/renderD*` for the browser gates only.
- `magick` (ImageMagick) is optional: without it `npm run preview` leaves its
  fixtures as `.ppm`/`.svg` instead of `.png`.

## Build and test

```bash
npm install
scripts/build/setup-toolchain.sh   # once: engine submodules + emsdk (gitignored)
npm run build:nethack
npm run build:angband
npm run build:larn
npm run build:moria

npm test                 # typecheck, unit tests, and every real-engine group
npm run test:moria       # one game's engine tests; the test:moria-* scripts in
                         #   package.json are the authority for what it runs
npm run preview          # offline orbital + first-person fixtures, no GPU
npm run dev              # http://localhost:5173
npm run serve:www        # build --base /play/ and serve the vecthack.com layout
```

`npm test` stops at the first failing group, and its exit code is what matters
— never pipe it. `docs/TESTS.md` says what each engine test pins.

Moria persists stock Ctrl-X saves and scores in a single-writer
`/vect-moria` volume, supports validated whole-volume export/import, and keeps
concurrent losing tabs visibly session-only. Its observationally pure turn-tail
checkpoints land as unique, awaited generations; reload falls back past a
corrupt newest generation without overriding a changed explicit save or
resurrecting a terminal character.

## Gates

```bash
npm run check:gates      # browser + controls + touch + angband-borg, in sequence
npm run check:payload    # per-game payload; needs no GPU and no server
```

`check:gates` starts and stops its own dev server on port 5199, and reports
three verdicts: green, red, and could-not-run (no render node, no Chromium, no
WebGPU/WebGL2). The gates it drives can also be run one at a time, and those
need a dev server already listening:

```bash
npm run dev -- --port 5199 --strictPort
npm run check:browser      # every vector game on WebGPU and WebGL
npm run check:controls     # live camera-relative controls and prompt isolation
npm run check:touch        # the ?touch scheme at 390x844, zero keyboard events
npm run check:angband-borg # ten minutes of unattended borg play, measured
```

None of them is part of `npm test`. `docs/GATES.md` says what each one asserts,
and what it deliberately does not.

## The Larn bot

```bash
npm run bot:headless -- --game larn --games 20   # N games in child processes -> .gym/
npm run bot:reflect -- --batch .gym/<dir>        # one model reflection per game
npm run bench:larn                               # the frozen 500-seed bench
```

`data/kb` ships empty by decision, not by omission: every knowledge base the
loop has earned so far lost depth on held-out seeds. `docs/BOT.md` has the
whole story.

## Working on the repo

`AGENTS.md` is the source of truth for contributors and coding agents;
`docs/PROJECT-MAP.md` is the directory-by-directory map. Work happens on a
branch in its own git worktree, and a fresh worktree has none of the build
state the tests need — run `scripts/dev/worktree-setup.sh` in it first, and
`scripts/dev/worktree-teardown.sh` to remove it afterwards.

## License

Original client code is MIT © Eric Mulvihill ([LICENSE](LICENSE)). The native
games and their covered adapters retain their respective licenses: NetHack
NGPL, Angband GPL-2.0-only, Umoria GPL-3.0-or-later, and Larn's original
no-profit permission. The built combined application is subject to the
applicable upstream terms. See [LICENSING.md](LICENSING.md) for the exact map
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled dependencies.
