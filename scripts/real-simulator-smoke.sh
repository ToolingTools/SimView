#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PACKAGED_CORE="$ROOT/packages/core/bin/simview-core"
CORE="${SIMVIEW_CORE_BINARY:-$PACKAGED_CORE}"
OUTPUT="${TMPDIR:-/tmp}/simview-smoke.png"

if [ ! -x "$CORE" ]; then
  echo "SimView core is missing or not executable: $CORE" >&2
  exit 1
fi

UNIVERSAL_CORE="$ROOT/native/SimViewCore/.build/apple/Products/Release/simview-core"
if [ "$CORE" = "$PACKAGED_CORE" ] && [ -f "$UNIVERSAL_CORE" ]; then
  PACKAGED_HASH=$(shasum -a 256 "$PACKAGED_CORE" | awk '{print $1}')
  BUILT_HASH=$(shasum -a 256 "$UNIVERSAL_CORE" | awk '{print $1}')
  if [ "$PACKAGED_HASH" != "$BUILT_HASH" ]; then
    echo "Packaged simview-core is stale; run bun run release:build" >&2
    exit 1
  fi
fi

"$CORE" doctor
"$CORE" devices
"$CORE" screenshot --output "$OUTPUT"
test -s "$OUTPUT"
echo "Captured $OUTPUT"
