#!/usr/bin/env bash
# Refuse a shipped artifact that names the machine it was built on.
#   guard-host-paths.sh <label> <dir>... -- <artifact>...
# Emscripten bakes the -o path into the glue as the .data package name, and
# __FILE__ under an absolute source path lands in the wasm. Either discloses
# the builder's username and layout to every player and makes the artifact
# unreproducible elsewhere (vect-hack-uur5). The bytes are the only witness,
# so every build script runs this on what it is about to publish. Each <dir>
# (the checkout, an out-of-tree source) is checked as given and as resolved.
set -euo pipefail

usage() {
  echo "usage: $0 <label> <dir>... -- <artifact>..." >&2
  exit 2
}

[ "$#" -ge 4 ] || usage
label="$1"
shift

# $HOME too: a worktree's emsdk links back to the primary checkout, which only
# $HOME covers. A trailing slash keeps $HOME=/home/x from matching /home/xy; a
# $HOME of / would match everything.
needles=()
if [ -n "${HOME:-}" ] && [ "$HOME" != "/" ]; then
  needles+=("${HOME%/}/")
fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  needles+=("$1" "$(cd -- "$1" && pwd -P)")
  shift
done
[ "$#" -ge 2 ] || usage
shift

status=0
for artifact in "$@"; do
  # grep reads a directory or a missing file as "no match" once its error is
  # swallowed, so an artifact that is not a readable file is a failure here.
  if [ ! -f "$artifact" ] || [ ! -r "$artifact" ]; then
    echo "$label: not a readable artifact: $artifact" >&2
    status=1
    continue
  fi
  for needle in "${needles[@]}"; do
    rc=0
    grep -qaF -- "$needle" "$artifact" || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "$label: $(basename -- "$artifact") contains the build-machine path $needle" >&2
      status=1
      break
    elif [ "$rc" -ne 1 ]; then
      echo "$label: could not scan $artifact" >&2
      status=1
      break
    fi
  done
done
exit "$status"
