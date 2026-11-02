#!/usr/bin/env bash
# Build Angband 4.2.6 to WebAssembly: public/modules/angband/angband.{js,wasm,data}.
# Prereq: external/emsdk installed+activated (scripts/build/setup-toolchain.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ANG="$ROOT/external/angband"
OUT="$ROOT/build/angband"
MK="$ROOT/scripts/build/angband-wasm.mk"

source "$ROOT/external/emsdk/emsdk_env.sh" >/dev/null

# The Angband commit this client is built and tested against (4.2.6-166).
# src/modules/angband/native/main-wasm.c replicates upstream main()'s startup
# sequence and fills the 4.2 ui-term hook set; a submodule bump can change
# either. Re-check main-wasm.c against src/main.c and src/ui-term.h before
# moving the pin. The submodule commit is the real pin; this guard makes a
# mismatch loud instead of subtle.
SUPPORTED_ANGBAND="f0f6bd223b6b9faf0072b0ae7ffb34a812b97349"
head="$(git -C "$ANG" rev-parse HEAD)"
if [ "$head" != "$SUPPORTED_ANGBAND" ]; then
  echo "build-angband-wasm: submodule is at $head; this client supports $SUPPORTED_ANGBAND." >&2
  echo "  Re-check src/modules/angband/native/main-wasm.c against upstream main.c and ui-term.h," >&2
  echo "  then update SUPPORTED_ANGBAND here." >&2
  exit 1
fi

# make tracks sources, not flags: if the makefile changes, every stale .o in
# the submodule silently keeps its old flags. Stamp the makefile and start
# over when it moves (build-nethack-wasm.sh precedent).
mkdir -p "$OUT"
STAMP="$OUT/.mk-sha"
mk_sha="$(sha256sum "$MK" | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$mk_sha" ]; then
  echo "--- makefile changed, discarding objects ---"
  find "$ANG/src" -name '*.o' -delete
  rm -f "$OUT/main-wasm.o" "$OUT"/angband.js "$OUT"/angband.wasm "$OUT"/angband.data
fi

# Stage the minimal lib/ VFS: gamedata, customize, help, screens — text
# only. NEVER lib/tiles, lib/sounds, lib/fonts, lib/icons: the Shockbolt
# 64x64 tileset is licensed non-commercial (external/angband/docs/
# copying.rst) and a vector renderer ships no tiles at all. Writable dirs
# (user/, save/, scores/, panic/) are not
# staged: emscripten's file packager skips empty directories, and
# create_needed_dirs() makes them in MEMFS at boot.
rm -rf "$OUT/stage"
mkdir -p "$OUT/stage/lib/gamedata" "$OUT/stage/lib/customize" \
         "$OUT/stage/lib/help" "$OUT/stage/lib/screens"
cp "$ANG"/lib/gamedata/*.txt "$OUT/stage/lib/gamedata/"
# Every customize pref except sound.prf: its header claims a Creative Commons
# non-commercial licence (the Dubtrain sound config), which cannot sit inside a
# GPL-2.0-only bundle. No sounds ship, so the file has no purpose here.
# pref.prf's `%:sound.prf` include survives the removal: the `%:` handler calls
# process_pref_file() with quiet=true and discards the result (ui-prefs.c:438).
for prf in "$ANG"/lib/customize/*.prf; do
  [ "$(basename "$prf")" = "sound.prf" ] && continue
  cp "$prf" "$OUT/stage/lib/customize/"
done
cp "$ANG"/lib/help/*.txt "$OUT/stage/lib/help/"
cp "$ANG"/lib/screens/*.txt "$OUT/stage/lib/screens/"

LOG="$OUT/build.log"
make -C "$ANG/src" -f "$MK" VECT_ROOT="$ROOT" -j"$(nproc)" "$OUT/angband.js" 2>&1 | tee "$LOG"
printf '%s' "$mk_sha" > "$STAMP"

# The CANARY in angband-wasm.mk, enforced rather than described. That file keeps
# `game_event_dispatch` on the Asyncify removelist *because it never resolves*:
# the symbol is static in 4.2.6, so the linker cannot match it and answers with a
# warning. If a toolchain change, LTO, or external linkage ever makes it resolve,
# the entry arms, the removelist takes a function that is on the stack across
# every suspend out of instrumentation, and the game hangs somewhere far from any
# of this. The warning disappearing is the only signal, so a build that links
# without printing it stops here. Checked only when a link actually ran — an
# up-to-date build prints nothing and proves nothing.
if grep -qE -- '-o .*angband\.js' "$LOG"; then
  if ! grep -qF "non-existing function name: 'game_event_dispatch'" "$LOG"; then
    echo "build-angband-wasm: the game_event_dispatch canary did not fire." >&2
    echo "  scripts/build/angband-wasm.mk keeps that name on ASYNCIFY_REMOVE only" >&2
    echo "  because it never resolves. It resolves now: delete the entry before" >&2
    echo "  shipping, or the Asyncify unwind is corrupt. See the CANARY comment." >&2
    exit 1
  fi
fi

# License hygiene is invisible in the artifact unless checked: the packaged
# file manifest lives in angband.js, and not one tile/sound/font/icon path
# may appear in it.
if grep -qaE 'lib/(tiles|sounds|fonts|icons)/' "$OUT/angband.js"; then
  echo "build-angband-wasm: asset carve-out violated — tiles/sounds/fonts/icons in the bundle" >&2
  exit 1
fi

# The path carve-out above only checks directories. sound.prf sits in
# lib/customize/ yet carries its own Creative Commons non-commercial header, so
# a path grep cannot see it — check the payload for the claim itself.
if grep -qa "Creative Commons non-commercial" "$OUT/angband.data"; then
  echo "build-angband-wasm: carve-out violated — CC-noncommercial text in angband.data" >&2
  exit 1
fi

# -DALLOW_BORG is equally invisible: without it the borg objects compile to empty
# translation units, the build succeeds, and the merge gate (vect-hack-3vk.4) has
# nothing to drive. borg-commands.c wraps its whole body in `#ifdef ALLOW_BORG`,
# so its command prompt is in the artifact exactly when the borg is.
if ! grep -qa "Borg command (? for help)" "$OUT/angband.wasm"; then
  echo "build-angband-wasm: ALLOW_BORG is not in the artifact" >&2; exit 1
fi

# No shipped byte may name the build machine (guard-host-paths.sh, vect-hack-uur5).
"$ROOT/scripts/build/guard-host-paths.sh" build-angband-wasm "$ROOT" -- \
  "$OUT/angband.js" "$OUT/angband.wasm" "$OUT/angband.data"

mkdir -p "$ROOT/public/modules/angband"
cp -f "$OUT/angband.js" "$OUT/angband.wasm" "$OUT/angband.data" "$ROOT/public/modules/angband/"

# vect_angband_describe (Look HUD, spec 2026-08-18) is EMSCRIPTEN_KEEPALIVE
# with no EXPORTED_FUNCTIONS list to add it to — the only proof it shipped is
# grepping for it in the artifact.
if ! grep -q "vect_angband_describe" "$ROOT/public/modules/angband/angband.js"; then
  echo "build-angband-wasm: vect_angband_describe was not exported" >&2; exit 1
fi

echo "--- artifacts ---"
ls -la "$ROOT/public/modules/angband"
