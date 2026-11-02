#!/usr/bin/env bash
# One-shot vendor of NetBSD games/larn into external/larn/ for the Larn
# Module spike. Not a build step — run once during the spike (Task 1) to
# drop the NetBSD snapshot into the tree, then commit it.
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