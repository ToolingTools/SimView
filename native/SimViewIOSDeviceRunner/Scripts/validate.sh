#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNNER_DIR=$(dirname "$SCRIPT_DIR")
DERIVED_DATA=${SIMVIEW_IOS_RUNNER_VALIDATION_DIR:-"$RUNNER_DIR/build/Validation"}

xcrun swift-format lint --strict "$RUNNER_DIR"/Sources/*.swift "$RUNNER_DIR"/Tests/*.swift
xcrun clang-format --dry-run --Werror \
  "$RUNNER_DIR/Sources/PrivateScreenshotShim.h" \
  "$RUNNER_DIR/Sources/PrivateScreenshotShim.m"

VALIDATION_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/simview-ios-runner-validation.XXXXXX")
trap 'rm -rf "$VALIDATION_TEMP"' EXIT HUP INT TERM
xcrun swiftc \
  -module-cache-path "$VALIDATION_TEMP/ModuleCache" \
  "$RUNNER_DIR/Sources/RunnerProtocol.swift" \
  "$RUNNER_DIR/Tests/ProtocolValidationMain.swift" \
  -o "$VALIDATION_TEMP/protocol-validation"
"$VALIDATION_TEMP/protocol-validation"

xcodebuild \
  -project "$RUNNER_DIR/SimViewIOSDeviceRunner.xcodeproj" \
  -scheme SimViewIOSDeviceRunner \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build-for-testing

if /usr/bin/grep -R -E -i \
  '(^|[^[:alnum:]])(WebDriverAgent|Appium|go-ios|libimobiledevice|libusb|quicktime_video_hack|QVH)([^[:alnum:]]|$)' \
  "$RUNNER_DIR/Sources" "$RUNNER_DIR/SimViewIOSDeviceRunner.xcodeproj"; then
  echo "Runner sources contain a forbidden third-party dependency reference" >&2
  exit 1
fi

RUNNER_BINARY="$DERIVED_DATA/Build/Products/Debug-iphoneos/SimViewIOSDeviceRunner-Runner.app/PlugIns/SimViewIOSDeviceRunner.xctest/SimViewIOSDeviceRunner"
if otool -L "$RUNNER_BINARY" | /usr/bin/grep -E -i \
  '(WebDriverAgent|Appium|go-ios|libimobiledevice|libusb|quicktime_video_hack|QVH)'; then
  echo "Runner binary links a forbidden third-party dependency" >&2
  exit 1
fi

echo "SimView iOS device runner compile validation passed"
