#!/usr/bin/env bash
# One-time toolchain setup: submodules + Emscripten SDK (external/emsdk, gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

git -C "$ROOT" submodule update --init external/NetHack
git -C "$ROOT" submodule update --init external/angband
git -C "$ROOT" submodule update --init external/umoria

# The compiler is part of the artifact, so it is pinned like any other
# dependency: `install latest` would bake whatever emscripten published this
# morning into nethack.wasm, and nobody could reproduce the build afterwards.
# Both the SDK version and the installer checkout that fetches it are pinned,
# and the tag is verified against the commit it resolved to when it was chosen
# — a retagged upstream should stop setup rather than quietly hand over a
# different compiler. To move the pin: check the emscripten release notes,
# update both values together, and rebuild from clean (build-nethack-wasm.sh discards
# objects on a flag change, not on a toolchain change).
EMSDK_VERSION="6.0.4"
EMSDK_COMMIT="224ec5f9f2f72f09f9ce0e26d66bae7dbd8b692f"
EMSDK="$ROOT/external/emsdk"

if [ ! -d "$EMSDK/.git" ]; then
  git clone --depth 1 --branch "$EMSDK_VERSION" \
    https://github.com/emscripten-core/emsdk.git "$EMSDK"
elif [ "$(git -C "$EMSDK" rev-parse HEAD)" != "$EMSDK_COMMIT" ]; then
  # An existing checkout, or one an earlier setup left on main. The SDK itself
  # lives in paths emsdk gitignores (upstream/, node/, .emscripten), so moving
  # the checkout does not disturb an installed toolchain.
  git -C "$EMSDK" fetch --force --depth 1 origin \
    "refs/tags/$EMSDK_VERSION:refs/tags/$EMSDK_VERSION"
  git -C "$EMSDK" checkout --quiet --detach "$EMSDK_VERSION"
fi

emsdk_head="$(git -C "$EMSDK" rev-parse HEAD)"
if [ "$emsdk_head" != "$EMSDK_COMMIT" ]; then
  echo "setup-toolchain: emsdk $EMSDK_VERSION is $emsdk_head, not the pinned $EMSDK_COMMIT." >&2
  echo "  Upstream retagged, or the checkout was moved by hand. Verify before" >&2
  echo "  updating EMSDK_COMMIT — this guard is the only thing checking it." >&2
  exit 1
fi

"$EMSDK/emsdk" install "$EMSDK_VERSION"
"$EMSDK/emsdk" activate "$EMSDK_VERSION"
