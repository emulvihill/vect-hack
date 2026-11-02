#!/usr/bin/env bash
# Build the NetBSD Larn snapshot to WebAssembly:
# public/modules/larn/larn.{js,wasm,data}.
# Prereq: external/emsdk installed+activated (scripts/build/setup-toolchain.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LARN="$ROOT/external/larn"
OUT="$ROOT/build/larn"
MK="$ROOT/scripts/build/larn-wasm.mk"

source "$ROOT/external/emsdk/emsdk_env.sh" >/dev/null

# The vendored NetBSD Larn snapshot this client is built and tested against
# (spike §2). external/larn is a vendored directory (not a submodule), so the
# pin is a sha256 of the engine source set rather than a git commit. File
# ordering is explicitly C-locale so this guard has one digest on every host.
# A mismatch is loud rather than subtle: the shim replicates upstream main()'s
# startup and replaces lflush/init_term/sigsetup, so a source bump can change
# any of those. Re-check src/modules/larn/native/main-wasm.c against
# external/larn/main.c, external/larn/io.c (lflush) and external/larn/signal.c
# (sigsetup) before moving this pin. The set includes README.vect-hack, our own
# distribution note: 94f9331 rewrote it for licensing and left this digest
# behind, so the build refused every source it was still correct about. No .c,
# .h or datfile has moved since the pin was written — that re-check is a no-op.
# Moved again on 2026-10-22 for the same reason: README.vect-hack dropped a
# pointer to a research doc removed before publication; nothing else changed.
# Moved again on 2026-11-02: publication rewrote README.vect-hack's two
# docs/superpowers/ paths to docs/specs/ and left this digest behind, so a
# fresh clone of the public tree could not build Larn. Only that README moved.
LARN_PIN="3201cabc9c79632ae02d2261fa0681d2876a5108e1dc82874029b3c5d707a58d"
pin="$(find "$LARN" -type f \( -name '*.c' -o -name '*.h' -o -name 'README' -o -name 'README.vect-hack' -o -name 'COPYRIGHT' -o -name 'Makefile' -o -path '*/datfiles/*' \) | LC_ALL=C sort | xargs cat | sha256sum | cut -d' ' -f1)"
if [ "$pin" != "$LARN_PIN" ]; then
  echo "build-larn-wasm: external/larn source set is at $pin" >&2
  echo "  this client supports $LARN_PIN." >&2
  echo "  Re-check src/modules/larn/native/main-wasm.c against external/larn/" >&2
  echo "  main.c, io.c (lflush) and signal.c (sigsetup), then update LARN_PIN here." >&2
  exit 1
fi

# make tracks sources, not flags: if the makefile changes, every stale .o in
# build/larn silently keeps its old flags. Stamp the makefile and start over
# when it moves (build-nethack-wasm.sh / build-angband-wasm.sh precedent).
mkdir -p "$OUT"
STAMP="$OUT/.mk-sha"
mk_sha="$(sha256sum "$MK" | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$mk_sha" ]; then
  echo "--- makefile changed, discarding objects ---"
  rm -f "$OUT"/*.o "$OUT"/larn.js "$OUT"/larn.wasm "$OUT"/larn.data
fi

# Stage the minimal lib/ VFS the engine opens at runtime (spike §10):
#   larn.help  on-line help text (? command, _PATH_HELP -> /lib/larn.help)
#   larnmaze   pre-made dungeon level data (_PATH_LEVELS -> /lib/larnmaze)
# Fortunes are inlined in fortune.c (no larn.ftn); the .larnopts sample is a
# writable user file (the engine reads $HOME/.larnopts under the volume), not
# a staged lib/ file. Larn predates tiles/sounds/fonts — the asset carve-out
# grep below is the discipline that those never appear, not a leak to catch.
# Writable dirs (home/scores/tmp) are seeded under /lib/ at boot by
# mountLarnStorage (src/modules/larn/persist.ts), not staged here.
rm -rf "$OUT/stage"
mkdir -p "$OUT/stage/lib"
cp "$LARN"/datfiles/larn.help "$LARN"/datfiles/larnmaze "$OUT/stage/lib/"

LOG="$OUT/build.log"
make -f "$MK" VECT_ROOT="$ROOT" -j"$(nproc)" "$OUT/larn.js" 2>&1 | tee "$LOG"
printf '%s' "$mk_sha" > "$STAMP"

# License hygiene is invisible in the artifact unless checked: the packaged
# file manifest lives in larn.js, and not one tile/sound/font/icon path may
# appear in it (the Angband carve-out discipline; Larn carries none of these,
# so a leak here would mean a future revision silently dragged assets in).
if grep -qaE 'lib/(tiles|sounds|fonts|icons)/' "$OUT/larn.js"; then
  echo "build-larn-wasm: asset carve-out violated — tiles/sounds/fonts/icons in the bundle" >&2
  exit 1
fi

# EMSCRIPTEN_KEEPALIVE is invisible in the artifact unless checked, and a
# describer that never got exported reads exactly like an engine with nothing
# to say. Placed beside the asset carve-out grep, before the copy step.
if ! grep -q "vect_larn_describe" "$OUT/larn.js"; then
  echo "build-larn-wasm: vect_larn_describe was not exported" >&2; exit 1
fi

# No shipped byte may name the build machine (guard-host-paths.sh, vect-hack-uur5).
"$ROOT/scripts/build/guard-host-paths.sh" build-larn-wasm "$ROOT" -- \
  "$OUT/larn.js" "$OUT/larn.wasm" "$OUT/larn.data"

mkdir -p "$ROOT/public/modules/larn"
cp -f "$OUT/larn.js" "$OUT/larn.wasm" "$OUT/larn.data" "$ROOT/public/modules/larn/"

echo "--- artifacts ---"
ls -la "$ROOT/public/modules/larn"
