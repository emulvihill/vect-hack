#!/usr/bin/env bash
# Install (or remove) the nightly gate timer, the way task-llama's
# security-sweep pair is installed: the timer unit stays in the repo and
# ~/.config/systemd/user/ holds a symlink to it, so editing it here is editing
# the installed one. The service unit is rendered from the tracked template
# (`@REPO@` becomes this checkout's absolute path), because ExecStart needs an
# absolute path and the repo may live anywhere.
#
# Run this from the PRIMARY checkout. A symlink into a worktree breaks the
# moment that worktree is removed, and the rendered ExecStart would point at a
# tree that no longer exists.
#
#   scripts/dev/install-gate-timer.sh              install and start the timer
#   scripts/dev/install-gate-timer.sh --uninstall  stop it and remove the units
set -euo pipefail

units_dir="$HOME/.config/systemd/user"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

# In the primary checkout --git-dir and --git-common-dir name the same
# directory; in a linked worktree --git-dir is .git/worktrees/<name>.
git_dir="$(git -C "$here" rev-parse --path-format=absolute --git-dir)"
common_dir="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
if [ "$git_dir" != "$common_dir" ]; then
  echo "refusing: run this from the primary checkout, not the worktree at $repo" >&2
  echo "the timer is symlinked, and a link into a worktree dies with it" >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now vect-hack-gates.timer || true
  rm -f "$units_dir/vect-hack-gates.timer" "$units_dir/vect-hack-gates.service"
  systemctl --user daemon-reload
  echo "removed vect-hack-gates.timer and .service"
  exit 0
fi

mkdir -p "$units_dir"
sed "s#@REPO@#$repo#g" "$here/vect-hack-gates.service" > "$units_dir/vect-hack-gates.service"
ln -sfn "$here/vect-hack-gates.timer" "$units_dir/vect-hack-gates.timer"
systemctl --user daemon-reload
systemctl --user enable --now vect-hack-gates.timer
systemctl --user list-timers vect-hack-gates.timer --no-pager
echo
echo "one run by hand:   systemctl --user start vect-hack-gates.service"
echo "what it did:       journalctl --user -u vect-hack-gates.service -n 50"
echo "artifacts:         ~/.local/state/vect-hack/gates/"
