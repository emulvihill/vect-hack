#!/usr/bin/env bash
# gate-run.mjs under gpu-reserve. A red gate is a finished run, so the GPU is
# released and the gate's code comes back in $rcfile. 3 is "could not run".
cd "$(dirname "$0")/../.." || exit 3
rcfile=$(mktemp) || exit 3
trap 'rm -f "$rcfile"' EXIT
export rcfile
# shellcheck disable=SC2016 # $? and $rcfile are the inner bash's to expand
gpu-reserve run --profile exclusive-gpu --purpose 'vect-hack gates' -- \
  bash -c 'node scripts/browser-check/gate-run.mjs; echo $? > "$rcfile"' || exit 3
read -r rc < "$rcfile" && [[ $rc =~ ^[0-9]+$ ]] || exit 3
exit "$rc"
