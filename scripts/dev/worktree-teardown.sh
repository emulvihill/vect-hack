#!/usr/bin/env bash
#
# Remove a finished worktree of this repo, safely.
#
#     scripts/dev/worktree-teardown.sh <worktree-path> [--discard]
#     scripts/dev/worktree-teardown.sh --list
#
# THE TRAP THIS EXISTS TO REMOVE. `git worktree remove` refuses a worktree
# whose submodules are initialized, and the obvious next move — `git submodule
# deinit` inside it — unregisters them in `.git/config`, which every worktree
# SHARES. The throwaway worktree goes away and the PRIMARY checkout is left
# with three unregistered submodules. The files survive, only the registration
# goes, and nothing says so: the next build fails somewhere unrelated.
#
# It is avoidable outright. `git worktree remove --force` removes a worktree
# with initialized submodules and never touches the shared config — git's own
# documentation says so ("ones with submodules can be removed with --force";
# the "--force twice" in the same page is about LOCKED worktrees and has
# nothing to do with submodules). Verified on git 2.53.0 against a scratch
# worktree with all three submodules checked out: removal succeeded and
# `git submodule status` in the primary was unchanged.
#
# So this script does not deinit anything. It guards what --force will
# otherwise discard without a second warning, removes, and then CHECKS the
# primary checkout — because the failure this is about is silent, and a
# teardown that only claims to be safe is worth nothing.
set -euo pipefail

primary=$(cd "$(dirname "$0")/../.." && pwd)
die() { echo "worktree-teardown.sh: $*" >&2; exit 1; }

# The primary is the first row of `git worktree list`; anything else is linked.
primary=$(git -C "$primary" worktree list --porcelain | head -1 | cut -d' ' -f2-)

if [ "${1:-}" = "--list" ] || [ $# -eq 0 ]; then
	echo "linked worktrees of $primary:"
	git -C "$primary" worktree list | tail -n +2 || true
	[ $# -eq 0 ] && echo && echo "usage: $0 <worktree-path> [--discard]"
	exit 0
fi

target=$(cd "$1" 2>/dev/null && pwd) || die "no such directory: $1"
discard=${2:-}

[ "$target" != "$primary" ] || die "$target is the PRIMARY checkout, not a worktree"
git -C "$primary" worktree list --porcelain | grep -qx "worktree $target" \
	|| die "$target is not a linked worktree of $primary"

branch=$(git -C "$target" branch --show-current || true)
echo "==> $target${branch:+ (branch $branch)}"

# --force discards these without asking twice, so they are asked about here.
# Submodule working trees are ignored on purpose: they are checkouts of pinned
# commits and carry nothing of ours.
if [ -n "$(git -C "$target" status --porcelain --ignore-submodules=all)" ]; then
	[ "$discard" = "--discard" ] || {
		git -C "$target" status --short --ignore-submodules=all >&2
		die "worktree has uncommitted changes; commit them or pass --discard"
	}
	echo "    --discard: dropping the uncommitted changes above"
fi

# UNVERSIONED DATA, which `git status` and the branch check are both blind to.
#
# This guard exists because its absence cost something real on 2026-08-29: a
# teardown took the worktree's `.gym/` with it, and with it 150 reflection
# transcripts — model outputs, not regenerable, named by two open beads as the
# corpus for scripts/dev/reflect-prompt-probe.mjs. Every gym batch in there was
# reproducible from a frozen seed master, which is exactly why nobody thought
# about the one thing that was not.
#
# The known build state is excluded by name: it is what worktree-setup.sh puts
# there and every bit of it regenerates from a build script.
KNOWN='^(node_modules|build|dist|public|external/emsdk|\.beads|\.preview|.*\.code-workspace)'
leftover=$(git -C "$target" status --porcelain --ignored 2>/dev/null \
	| sed -n 's/^!! //p' | sed 's:/$::' | grep -Ev "$KNOWN" || true)
if [ -n "$leftover" ]; then
	echo "    unversioned data this will delete:"
	while IFS= read -r p; do
		[ -e "$target/$p" ] && echo "      $(du -sh "$target/$p" 2>/dev/null | cut -f1)	$p"
	done <<<"$leftover"
	[ "$discard" = "--discard" ] || die "the paths above are ignored by git and exist nowhere else; copy what matters out, or pass --discard"
	echo "    --discard: deleting it"
fi

# The real "merge and push first" guard. An unmerged commit here is work that
# exists nowhere else, and the convention for it is a committed patch beside
# its bead rather than a branch left lying around.
if [ -n "$branch" ]; then
	unmerged=$(git -C "$primary" rev-list --count "main..$branch" 2>/dev/null || echo 0)
	if [ "$unmerged" -gt 0 ]; then
		[ "$discard" = "--discard" ] || {
			git -C "$primary" log --oneline "main..$branch" >&2
			die "$unmerged commit(s) above are not on main; merge and push first, or pass --discard"
		}
		echo "    --discard: abandoning $unmerged commit(s) not on main"
	fi
fi

echo "==> git worktree remove --force"
git -C "$primary" worktree remove --force "$target"

if [ -n "$branch" ]; then
	# -d, never -D: a branch that will not delete cleanly is one whose commits
	# are not on main, and the check above should already have caught it.
	if git -C "$primary" branch -d "$branch" 2>/dev/null; then
		echo "==> deleted branch $branch"
	else
		echo "==> kept branch $branch (not fully merged into main)"
	fi
fi

# The check the whole script is for. Damage to the shared submodule
# registration is invisible until a build fails somewhere else, so it is
# verified here rather than assumed — and repaired if it ever does happen,
# which re-registers without re-cloning.
echo "==> verifying the primary checkout's submodules"
if git -C "$primary" submodule status | grep -q '^-'; then
	echo "    UNREGISTERED submodules found — repairing" >&2
	git -C "$primary" submodule update --init --recursive
	git -C "$primary" submodule status | grep -q '^-' \
		&& die "submodules are still unregistered in $primary — repair by hand"
	echo "    repaired"
else
	git -C "$primary" submodule status | sed 's/^/    /'
	echo "    all registered"
fi
