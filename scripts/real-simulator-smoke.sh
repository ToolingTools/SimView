#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CORE="$ROOT/native/SimViewCore/.build/release/simview-core"
OUTPUT="${TMPDIR:-/tmp}/simview-smoke.png"

"$CORE" doctor
"$CORE" devices
"$CORE" screenshot --output "$OUTPUT"
test -s "$OUTPUT"
echo "Captured $OUTPUT"
