#!/usr/bin/env bash
# Build the pinned NetBSD Larn source to WebAssembly:
# public/modules/larn/larn.{js,wasm,data}.
# Prereq: external/emsdk installed+activated (scripts/build/setup-toolchain.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LARN="$ROOT/external/larn"
OUT="$ROOT/build/larn"
MK="$ROOT/scripts/build/larn-wasm.mk"

source "$ROOT/external/emsdk/emsdk_env.sh" >/dev/null

# external/larn is a submodule of github.com/emulvihill/netbsd-larn (NetBSD
# src/games/larn split out with its history). The submodule commit is the real
# pin; this guard makes a mismatch loud instead of subtle. The shim replicates
# upstream main()'s startup and replaces lflush/init_term/sigsetup, so a source
# bump can change any of those: re-check src/modules/larn/native/main-wasm.c
# against main.c, io.c (lflush) and signal.c (sigsetup) before moving it.
SUPPORTED_LARN="908b4c9ae116da6e6b069967fa25d4fdced1942f"
head="$(git -C "$LARN" rev-parse HEAD 2>/dev/null || true)"
if [ "$head" != "$SUPPORTED_LARN" ]; then
  echo "build-larn-wasm: submodule is at ${head:-not-a-git-checkout}; this client supports $SUPPORTED_LARN." >&2
  echo "  Re-check src/modules/larn/native/main-wasm.c against main.c, io.c (lflush)" >&2
  echo "  and signal.c (sigsetup), then update SUPPORTED_LARN here." >&2
  exit 1
fi
if [ -n "$(git -C "$LARN" status --short)" ]; then
  echo "build-larn-wasm: submodule has local modifications: $LARN" >&2
  git -C "$LARN" status --short >&2
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

# Stage the minimal lib/ VFS the engine opens at runtime:
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
