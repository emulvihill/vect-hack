#!/usr/bin/env bash
#
# Make a fresh git worktree of this repo runnable.
#
# A worktree checks out the tracked files and nothing else, and almost
# everything `npm test` needs here is untracked: node_modules, the emsdk
# toolchain, four Modules' WASM artifacts, and the three engine submodules.
# Each missing piece surfaces as a crash partway through a twenty-minute suite,
# one at a time, so discovering them by running the tests costs an hour.
#
#     scripts/dev/worktree-setup.sh [primary-checkout]
#
# `primary-checkout` defaults to the worktree's own main checkout, which is what
# `git worktree list` reports first. Everything it copies is a build output that
# a build script could regenerate; copying is here because regenerating all four
# Modules takes far longer than the fix usually does. Rebuild whichever Module
# you are actually changing — this script does not know which that is, and a
# stale artifact that looks fresh is worse than an absent one.
set -euo pipefail

here=$(cd "$(dirname "$0")/../.." && pwd)
primary=${1:-$(git -C "$here" worktree list --porcelain | head -1 | cut -d' ' -f2-)}

if [ "$primary" = "$here" ]; then
	echo "worktree-setup.sh: $here is the primary checkout; nothing to do" >&2
	exit 0
fi
[ -d "$primary" ] || { echo "worktree-setup.sh: no primary checkout at $primary" >&2; exit 1; }

echo "==> submodules (empty in a fresh worktree)"
git -C "$here" submodule update --init --recursive

echo "==> node_modules"
# The directory alone proves nothing: a tool run before this script (npx walks
# up to the primary checkout) can leave an empty one behind.
[ -f "$here/node_modules/.package-lock.json" ] || (cd "$here" && npm install --no-audit --no-fund)

# A symlink, not a copy: emsdk is ~2GB and its installed SDK carries absolute
# paths from where it was set up, so a second copy is both wasteful and a
# second thing to keep current.
echo "==> external/emsdk -> $primary/external/emsdk"
if [ -d "$primary/external/emsdk/upstream/emscripten" ]; then
	ln -sfn "$primary/external/emsdk" "$here/external/emsdk"
else
	echo "    (not installed in the primary checkout either — run scripts/build/setup-toolchain.sh)"
fi

echo "==> Module artifacts"
mkdir -p "$here/public/modules"
for m in nethack angband larn moria moria-versions; do
	if [ -d "$primary/public/modules/$m" ]; then
		cp -r "$primary/public/modules/$m" "$here/public/modules/"
		echo "    $m"
	else
		echo "    $m: not built in the primary checkout — run its build script"
	fi
done

# The published artifacts are not the whole of a build. Moria's engine tests
# read the object tree the build left behind (build/moria/obj/upstream) to prove
# what was compiled from where, so a worktree with moria.wasm and no build/
# fails partway through test:moria-play with an ENOENT rather than a verdict.
echo "==> build/ intermediates"
mkdir -p "$here/build"
for m in angband larn moria; do
	[ -d "$primary/build/$m" ] && cp -r "$primary/build/$m" "$here/build/" && echo "    $m"
done

# NetHack alone builds INTO its submodule rather than into public/modules, so a
# submodule checkout does not bring it and test-nethack-boot.mjs imports it by
# path. Every other Module's build output already landed above.
echo "==> external/NetHack/targets/wasm"
if [ -f "$primary/external/NetHack/targets/wasm/nethack.js" ]; then
	mkdir -p "$here/external/NetHack/targets"
	cp -r "$primary/external/NetHack/targets/wasm" "$here/external/NetHack/targets/"
else
	echo "    not built in the primary checkout — run scripts/build/build-nethack-wasm.sh"
fi

echo
echo "Ready. Rebuild the Module you are changing before trusting its tests:"
echo "  npm run build:larn | build:moria | scripts/build/build-{nethack,angband}-wasm.sh"
