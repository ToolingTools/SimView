#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec bun "$repository/scripts/build-android-agent.ts"
