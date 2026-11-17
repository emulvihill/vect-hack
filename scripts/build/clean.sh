#!/usr/bin/env bash
# Delete every engine build output, so the next build compiles all four
# Modules from the checked-out sources. `npm run build` runs this first.
#
# Why: stage-licenses.mjs stamps dist/licenses/SOURCE.txt with HEAD, and vite
# copies whatever public/modules/ holds. An artifact built weeks ago from other
# sources would ship under a fresh stamp: a false corresponding-source claim
# (GPL/NGPL). Rebuilding from nothing on every build is the whole guard. The
# deploy preflight's clean-tree check then ties the working tree to HEAD.
# (A per-engine input fingerprint was the alternative; rejected, too costly.)
#
# Kept: the emsdk toolchain, node_modules, and NetHack's lib/ (the Lua source
# build-nethack-wasm.sh unpacks only after checking its sha256).
# Nested submodules (NetHack's lua, pdcurses) are left alone: `git clean -f`
# without a second -f skips nested repositories.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

rm -rf -- "$ROOT/build" "$ROOT/dist" "$ROOT/public/modules"
git -C "$ROOT/external/NetHack" clean -fdxq -e /lib/
for engine in angband larn umoria; do
  git -C "$ROOT/external/$engine" clean -fdxq
done

# Last, once nothing built is left: record HEAD and the tree's state, so
# release-bundle.mjs can say what the next engines were compiled from.
node "$ROOT/scripts/build/release-bundle.mjs" --cleaned
