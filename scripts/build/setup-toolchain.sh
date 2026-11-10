#!/usr/bin/env bash
# One-time toolchain setup: submodules + Emscripten SDK (external/emsdk, gitignored).
# Usage: setup-toolchain.sh [--download-node]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

download_node=0
for arg in "$@"; do
  case "$arg" in
    --download-node) download_node=1 ;;
    *) echo "setup-toolchain: unknown argument '$arg' (only --download-node)" >&2; exit 2 ;;
  esac
done

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

# The full SDK (`emsdk install $EMSDK_VERSION`) bundles its own Node, ~190 MB,
# that Emscripten runs its JS tools on. This project already needs Node for
# npm, so install only the compiler and point Emscripten at the user's Node.
# The bundled Node is downloaded only when there is no usable Node, and only
# after a yes: at the prompt, or up front with --download-node (parsed above).
releases_hash="$(python3 -c 'import json, sys
print(json.load(open(sys.argv[1]))["releases"][sys.argv[2]])' \
  "$EMSDK/emscripten-releases-tags.json" "$EMSDK_VERSION")"
COMPILER="releases-$releases_hash-64bit"
"$EMSDK/emsdk" install "$COMPILER"

# Emscripten's own floor, read from the compiler just installed so a pin move
# cannot leave a stale copy here.
SHARED_PY="$EMSDK/upstream/emscripten/tools/shared.py"
min_node="$(sed -n 's/^MINIMUM_NODE_VERSION = (\([0-9]*\), *\([0-9]*\), *\([0-9]*\)).*/\1.\2.\3/p' "$SHARED_PY")"
if [ -z "$min_node" ]; then
  echo "setup-toolchain: no MINIMUM_NODE_VERSION in $SHARED_PY; the check below would be guessing." >&2
  exit 1
fi

user_node="$(command -v node || true)"
user_node_version=""
if [ -n "$user_node" ]; then
  user_node_version="$("$user_node" -p process.versions.node 2>/dev/null || true)"
fi

if [ -n "$user_node_version" ] &&
   printf '%s\n%s\n' "$min_node" "$user_node_version" | sort -V -C; then
  "$EMSDK/emsdk" activate "$COMPILER"
  # emsdk writes NODE_JS as any `nodejs` on PATH, else a bare 'node' looked up
  # at build time; pin the one that was just checked instead.
  python3 - "$EMSDK/.emscripten" "$user_node" <<'PY'
import re, sys
path, node = sys.argv[1], sys.argv[2]
cfg = open(path).read()
cfg, n = re.subn(r"^NODE_JS = .*$", lambda _: f"NODE_JS = {node!r}", cfg, flags=re.M)
if n != 1:
    sys.exit(f"setup-toolchain: expected one NODE_JS line in {path}, found {n}")
open(path, "w").write(cfg)
PY
  echo "setup-toolchain: Emscripten uses your Node $user_node_version ($user_node)."
  if [ -d "$EMSDK/node" ]; then
    echo "  The bundled Node from an earlier setup is unused now; 'rm -rf $EMSDK/node' frees it."
  fi
  exit 0
fi

if [ -n "$user_node_version" ]; then
  echo "setup-toolchain: your Node $user_node_version ($user_node) is older than Emscripten's minimum $min_node." >&2
else
  echo "setup-toolchain: no Node on PATH." >&2
fi
if [ "$download_node" = 0 ]; then
  if [ -t 0 ]; then
    read -r -p "Download Emscripten's bundled Node (~190 MB) into external/emsdk? [y/N] " answer
    case "$answer" in [yY]|[yY][eE][sS]) download_node=1 ;; esac
  else
    echo "  Not a terminal, so not asking: rerun with --download-node to fetch it." >&2
  fi
fi
if [ "$download_node" = 0 ]; then
  echo "setup-toolchain: install Node $min_node or later (this project wants 24, see .nvmrc) and rerun." >&2
  exit 1
fi
# The full SDK: the compiler is already installed, so this fetches only its Node.
"$EMSDK/emsdk" install "$EMSDK_VERSION"
"$EMSDK/emsdk" activate "$EMSDK_VERSION"
