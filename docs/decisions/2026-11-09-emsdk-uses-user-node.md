## 2026-11-09 — Emscripten runs on the user's Node

**Decision:** `setup-toolchain.sh` installs only the pinned compiler
(`releases-<hash>-64bit`), not the full `sdk-6.0.4` bundle with its own Node
(22.16.0, ~190 MB). With no Node active, emsdk sets `NODE_JS` to the one on
PATH. No `node` on PATH stops setup before anything is downloaded.

**Why:** everyone running setup already has Node, because `npm` needs it; the
bundled copy was a second one nobody chose. A version check, a download prompt
and a `--download-node` fallback were tried first and dropped as more machinery
than a missing-Node case deserves. The Node only runs Emscripten's JS tools:
`larn.wasm` built on Node 24.21.0 and on the bundled 22.16.0 is byte-identical.
