#!/usr/bin/env bash
# Build pinned Umoria 5.7.15 to public/modules/moria/moria.{js,wasm,data}.
# Prereq: external/emsdk installed (scripts/build/setup-toolchain.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MORIA="$ROOT/external/umoria"
OUT="$ROOT/build/moria"
MK="$ROOT/scripts/build/moria-wasm.mk"
STAGER="$ROOT/scripts/build/stage-moria-seed.sh"
EMSDK="$ROOT/external/emsdk"
STAGE_ONLY=0

usage() {
  echo "usage: $0 [--stage-only] [--source-dir PATH]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage-only)
      STAGE_ONLY=1
      shift
      ;;
    --source-dir)
      if [ "$#" -lt 2 ]; then usage; exit 2; fi
      MORIA="$(cd -- "$2" && pwd)"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

SUPPORTED_MORIA="3bf8abc4f76812810e59d738492c7b61fb8f1bb6"
SUPPORTED_EMSDK="224ec5f9f2f72f09f9ce0e26d66bae7dbd8b692f"
SUPPORTED_EMSCRIPTEN="6.0.4"
head="$(git -C "$MORIA" rev-parse HEAD 2>/dev/null || true)"
if [ "$head" != "$SUPPORTED_MORIA" ]; then
  echo "build-moria-wasm: source is at ${head:-not-a-git-checkout}; this client supports $SUPPORTED_MORIA." >&2
  echo "  Re-audit main-wasm.cpp, ui_io_wasm.cpp, the source list and runtime seed before moving the pin." >&2
  exit 1
fi

emsdk_head="$(git -C "$EMSDK" rev-parse HEAD 2>/dev/null || true)"
if [ "$emsdk_head" != "$SUPPORTED_EMSDK" ]; then
  echo "build-moria-wasm: emsdk is at ${emsdk_head:-not-a-git-checkout}; expected $SUPPORTED_EMSDK." >&2
  exit 1
fi
if [ -n "$(git -C "$EMSDK" status --short)" ]; then
  echo "build-moria-wasm: emsdk checkout has local modifications: $EMSDK" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$EMSDK/emsdk_env.sh" >/dev/null
empp="$(command -v em++ || true)"
expected_empp="$EMSDK/upstream/emscripten/em++"
if [ -z "$empp" ] || [ "$(realpath -e -- "$empp" 2>/dev/null || true)" != "$(realpath -e -- "$expected_empp" 2>/dev/null || true)" ]; then
  echo "build-moria-wasm: activated em++ does not come from the pinned SDK: ${empp:-missing}" >&2
  exit 1
fi
empp_version="$(em++ --version | sed -nE '1s/.* ([0-9]+\.[0-9]+\.[0-9]+) \(.*/\1/p')"
if [ "$empp_version" != "$SUPPORTED_EMSCRIPTEN" ]; then
  echo "build-moria-wasm: em++ identifies as ${empp_version:-unknown}; expected $SUPPORTED_EMSCRIPTEN." >&2
  exit 1
fi
if [ -n "$(git -C "$MORIA" status --short)" ]; then
  echo "build-moria-wasm: source checkout has local modifications: $MORIA" >&2
  git -C "$MORIA" status --short >&2
  exit 1
fi

NATIVE_MAIN="$ROOT/src/modules/moria/native/main-wasm.cpp"
NATIVE_UI="$ROOT/src/modules/moria/native/ui_io_wasm.cpp"
NATIVE_SEMANTIC="$ROOT/src/modules/moria/native/semantic-wasm.cpp"
NATIVE_SEMANTIC_HEADER="$ROOT/src/modules/moria/native/semantic-wasm.h"
NATIVE_CHECKPOINT="$ROOT/src/modules/moria/native/checkpoint-wasm.cpp"
NATIVE_CHECKPOINT_HEADER="$ROOT/src/modules/moria/native/checkpoint-wasm.h"
NATIVE_GAME_SAVE="$ROOT/src/modules/moria/native/game-save-wasm.cpp"
for input in "$MK" "$STAGER" "$NATIVE_MAIN" "$NATIVE_UI" "$NATIVE_SEMANTIC" "$NATIVE_SEMANTIC_HEADER" \
  "$NATIVE_CHECKPOINT" "$NATIVE_CHECKPOINT_HEADER" "$NATIVE_GAME_SAVE"; do
  if [ ! -f "$input" ]; then
    echo "build-moria-wasm: missing build input: $input" >&2
    exit 1
  fi
done

mkdir -p "$OUT"
STAGE_STAMP="$OUT/.build-inputs-sha"
FULL_STAMP="$OUT/.successful-build-sha"
CANARY="$OUT/.asyncify-canary-sha"
ASYNCIFY_LOG="$OUT/asyncify.log"
COMPILE_STAMP="$OUT/.full-compile-sha"
COMPILE_LOG="$OUT/build.log"
ARTIFACT_MANIFEST="$OUT/.artifact-sha256"

remove_link_outputs() {
  rm -f -- "$OUT/moria.js" "$OUT/moria.wasm" "$OUT/moria.data" \
    "$CANARY" "$ASYNCIFY_LOG" "$FULL_STAMP" "$ARTIFACT_MANIFEST"
}

# Stage exactly the immutable seed volume. The later persistence layer copies
# this tree into /vect-moria before making that writable volume the cwd.
SEED="$OUT/seed"
version="$("$STAGER" "$MORIA" "$SEED")"

# make tracks source mtimes, not compile/link flags or preload-file contents.
# Fingerprint every project-owned build input plus the staged bytes themselves.
# The generator script hash catches output-preserving logic changes; the seed
# digest independently catches any byte change caused by templates or tools.
# Either one relinks packaged data, just as flags/native changes recompile.
# BEGIN seed-content-fingerprint
seed_sha="$(cd "$SEED" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
# END seed-content-fingerprint
fingerprint="$({
  printf '%s\n' "pin=$SUPPORTED_MORIA" "emsdk=$SUPPORTED_EMSDK" "em++=$empp_version" "seed=$seed_sha"
  sha256sum "$ROOT/scripts/build/build-moria-wasm.sh" "$MK" "$STAGER" "$NATIVE_MAIN" "$NATIVE_UI" \
    "$NATIVE_SEMANTIC" "$NATIVE_SEMANTIC_HEADER" "$NATIVE_CHECKPOINT" \
    "$NATIVE_CHECKPOINT_HEADER" "$NATIVE_GAME_SAVE"
} | sha256sum | cut -d' ' -f1)"

artifact_manifest_contents() {
  local extension artifact_sha
  printf 'fingerprint %s\n' "$fingerprint"
  for extension in js wasm data; do
    artifact_sha="$(sha256sum "$OUT/moria.$extension" | cut -d' ' -f1)"
    printf '%s  moria.%s\n' "$artifact_sha" "$extension"
  done
}

if [ ! -f "$STAGE_STAMP" ] || [ "$(cat "$STAGE_STAMP")" != "$fingerprint" ]; then
  echo "--- Moria build inputs changed, discarding objects ---"
  rm -rf -- "$OUT/obj"
  rm -f -- "$COMPILE_STAMP" "$COMPILE_LOG"
  remove_link_outputs
fi

printf '%s' "$fingerprint" > "$STAGE_STAMP"
if [ "$STAGE_ONLY" -eq 1 ]; then
  echo "OK(stage): Umoria $version seed staged from $SUPPORTED_MORIA"
  exit 0
fi

FULL_COMPILE_REQUIRED=0
if [ ! -f "$COMPILE_STAMP" ] || [ "$(cat "$COMPILE_STAMP")" != "$fingerprint" ] || \
   [ ! -f "$COMPILE_LOG" ]; then
  rm -rf -- "$OUT/obj"
  remove_link_outputs
  FULL_COMPILE_REQUIRED=1
fi
if [ ! -f "$FULL_STAMP" ] || [ "$(cat "$FULL_STAMP")" != "$fingerprint" ]; then
  remove_link_outputs
fi
for extension in js wasm data; do
  if [ ! -s "$OUT/moria.$extension" ]; then
    echo "--- incomplete Moria artifact set, forcing relink ---"
    remove_link_outputs
    break
  fi
done
if [ -s "$OUT/moria.js" ] && [ -s "$OUT/moria.wasm" ] && [ -s "$OUT/moria.data" ] && \
   { [ ! -f "$ARTIFACT_MANIFEST" ] || \
     ! diff -q <(artifact_manifest_contents) "$ARTIFACT_MANIFEST" >/dev/null; }; then
  echo "--- Moria artifact hashes do not match the successful build, forcing relink ---"
  remove_link_outputs
fi

CURRENT_LOG="$OUT/build.current.log"
if ! make -f "$MK" VECT_ROOT="$ROOT" MORIA_SOURCE="$MORIA" \
  -j"$(nproc)" "$OUT/moria.js" 2>&1 | tee "$CURRENT_LOG"; then
  remove_link_outputs
  exit 1
fi

require_asyncify_canaries() {
  local log="$1"
  local diagnostic
  while IFS= read -r diagnostic; do
    [ -n "$diagnostic" ] || continue
    if ! grep -qF -- "$diagnostic" "$log"; then
      echo "build-moria-wasm: missing Asyncify diagnostic: $diagnostic" >&2
      return 1
    fi
  done <<'EOF'
[asyncify] wasm_wait_key is an import that can change the state
[asyncify] (anonymous namespace)::readBlockingKey(bool) can change the state due to wasm_wait_key
[asyncify] wasm_poll_key is an import that can change the state
[asyncify] flushInputBuffer() can change the state due to wasm_poll_key
[asyncify] vectMoriaGameRunKeyInput() can change the state due to (anonymous namespace)::readBlockingKey(bool)
[asyncify] wasm_before_exit is an import that can change the state
[asyncify] exitProgram() can change the state due to wasm_before_exit
[asyncify] wasm_checkpoint_landed is an import that can change the state
[asyncify] vectMoriaGameRunUpdateMonsters(bool) can change the state due to wasm_checkpoint_landed
EOF
}

if grep -qF '[asyncify]' "$CURRENT_LOG"; then
  if ! require_asyncify_canaries "$CURRENT_LOG"; then
    echo "build-moria-wasm: fresh Asyncify diagnostics do not cover every native suspend path." >&2
    remove_link_outputs
    exit 1
  fi
  cp "$CURRENT_LOG" "$ASYNCIFY_LOG"
  printf '%s' "$fingerprint" > "$CANARY"
elif [ ! -f "$FULL_STAMP" ] || [ "$(cat "$FULL_STAMP")" != "$fingerprint" ] || \
     [ ! -f "$CANARY" ] || [ "$(cat "$CANARY")" != "$fingerprint" ] || \
     [ ! -f "$ASYNCIFY_LOG" ] || \
     ! require_asyncify_canaries "$ASYNCIFY_LOG"; then
  echo "build-moria-wasm: no complete current Asyncify suspend-path canary; force a clean link." >&2
  remove_link_outputs
  exit 1
fi
echo "OK(asyncify): input, poll, checkpoint durability and pre-exit paths are instrumented"

for extension in js wasm data; do
  artifact="$OUT/moria.$extension"
  if [ ! -s "$artifact" ]; then
    echo "build-moria-wasm: missing or empty artifact: $artifact" >&2
    remove_link_outputs
    exit 1
  fi
done

if ! grep -q "_moria_describe" "$OUT/moria.js"; then
  echo "build-moria-wasm: _moria_describe was not exported" >&2
  remove_link_outputs
  exit 1
fi

# No shipped byte may name the build machine (guard-host-paths.sh, vect-hack-uur5).
if ! "$ROOT/scripts/build/guard-host-paths.sh" build-moria-wasm "$ROOT" "$MORIA" -- \
  "$OUT/moria.js" "$OUT/moria.wasm" "$OUT/moria.data"; then
  remove_link_outputs
  exit 1
fi

if [ "$(git -C "$MORIA" rev-parse HEAD)" != "$SUPPORTED_MORIA" ] || \
   [ -n "$(git -C "$MORIA" status --short)" ]; then
  echo "build-moria-wasm: source checkout changed during the build" >&2
  remove_link_outputs
  exit 1
fi

if [ "$FULL_COMPILE_REQUIRED" -eq 1 ]; then
  if diff -q \
    <({ find "$MORIA/src" -maxdepth 1 -type f -name '*.cpp' \
          ! -name main.cpp ! -name ui_io.cpp ! -name game_save.cpp -printf '%p\n'; \
        printf '%s\n' "$NATIVE_MAIN" "$NATIVE_UI" "$NATIVE_SEMANTIC" \
          "$NATIVE_CHECKPOINT" "$NATIVE_GAME_SAVE"; } | LC_ALL=C sort) \
    <(sed -nE 's/^em\+\+ .* -c ([^ ]+)$/\1/p' "$CURRENT_LOG" | LC_ALL=C sort) \
    >/dev/null; then
    cp "$CURRENT_LOG" "$COMPILE_LOG"
    printf '%s' "$fingerprint" > "$COMPILE_STAMP"
  fi
fi

PUBLIC_PARENT="$ROOT/public/modules"
PUBLIC="$PUBLIC_PARENT/moria"
VERSIONS="$PUBLIC_PARENT/moria-versions"
mkdir -p "$VERSIONS"
PUBLISH_TMP="$(mktemp -d "$VERSIONS/.moria.publish.XXXXXX")"
LINK_TMP_DIR=""
PREVIOUS=""
cleanup_publish() {
  if [ -n "${PREVIOUS:-}" ] && [ -e "$PREVIOUS" ] && \
     [ ! -e "$PUBLIC" ] && [ ! -L "$PUBLIC" ]; then
    if mv -T -- "$PREVIOUS" "$PUBLIC"; then
      PREVIOUS=""
    else
      echo "build-moria-wasm: could not restore previous public directory: $PREVIOUS" >&2
    fi
  fi
  if [ -n "${PUBLISH_TMP:-}" ]; then
    rm -rf -- "$PUBLISH_TMP"
  fi
  if [ -n "${LINK_TMP_DIR:-}" ]; then
    rm -rf -- "$LINK_TMP_DIR"
  fi
}
trap cleanup_publish EXIT
cp -f -- "$OUT/moria.js" "$OUT/moria.wasm" "$OUT/moria.data" "$PUBLISH_TMP/"
for extension in js wasm data; do
  if [ ! -s "$PUBLISH_TMP/moria.$extension" ]; then
    echo "build-moria-wasm: incomplete publication candidate: moria.$extension" >&2
    exit 1
  fi
done
chmod 0755 "$PUBLISH_TMP"

VERSION_NAME="moria-$fingerprint"
VERSION_DIR="$VERSIONS/$VERSION_NAME"
if [ -d "$VERSION_DIR" ] && [ ! -L "$VERSION_DIR" ] && \
   cmp -s "$PUBLISH_TMP/moria.js" "$VERSION_DIR/moria.js" && \
   cmp -s "$PUBLISH_TMP/moria.wasm" "$VERSION_DIR/moria.wasm" && \
   cmp -s "$PUBLISH_TMP/moria.data" "$VERSION_DIR/moria.data"; then
  rm -rf -- "$PUBLISH_TMP"
  PUBLISH_TMP=""
elif [ -e "$VERSION_DIR" ] || [ -L "$VERSION_DIR" ]; then
  VERSION_NAME="moria-$fingerprint-$$"
  VERSION_DIR="$VERSIONS/$VERSION_NAME"
  mv -T -- "$PUBLISH_TMP" "$VERSION_DIR"
  PUBLISH_TMP=""
else
  mv -T -- "$PUBLISH_TMP" "$VERSION_DIR"
  PUBLISH_TMP=""
fi
chmod 0755 "$VERSION_DIR"

LINK_TMP_DIR="$(mktemp -d "$PUBLIC_PARENT/.moria-link.XXXXXX")"
ln -s -- "moria-versions/$VERSION_NAME" "$LINK_TMP_DIR/moria"
if [ -d "$PUBLIC" ] && [ ! -L "$PUBLIC" ]; then
  PREVIOUS="$(mktemp -d "$PUBLIC_PARENT/.moria.previous.XXXXXX")"
  rmdir -- "$PREVIOUS"
  mv -T -- "$PUBLIC" "$PREVIOUS"
  if ! mv -fT -- "$LINK_TMP_DIR/moria" "$PUBLIC"; then
    if mv -T -- "$PREVIOUS" "$PUBLIC"; then
      PREVIOUS=""
    else
      echo "build-moria-wasm: publication failed and the previous directory could not be restored: $PREVIOUS" >&2
    fi
    exit 1
  fi
  rm -rf -- "$PREVIOUS"
  PREVIOUS=""
else
  # rename(2) replaces the previous pointer atomically. Not `mv -T`: the new
  # link's relative target (moria-versions/...) dangles from inside
  # $LINK_TMP_DIR, and uutils mv follows both links, sees a non-directory
  # going onto a directory, and refuses. GNU mv just does the rename(2).
  python3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' \
    "$LINK_TMP_DIR/moria" "$PUBLIC"
fi
rmdir -- "$LINK_TMP_DIR"
LINK_TMP_DIR=""

for candidate in "$VERSIONS"/moria-*; do
  [ -e "$candidate" ] || continue
  [ "$candidate" != "$VERSION_DIR" ] || continue
  name="$(basename "$candidate")"
  if [[ ! "$name" =~ ^moria-[0-9a-f]{64}(-[0-9]+)?$ ]] || \
     [ ! -d "$candidate" ] || [ -L "$candidate" ]; then
    continue
  fi
  if diff -q \
    <(printf '%s\n' 'moria.data:f' 'moria.js:f' 'moria.wasm:f') \
    <(find "$candidate" -mindepth 1 -maxdepth 1 -printf '%f:%y\n' | LC_ALL=C sort) \
    >/dev/null; then
    rm -rf -- "$candidate"
  fi
done

trap - EXIT

artifact_manifest_tmp="$OUT/.artifact-sha256.tmp.$$"
if ! artifact_manifest_contents > "$artifact_manifest_tmp" || \
   ! mv -fT -- "$artifact_manifest_tmp" "$ARTIFACT_MANIFEST"; then
  rm -f -- "$artifact_manifest_tmp"
  echo "build-moria-wasm: could not publish the successful artifact hash manifest" >&2
  exit 1
fi
printf '%s' "$fingerprint" > "$FULL_STAMP"

echo "--- artifacts ---"
ls -la "$PUBLIC"
