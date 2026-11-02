#!/usr/bin/env bash
# Stage the immutable runtime seed for pinned Umoria 5.7.15.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 SOURCE_DIR SEED_DIR" >&2
  exit 2
fi

SOURCE_ARG="$1"
SEED_ARG="$2"
SCRIPT_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"

case "$SOURCE_ARG" in
  /*) ;;
  *) echo "stage-moria-seed: source must be an absolute path" >&2; exit 1 ;;
esac
case "$SEED_ARG" in
  /*) ;;
  *) echo "stage-moria-seed: destination must be an absolute path" >&2; exit 1 ;;
esac

MORIA="$(realpath -e -- "$SOURCE_ARG" 2>/dev/null || true)"
SEED="$(realpath -m -- "$SEED_ARG")"
EXPECTED_SEED="$SCRIPT_ROOT/build/moria/seed"
if [ -z "$MORIA" ] || [ ! -d "$MORIA" ]; then
  echo "stage-moria-seed: source is not an existing directory: $SOURCE_ARG" >&2
  exit 1
fi
if [ "$SEED" = "/" ] || [ "$SEED" != "$EXPECTED_SEED" ]; then
  echo "stage-moria-seed: refusing unsafe destination: $SEED_ARG" >&2
  echo "  expected exactly $EXPECTED_SEED" >&2
  exit 1
fi
case "$SEED/" in
  "$MORIA/"*) echo "stage-moria-seed: destination overlaps source: $SEED" >&2; exit 1 ;;
esac
case "$MORIA/" in
  "$SEED/"*) echo "stage-moria-seed: source overlaps destination: $MORIA" >&2; exit 1 ;;
esac
if [ -L "$SEED" ] || { [ -e "$SEED" ] && [ ! -d "$SEED" ]; }; then
  echo "stage-moria-seed: destination is not a replaceable directory: $SEED" >&2
  exit 1
fi

SEED_PARENT="$(dirname "$SEED")"
mkdir -p -- "$SEED_PARENT"
if [ "$(realpath -e -- "$SEED_PARENT")" != "$SCRIPT_ROOT/build/moria" ]; then
  echo "stage-moria-seed: destination parent resolves outside the build tree" >&2
  exit 1
fi
STAGED="$(mktemp -d "$SEED_PARENT/.moria-seed.XXXXXX")"
cleanup() {
  if [ -n "${STAGED:-}" ]; then
    rm -rf -- "$STAGED"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGED/data"
for file in help.txt help_wizard.txt rl_help.txt rl_help_wizard.txt \
  welcome.txt death_tomb.txt death_royal.txt; do
  cp "$MORIA/data/$file" "$STAGED/data/$file"
done
cp "$MORIA/data/scores.dat" "$STAGED/scores.dat"
cp "$MORIA/AUTHORS" "$MORIA/LICENSE" "$STAGED/"

version_header="$MORIA/src/version.h"
major="$(sed -nE 's/.*CURRENT_VERSION_MAJOR = ([0-9]+);.*/\1/p' "$version_header")"
minor="$(sed -nE 's/.*CURRENT_VERSION_MINOR = ([0-9]+);.*/\1/p' "$version_header")"
patch="$(sed -nE 's/.*CURRENT_VERSION_PATCH = ([0-9]+);.*/\1/p' "$version_header")"
if [ -z "$major" ] || [ -z "$minor" ] || [ -z "$patch" ]; then
  echo "stage-moria-seed: could not derive the version from src/version.h" >&2
  exit 1
fi
version="$major.$minor.$patch"
release_date="$(sed -nE "s/^## ${version//./\\.} \\(([0-9]{4}-[0-9]{2}-[0-9]{2})\\)$/\\1/p" "$MORIA/CHANGELOG.md" | head -n 1)"
if [ -z "$release_date" ]; then
  echo "stage-moria-seed: CHANGELOG.md has no release date for $version" >&2
  exit 1
fi
for file in splash.txt versions.txt; do
  sed -e "s/\${umoria_version}/$version/g" \
      -e "s/\${current_date}/$release_date/g" \
      "$MORIA/data/$file.in" > "$STAGED/data/$file"
done

EXPECTED_STAGE=(
  AUTHORS
  LICENSE
  data/death_royal.txt
  data/death_tomb.txt
  data/help.txt
  data/help_wizard.txt
  data/rl_help.txt
  data/rl_help_wizard.txt
  data/splash.txt
  data/versions.txt
  data/welcome.txt
  scores.dat
)
mapfile -t actual_stage < <(cd "$STAGED" && find . -type f -printf '%P\n' | LC_ALL=C sort)
if ! diff -u <(printf '%s\n' "${EXPECTED_STAGE[@]}") <(printf '%s\n' "${actual_stage[@]}"); then
  echo "stage-moria-seed: staged runtime tree differs from the literal allow-list" >&2
  exit 1
fi

rm -rf -- "$SEED"
mv -- "$STAGED" "$SEED"
STAGED=""
trap - EXIT

printf '%s\n' "$version"
