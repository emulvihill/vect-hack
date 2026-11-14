#!/usr/bin/env bash
# Vendors NetBSD games/larn into external/larn/, the Larn Module's engine
# source. Not a build step: the snapshot is committed, and this is how it was
# fetched (2026-08-06, external/larn/README.vect-hack). It pulls
# NetBSD-current, so a rerun can move the source set; build-larn-wasm.sh then
# refuses to build until LARN_PIN is re-checked. datfiles/ is not fetched here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/external/larn"
BASE="https://cdn.netbsd.org/pub/NetBSD/NetBSD-current/src/games/larn"
FILES="action.c bill.c config.c create.c data.c diag.c display.c extern.h
fortune.c global.c header.h help.c io.c main.c monster.c moreobj.c movem.c
nap.c object.c pathnames.h regen.c savelev.c scores.c signal.c store.c tok.c
Makefile README COPYRIGHT"
mkdir -p "$DEST"
for f in $FILES; do
  curl -fsS --max-time 30 -o "$DEST/$f" "$BASE/$f"
  printf 'ok %s %s bytes\n' "$f" "$(wc -c < "$DEST/$f")"
done