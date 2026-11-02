#!/usr/bin/env bash
# Build official NetHack 5.0 to WebAssembly (targets/wasm in the submodule).
# Prereq: external/emsdk installed+activated (scripts/setup-toolchain.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NH="$ROOT/external/NetHack"

source "$ROOT/external/emsdk/emsdk_env.sh" >/dev/null

if [ ! -f "$NH/Makefile" ]; then
  (cd "$NH/sys/unix" && sh setup.sh hints/linux.500)
fi

# Lua, fetched here rather than by `make fetch-lua`. Upstream's fetch-Lua
# recipe (Makefile:2226) computes a sha256 and then throws the answer away: the
# check statement is terminated with `;`, `tar zxf` runs whatever it said, and
# the recipe closes with `true`. The invocation is wrong on its own terms too —
# `--ignore-missing` passes silently when the name is not in the list, and
# `-c FILE < tarball` is not how sha256sum reads its target. So a tampered
# tarball from any of the three mirrors would be compiled straight into
# nethack.wasm behind a printed warning. The hash it declines to enforce is
# already in submodules/CHKSUMS; this enforces it, and treats every way of
# failing to check as a failure.
fetch_lua() {
  local version tarball expected actual dir tmp url

  version="$(sed -n 's/^LUA_VERSION[[:space:]]*[?:]*=[[:space:]]*\([0-9.]*\).*/\1/p' \
             "$NH/Makefile" | tail -1)"
  if [ -z "$version" ]; then
    echo "build-nethack-wasm: no LUA_VERSION in $NH/Makefile" >&2; exit 1
  fi
  dir="$NH/lib/lua-$version"
  # Already unpacked by a previous verified run. Upstream re-downloads on every
  # build; there is nothing to gain from doing that once the bytes are checked.
  [ -f "$dir/src/lua.h" ] && return 0

  command -v sha256sum >/dev/null \
    || { echo "build-nethack-wasm: sha256sum is required to verify Lua" >&2; exit 1; }

  tarball="lua-$version.tar.gz"
  expected="$(awk -v f="$tarball" '$2 == f { print $1 }' "$NH/submodules/CHKSUMS")"
  if [ -z "$expected" ]; then
    echo "build-nethack-wasm: no checksum for $tarball in external/NetHack/submodules/CHKSUMS" >&2
    exit 1
  fi

  tmp="$(mktemp -d)"
  for url in "https://www.lua.org/ftp/$tarball" \
             "https://www.tecgraf.puc-rio.br/lua/mirror/ftp/$tarball" \
             "https://www.nethack.org/download/thirdparty/$tarball"; do
    echo "--- fetching $url ---"
    curl -fsSL -R -o "$tmp/$tarball" "$url" && break
  done
  if [ ! -s "$tmp/$tarball" ]; then
    rm -rf "$tmp"
    echo "build-nethack-wasm: could not download $tarball from any mirror" >&2; exit 1
  fi

  actual="$(sha256sum "$tmp/$tarball" | cut -d' ' -f1)"
  if [ "$actual" != "$expected" ]; then
    rm -rf "$tmp"
    echo "build-nethack-wasm: $tarball failed its integrity check — not unpacking it." >&2
    echo "  expected $expected (external/NetHack/submodules/CHKSUMS)" >&2
    echo "  got      $actual" >&2
    exit 1
  fi
  echo "--- $tarball matches its recorded sha256 ---"

  mkdir -p "$NH/lib"
  tar -xzf "$tmp/$tarball" -C "$NH/lib"
  rm -rf "$tmp"
  # The rest of upstream's recipe (Makefile:2265), and worth keeping: a header
  # generated against one Lua must not survive the version that replaced it.
  rm -f "$NH/include/nhlua.h"
}
fetch_lua

# EMCC_CFLAGS replaces the hints default (-Wall -Werror -DNO_SIGNAL -O3): newer
# emscripten clang trips warnings upstream's older compiler predates (e.g.
# -Wunused-but-set-global in files.c), so -Werror must go. Caution: make exports
# command-line vars, and the emcc driver reads EMCC_CFLAGS from the environment
# too, appending it to every internal sub-invocation (incl. file_packager's asm
# step) — so these flags must stay harmless there: no -Werror, and unused-argument
# warnings silenced.
#
# SELF_RECOVER turns on recover_savefile() (src/files.c) and the "Recover [r]"
# branch of getlock(), which is how a game whose tab was closed comes back. The
# unix hints ask for it (hints/linux.500), but cross-pre2.500 does
# `override CFLAGS = $(WASM_CFLAGS)` and drops NHCFLAGS on the floor, so the
# wasm target has to be told separately. It is purely additive: no struct, no
# savefile field and no critical size is conditional on it.
EMCC_CFLAGS="-Wall -DNO_SIGNAL -O3 -Wno-unused-command-line-argument -DSELF_RECOVER"

# save_currentstate() (src/do.c) is NetHack's non-destructive checkpoint — it
# rewrites the current level file and level.0 without freeing live state, which
# is what lets src/modules/nethack/checkpoint.ts snapshot a game that is still being
# played. Upstream's export list has to be restated to add it: the link line is
# `$(TARGET_CC) $(TARGET_LFLAGS) $(TARGET_CFLAGS)` (src/Makefile) and
# TARGET_CFLAGS starts with EMCC_CFLAGS, so ours lands after theirs and wins.
# Assert the inherited four still match, or a submodule bump could silently drop
# an export that the bridge needs. The comma form is deliberate: make expands
# EMCC_CFLAGS unquoted into the compiler command, so a flag containing spaces
# would be split into several arguments.
# The NetHack release this client is built and tested against. src/modules/nethack/
# recoverSave.ts rebuilds a save file in TypeScript from NetHack's own on-disk
# layout, so a version bump can change bytes we depend on: stop and re-check
# that port (and whether libnhmain.c has since learned to clear
# program_state.in_self_recover, which is why the port exists) before moving
# the pin. The submodule commit is the real pin; this is the readable half.
SUPPORTED_NETHACK="5.0.0"
built_version="$(awk '
  /^#define VERSION_MAJOR/ { major = $3 }
  /^#define VERSION_MINOR/ { minor = $3 }
  /^#define PATCHLEVEL/    { patch = $3 }
  END { print major "." minor "." patch }
' "$NH/include/patchlevel.h")"
if [ "$built_version" != "$SUPPORTED_NETHACK" ]; then
  echo "build-nethack-wasm: submodule is NetHack $built_version, this client supports $SUPPORTED_NETHACK." >&2
  echo "  Re-check src/modules/nethack/recoverSave.ts against util/recover.c and sys/libnh/libnhmain.c," >&2
  echo "  then update SUPPORTED_NETHACK here." >&2
  exit 1
fi

UPSTREAM_EXPORTS='"_main", "_shim_graphics_set_callback", "_repopulate_perminvent", "_malloc"'
if ! grep -qF "EXPORTED_FUNCTIONS='[$UPSTREAM_EXPORTS]'" \
     "$NH/sys/unix/hints/include/cross-pre2.500"; then
  echo "build-nethack-wasm: upstream EXPORTED_FUNCTIONS changed; update this script" >&2
  grep -n "EXPORTED_FUNCTIONS" "$NH/sys/unix/hints/include/cross-pre2.500" >&2
  exit 1
fi
EMCC_CFLAGS="$EMCC_CFLAGS -sEXPORTED_FUNCTIONS=_main,_shim_graphics_set_callback"
EMCC_CFLAGS="$EMCC_CFLAGS,_repopulate_perminvent,_malloc,_free,_save_currentstate"
EMCC_CFLAGS="$EMCC_CFLAGS,_do_screen_description"

# make tracks sources, not flags, so editing EMCC_CFLAGS above leaves every stale
# .o in place and the change silently does nothing. Stamp the flags and start
# over when they move.
STAMP="$NH/targets/wasm/.emcc-cflags"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$EMCC_CFLAGS" ]; then
  echo "--- build flags changed, discarding objects ---"
  rm -f "$NH"/targets/wasm/*.o "$NH"/targets/wasm/*.a \
        "$NH/targets/wasm/nethack.js" "$NH/targets/wasm/nethack.wasm"
fi

# Parallel pass for the bulk compile (top-level Makefile has install-step ordering
# races under -j), then a serial pass to converge deterministically.
make -C "$NH" CROSS_TO_WASM=1 EMCC_CFLAGS="$EMCC_CFLAGS" -j"$(nproc)" || true
make -C "$NH" CROSS_TO_WASM=1 EMCC_CFLAGS="$EMCC_CFLAGS"

# The embed may carry only what the engine never writes: nhdat, license,
# symbols. Upstream's install step also touches the runtime-writable files
# (sysconf, perm, and the score files) into wasm-data, but every one of those
# is seeded by src/modules/nethack at boot — sysconf/perm as root files, the
# score files as symlinks into the persistent volume. Since emsdk's
# _emscripten_fs_load_embedded_files runs at initRuntime (AFTER preRun and the
# volume mount), an embedded copy of a seeded path throws EEXIST and the
# engine never boots. Whether those files reach wasm-data at all depends on an
# upstream install-step race, so prune them and relink via the src-level
# target, whose PREGAME only mkdirs wasm-data and cannot repopulate it.
PRUNED=0
for f in sysconf perm record logfile xlogfile livelog; do
  if [ -e "$NH/targets/wasm/wasm-data/$f" ]; then
    rm -f "$NH/targets/wasm/wasm-data/$f"
    PRUNED=1
  fi
done
if [ "$PRUNED" = 1 ]; then
  echo "--- relinking without runtime-writable embeds ---"
  rm -f "$NH/targets/wasm/nethack.js" "$NH/targets/wasm/nethack.wasm"
  make -C "$NH/src" CROSS_TO_WASM=1 EMCC_CFLAGS="$EMCC_CFLAGS" ../targets/wasm/nethack.js
fi
for f in nhdat license symbols; do
  if [ ! -e "$NH/targets/wasm/wasm-data/$f" ]; then
    echo "build-nethack-wasm: wasm-data/$f missing — the embed would ship without game data" >&2
    exit 1
  fi
done
mkdir -p "$(dirname "$STAMP")" && printf '%s' "$EMCC_CFLAGS" > "$STAMP"

# Both additions above are invisible in the artifact unless checked. "Cannot
# recover savefile" only exists inside #ifdef SELF_RECOVER (src/files.c), and a
# dropped export would not surface until checkpoint.ts called it at runtime.
if ! grep -qa "Cannot recover savefile" "$NH/targets/wasm/nethack.wasm"; then
  echo "build-nethack-wasm: SELF_RECOVER is not in the artifact" >&2; exit 1
fi
if ! grep -q "_save_currentstate" "$NH/targets/wasm/nethack.js"; then
  echo "build-nethack-wasm: _save_currentstate was not exported" >&2; exit 1
fi
if ! grep -q "_do_screen_description" "$NH/targets/wasm/nethack.js"; then
  echo "build-nethack-wasm: _do_screen_description was not exported" >&2; exit 1
fi
# Quoted, unlike the two above: a bare _free also matches _freelocale and the
# other libc names emscripten links in, so the guard would pass on an artifact
# that had dropped the export. describeScreenCell() would then throw in its
# finally, answerDescribeRequest() would swallow it, and the Look HUD would be
# blank with nothing saying why.
if ! grep -q '"_free"' "$NH/targets/wasm/nethack.js"; then
  echo "build-nethack-wasm: _free was not exported" >&2; exit 1
fi

# No shipped byte may name the build machine (guard-host-paths.sh, vect-hack-uur5).
"$ROOT/scripts/build/guard-host-paths.sh" build-nethack-wasm "$ROOT" -- \
  "$NH/targets/wasm/nethack.js" "$NH/targets/wasm/nethack.wasm"

mkdir -p "$ROOT/public/modules/nethack"
cp -f "$NH/targets/wasm/nethack.js" "$NH/targets/wasm/nethack.wasm" "$ROOT/public/modules/nethack/"

echo "--- artifacts ---"
ls -la "$ROOT/public/modules/nethack"
