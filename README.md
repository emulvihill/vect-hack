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

## Quick start

On a Linux machine with the [requirements](#requirements) installed:

```bash
git clone https://github.com/emulvihill/vect-hack.git
cd vect-hack
npm install
npm run setup    # once: engine sources, the Emscripten SDK, then all four engines
npm run dev      # http://localhost:5173/?game=nethack
```

**`npm run setup` is not optional.** The four game engines are C programs
compiled to WebAssembly on your machine; they are build output, not part of
the clone (`public/modules/` is gitignored). `npm install` and `npm run dev`
alone give you a page whose every game dies on load. `npm run dev` prints
`engine not built: …` at startup when any engine is missing.

`npm run setup` downloads the pinned Emscripten compiler (about 1.5 GB
installed, into `external/emsdk/`; it runs on your Node) and the engine
sources, then builds the engines. The download dominates; the four builds took
about a minute on an 8-core machine. After a `git pull` that touches an
engine's native code or build script, rebuild that one engine
(`npm run build:<game>`) or all of them (`npm run build:engines`).

Then open one game per URL:

| Game | URL |
|---|---|
| NetHack 5.0 | http://localhost:5173/?game=nethack |
| Angband 4.2.6 | http://localhost:5173/?game=angband |
| BSD Larn 12.0 | http://localhost:5173/?game=larn |
| Umoria 5.7.15 | http://localhost:5173/?game=moria |

## Requirements

The scripts assume a **Linux/GNU userland**: every `test:*` script wraps its
driver in GNU `timeout`, and all four WASM build scripts call `nproc`. Nothing
here has been run on macOS or Windows.

- **Node 24** and npm. `.nvmrc` pins it (`nvm use`); the node test drivers
  import `.ts` sources directly, so older Node fails.
- **A host C compiler** (`cc`, `ar`, `make`): NetHack builds its data-file
  tools (`makedefs`, `dlb`) natively before it cross-compiles the game.
- `git`, `bash`, `curl`, `sha256sum`: the build scripts fetch pinned sources
  and verify their digests.
- `python3`, for the Emscripten SDK's own installer.
- About 2 GB of free disk for the SDK and build objects.
- A browser with WebGPU or WebGL2. Without either, the game falls back to the
  terminal view.
- Optional: a GPU with a readable `/dev/dri/renderD*` for the render gates, and
  `magick` (ImageMagick) so `npm run preview` writes `.png` instead of
  `.ppm`/`.svg`.

On Debian or Ubuntu, everything but Node is
`sudo apt install build-essential git curl python3`.

## Commands

Every command runs from the repo root. They fall into six groups.

### Play and develop

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on http://localhost:5173 with hot reload. Needs the engines built. |
| `npm run dev -- --port 5199 --strictPort` | The same on another port; the render gates expect 5199. |

**Hot reload restarts the game.** Editing anything under `src/` while a game
is open reloads the page and reboots the engine, and an unsaved run is gone.

### Build the engines

| Command | What it does |
|---|---|
| `npm run setup` | First-time setup: `setup:toolchain`, then `build:engines`. |
| `npm run setup:toolchain` | Engine submodules plus the pinned Emscripten SDK. Safe to rerun. |
| `npm run build:engines` | All four engines below, in order. |
| `npm run build:nethack` | NetHack -> `public/modules/nethack/` |
| `npm run build:angband` | Angband -> `public/modules/angband/` |
| `npm run build:larn` | Larn -> `public/modules/larn/` |
| `npm run build:moria` | Umoria -> `public/modules/moria/` |

Each build script also checks what its artifact cannot prove afterwards
(licence carve-outs, exported symbols, no build-machine paths) and stops
without copying anything into `public/modules/` when a check fails.

### Build a deployable site

| Command | What it does |
|---|---|
| `npm run build` | Static production build in `dist/`, served from `/`. Copies whatever engines `public/modules/` holds, so build them first. |
| `VH_BASE=/play/ npm run build` | The same for a site served under a sub-path. |
| `npx vite preview` | Serves `dist/` on http://localhost:4173 to check a build. |
| `npm run serve:www` | Builds for `/play/` and serves the vecthack.com layout on http://127.0.0.1:8080. The landing page comes from a `vect-hack-www` checkout beside this repo (`VH_SITE=<dir>` overrides); without one, only `/play/` works. |

`dist/` is plain static files: any web server works, and the engines need no
special headers.

### Test

| Command | What it does |
|---|---|
| `npm test` | Everything below in sequence: typecheck, unit tests, then every engine's tests. Needs all four engines built. |
| `npm run typecheck` | `tsc` over the whole tree, no emit. |
| `npm run lint` | ESLint over the JavaScript under `scripts/`. |
| `npm run test:render` | Vitest unit tests: every game's adapters and the shared layers. Needs no engine. |
| `npm run test:<game>` | One engine's tests against the real WASM build, e.g. `npm run test:moria`. |

`npm test` stops at the first failing group, and its exit code is what matters
— never pipe it. `docs/TESTS.md` says what each engine test pins.
`.github/workflows/ci.yml` runs only the parts that need no engine build and
no GPU: lint, typecheck, `test:render` and `check:payload`.

### Render gates (real Chromium)

| Command | What it does |
|---|---|
| `npm run check:gates` | All gates in sequence; starts and stops its own dev server on 5199. |
| `npm run check:payload` | Each `?game=` loads only its own game's code. Needs no GPU and no server. |
| `npm run check:browser` | Every vector game on WebGPU and WebGL, plus the fallbacks. |
| `npm run check:controls` | Camera-relative controls against a live game. |
| `npm run check:touch` | The `?touch` scheme on a 390x844 phone viewport. |
| `npm run check:angband-borg` | Ten minutes of unattended Angband borg play, measured. |

None of these is part of `npm test`. Run alone, every gate but
`check:payload` needs a dev server already listening on 5199. Each reports
green, red, or could-not-run (no render node, no Chromium, no WebGPU/WebGL2).
`docs/GATES.md` says what each asserts, and what it deliberately does not.

### Previews and the Larn bot

| Command | What it does |
|---|---|
| `npm run preview` | Renders still images of the scene and radar to `.preview/`. No browser, no GPU. Not a web server: that is `npx vite preview`. |
| `npm run preview:mobile` | Phone-sized screenshots of all four games to `.preview/mobile-*.png`. |
| `npm run bot:headless -- --game larn --games 20` | Plays N Larn games in child processes at full speed, writing to `.gym/`. |
| `npm run bench:larn` | The frozen 500-seed Larn bench. |

The bot is deterministic and learns nothing: its knobs are hand-tuned
constants. `docs/BOT.md` has the whole story.

## Playing

### URL flags

Every game is chosen with `?game=`; a URL without it redirects to
`?game=nethack`, keeping the other flags. Flags combine with `&`, e.g.
`?game=angband&borg&gl`.

| Flag | Effect |
|---|---|
| `?game=nethack` / `angband` / `larn` / `moria` | Which game to run. |
| `&view=debug` | The exact terminal view instead of the 3D one. |
| `&gl` | Force WebGL instead of WebGPU. |
| `&skin=quadrascan` / `ghost` / `high-contrast` | Colour palette; remembered in localStorage. |
| `&bot` / `&bot=fast` / `&bot=<ms>` | Let the self-playing bot play, at one turn a second, flat out, or at a chosen pace. |
| `&borg` / `&borg=<ms>` | Angband only: hand the game to Angband's built-in borg. |
| `&touch` | NetHack only: on-screen thumb pad and action bar for phones. |
| `&trace` | Log every windowport call (the engine's screen I/O) to the console. |

`docs/UI.md` describes each in full.

### Keys and saves

- Each game keeps its own native keys. Arrow keys and the keypad move relative
  to the screen in the 3D view; keypad 5 turns the camera back to north.
- **F2** switches between the orbital and first-person camera. Function keys
  belong to the client and never reach the game.
- Pointing at any cell names it, using the engine's own description.
- Games save in the browser automatically. The **Saves** button (bottom left)
  exports the selected game's whole save volume as one `.vhsave` file (**F3**),
  loads one back (**F4**), or deletes the stored save outright.
  `docs/SAVES.md` has the details, including what a second tab of the same
  game does.

## Troubleshooting

**"The \<Game\> engine died — … error loading dynamically imported module …
/modules/\<game\>/\<game\>.js"** (Firefox), or "Failed to fetch dynamically
imported module" (Chrome): that engine is not built. Run
`npm run build:<game>`, or `npm run setup` on a fresh clone, then reload. The
running dev server picks the new files up without a restart. The message's
suggestion to delete the stored save does not apply here.

**`npm install` warns `EBADENGINE`, or a test driver fails on TypeScript
syntax:** Node is older than 24. `node -v` must print v24 or later.

**The NetHack build prints `make: *** … Error 2` lines and then succeeds:**
expected. Its first `make` pass runs in parallel and races in upstream's
makefile; a serial second pass finishes the job. The script's exit code is the
verdict.

**A build stops with `submodule is at …; this client supports …`:** an engine
submodule moved off its pin. `git submodule update --init` restores it.

**The page is black or shows only the terminal view:** the browser offers
neither WebGPU nor WebGL2. Check `chrome://gpu` (or `about:support` in
Firefox) for hardware acceleration.

## Architecture

```text
native game source -> Emscripten module -> Web Worker protocol
                                            |
                              terminal prompts + semantic CellGrid
                                            |
                       Three.js vector view / exact debug TTY
```

Each game is a Module under `src/modules/<game>/`: a worker hosting the WASM
engine, an I/O adapter, and its views. `src/backplane/` is the shared session,
persistence and protocol layer, `src/render/` the shared Three.js renderer,
and `src/skins/` the single source of every colour. `docs/PROJECT-MAP.md` maps
every directory.

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
