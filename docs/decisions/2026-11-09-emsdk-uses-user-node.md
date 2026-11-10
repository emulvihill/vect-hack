## 2026-11-09 — Emscripten runs on the user's Node

**Decision:** `setup-toolchain.sh` installs only the pinned compiler
(`releases-<hash>-64bit`), not the full `sdk-6.0.4` bundle, and writes the
user's `node` into `external/emsdk/.emscripten` as `NODE_JS` once it passes
Emscripten's own `MINIMUM_NODE_VERSION` (read from the installed
`tools/shared.py`). The bundled Node (22.16.0, ~190 MB) is fetched only when no
usable Node exists, after a `y` at a prompt or with `--download-node`; with no
terminal it refuses.

**Why:** everyone running the setup already has Node, because `npm` needs it.
The bundled copy was a second Node nobody chose. `NODE_JS` is pinned to the
path that was checked: emsdk's default (any `nodejs` on PATH, else a bare
`node`) can pick up an old distro `nodejs` ahead of the one npm uses. The
Node only runs Emscripten's JS tools: `larn.wasm` built on Node 24.21.0 and on
the bundled 22.16.0 is byte-identical.
