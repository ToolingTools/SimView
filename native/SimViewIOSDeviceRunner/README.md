# SimView iOS Device Runner

This directory contains SimView's dependency-free physical-iOS automation
runner. It is a locally built and development-signed XCTest UI-testing bundle;
it is not WebDriverAgent, Appium, or a wrapper around either project.

The host builds the runner with `build-for-testing`, writes a private temporary
`.xctestrun`, then starts only `SimViewIOSDeviceRunnerTests/testServe` with
`test-without-building`. The test process listens on the port forwarded by the
host through usbmux. Apple pairing, trust, Developer Mode, UI Automation, and a
development team are one-time prerequisites.

## Build

Run host-side protocol tests and compile without installing or signing anything
on a device:

```sh
./Scripts/validate.sh
```

Create a signed build for a development team:

```sh
SIMVIEW_DEVELOPMENT_TEAM=ABCDE12345 ./Scripts/build-for-testing.sh
```

The host must cache the resulting products by Xcode build, the hash of this
directory's tracked sources, team ID, runner protocol version, and deployment
target. It must write the session token only into a mode-0600 temporary
`.xctestrun`; tokens must never be placed in command-line arguments or logs.

## Capture behavior

Full-resolution annotation screenshots always use public
`XCUIScreen.main.screenshot()`. Preview capture normally uses the same public
API. A narrow Objective-C runtime seam can try Xcode's private screenshot
request when `SIMVIEW_ENABLE_PRIVATE_SCREENSHOT=1`; selector absence, failure,
or timeout falls back immediately to the public API. No private XCTest headers
are copied or compiled into this project.

Preview images are capped at a 1,600-pixel long edge by default and encoded as
low-latency H.264 with VideoToolbox. Capture requests are coalesced: the timer
drops ticks while a screenshot or encode is in flight. This prevents unbounded
queues, but does not establish that XCTest can sustain 30 FPS on hardware. The
physical-device performance gate must remain disabled until a 60-second run on
iOS 26 proves at least 30 displayed FPS and p95 capture-to-canvas latency below
250 ms. Until then the runner explicitly reports `performanceQualified: false`.
If its measured average remains below 30 FPS, it reduces preview dimensions and
bitrate every five seconds down to a 960-pixel long edge; it never fabricates a
passing frame rate.

## Target application

Pass `SIMVIEW_TARGET_BUNDLE_ID` in the `.xctestrun`, or call `selectApp` before
snapshot, input, or lifecycle operations. Screenshot capture is screen-wide and
does not require a target app. Installed-app discovery remains a host-side
`devicectl` responsibility.

See [PROTOCOL.md](PROTOCOL.md) for the complete runner protocol.
