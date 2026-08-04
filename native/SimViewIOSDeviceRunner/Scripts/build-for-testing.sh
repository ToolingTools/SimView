#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNNER_DIR=$(dirname "$SCRIPT_DIR")
DERIVED_DATA=${SIMVIEW_IOS_RUNNER_DERIVED_DATA:-"$RUNNER_DIR/build/DerivedData"}
TEAM=${SIMVIEW_DEVELOPMENT_TEAM:-}

if [ -z "$TEAM" ]; then
  echo "SIMVIEW_DEVELOPMENT_TEAM is required for a signed device build" >&2
  exit 2
fi

xcodebuild \
  -project "$RUNNER_DIR/SimViewIOSDeviceRunner.xcodeproj" \
  -scheme SimViewIOSDeviceRunner \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build-for-testing
