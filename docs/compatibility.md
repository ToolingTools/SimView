# Compatibility boundary

SimView has separate iOS and Android compatibility boundaries. A successful
build is not support evidence for either platform.

All private paths, class names, selectors, C symbols, and ABI declarations live
under `native/SimViewCore/Sources/SimViewCore/Compatibility`.

The iOS backend currently probes:

- `SimServiceContext`
- `_TtC12SimulatorKit24SimDeviceLegacyHIDClient`
- `registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:`
- `IndigoHIDMessageForMouseNSEvent`
- `IndigoHIDMessageForButton`
- `IndigoHIDMessageForHIDArbitrary`
- `IndigoHIDMessageForKeyboardArbitrary`
- `PurpleWorkspacePort`

Framework candidates cover the system CoreSimulator framework plus the Xcode 26
and Xcode 27 SimulatorKit locations.

## Supported matrix

No Xcode line becomes supported from compilation alone. A release operator must
record a passing real-device-set run here.

| Xcode | macOS | Architecture | iOS runtime | Capture | Input | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 26.5 (17F42) | 26.5.2 | arm64 | iOS 26.1, iPhone 17 Pro Max | direct PNG passes | Indigo probes and authenticated tap pass | AX 25-node tree and injected UIKit probe pass |
| previous stable minor | — | arm64 | — | — | — | not tested |
| second previous minor | — | arm64 | — | — | — | not tested |

### Android matrix

Android support requires the official SDK Platform Tools and Android API 26 or
later. The backend resolves ADB without changing the user's server, keys, or
transport configuration. The transient agent uses `MediaCodec` and Android
input services as the ADB shell user; `screencap` and shell `input` are reduced-
capability fallbacks. Secure content remains blank and is never bypassed.

| Target | Transport | Runtime | Capture | Input | Semantics | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Android Emulator | local ADB | API 26 | — | — | — | not tested |
| Android Emulator | local ADB | API 30 | — | — | — | not tested |
| Android Emulator (Pixel 9 Pro XL AVD) | local ADB | Android 16 / API 36 | MediaCodec H.264, exact 1344x2992 PNG, requested keyframe, and rotation recovery pass | raw touch, swipe, long press, and Back/Overview pass | bounded UIAutomator tree, point lookup, and foreground context pass | combined local smoke passed; full soak pending |
| Android Emulator | local ADB | latest stable other than API 36 | — | — | — | not tested |
| Android Emulator | local ADB | preview | — | — | — | not tested |
| Android device | authorized USB | API 26+ | — | — | — | not tested |
| Android device | already-paired Wi-Fi | Android 11+ | — | — | — | not tested |

The rows above deliberately make no Android performance, OEM, USB-device, or
Wi-Fi-device compatibility claim until the complete smoke test is recorded.

### Physical iOS matrix

The owned XCTest runner has an iOS 15 deployment target. Compilation proves API
availability only; hardware rows remain unadvertised until the full smoke suite
passes. USB is the only initial transport. Apple's one-time pairing, trust,
Developer Mode, UI Automation, account, and development-signing confirmations
are prerequisites rather than SimView automation failures.

| Xcode | Device runtime | Build/install | Preview performance | Inspection/annotations/input | Status |
| --- | --- | --- | --- | --- | --- |
| 26.x | iOS 26 | not tested | requires 30+ displayed FPS for 60 s and p95 below 250 ms | not tested | release blocked |
| 26.x | iOS 18 | not tested | not tested | not tested | unadvertised |
| 26.x | iOS 17 | not tested | not tested | not tested | unadvertised |
| 26.x | iOS 16 | not tested | not tested | not tested | unadvertised |
| 26.x | iOS 15 | not tested | not tested | not tested | unadvertised |
| 26.5 | iOS 27 beta | unsigned generic compile only | not tested | discovery only | not acceptance evidence |

QuickTime/Valeria and ReplayKit are intentionally absent. Current macOS does not
publish the connected iPhone through AVFoundation/CoreMediaIO, direct Valeria
access requires an Apple-private entitlement, and ReplayKit requires a manual
Start Broadcast action.

## Required physical iOS release smoke test

For every advertised hardware row:

1. Perform fresh preparation, automatic signing/install/start, then a zero-touch reconnect.
2. Run an animated fixture for 60 seconds at 30+ displayed FPS (target 60) with
   p95 capture-to-canvas latency below 250 ms and bounded queues/thermal behavior.
3. Freeze a full-resolution public PNG; verify point/rectangle annotations,
   exact crops, Send to Chat, and normalized-coordinate parity.
4. Verify a bounded `ios-xcui` tree, point inspection, find/wait, manual app
   switching, and explicit bundle-ID fallback.
5. Verify tap, swipe, long press/drag, Unicode typing, every reported button,
   orientation, activation, and termination.
6. Exercise cable removal/reconnect, runner and `testmanagerd` crashes, device
   lock, protected content, multi-client sharing, final-client capture cleanup,
   and five-minute daemon exit.

If the automatic XCTest screenshot seam cannot sustain the 30 FPS floor, the
row remains blocked; a low-frame-rate preview must not be presented as parity.

## Required iOS release smoke test

For every supported row:

1. `simview doctor --json` reports required framework and symbol availability.
2. Capture a PNG without Screen Recording permission.
3. Stream a 60-second animated fixture and record delivered fps and p50/p95
   frame-to-canvas latency.
4. Tap a known target and verify the resulting state.
5. Type ASCII, spaces, punctuation, emoji, and a composed accented character.
6. Rotate portrait to both landscape directions without restarting.
7. Connect two clients and verify a new keyframe is delivered.
8. Open three MCP sessions against one UDID and verify they report the same
   native backend PID/instance ID while each review resource and annotation set
   remains isolated.
9. Close one session and verify the other stream continues. After the final
   authenticated client closes, verify capture and encoders stop immediately;
   the compatible backend may remain alive only for its five-minute reconnect
   window.
10. Leave the simulator static and verify only the 5 fps idle heartbeat encodes.
11. Retrieve the frontmost host-side accessibility tree and inspect one point.
12. Relaunch one third-party fixture with the bundled probe and verify scene,
    window, visible controller path, view class, owning controller, bounded
    view search, and bounded hierarchy.

ScreenCaptureKit is reserved for an explicit compatibility backend. It is not
the default and requires Screen Recording permission.

The passing row used development ad-hoc signatures for the arm64 core and
probe dylib. Developer ID signing,
notarization, the 60 fps soak, typing matrix, and multi-client checks
remain release gates rather than claims made from this local spike.

## Required Android release smoke test

For every Android row:

1. Confirm `simview doctor --json` reports the resolved ADB version, device
   state, API level, agent compatibility, and actionable unauthorized/offline
   diagnostics without exposing ADB keys or tokens.
2. Verify H.264 preview, an exact PNG screenshot, keyframe recovery, rotation or
   display-size recovery, and the declared MJPEG/PNG fallback.
3. Verify tap, swipe, drag, long press, text at the declared capability level,
   and every advertised navigation/button action.
4. Retrieve a bounded UIAutomator tree, inspect a point, and verify foreground
   package/activity context. UIAutomator failure must not stop screenshots or
   coordinate input.
5. Exercise unauthorized, offline, disconnect/reconnect, locked-screen, encoder
   failure, OEM input denial, and `FLAG_SECURE` cases.
6. Connect two viewers, verify daemon sharing and review isolation, then verify
   capture stops after the last authenticated client disconnects and the agent,
   temporary files, and only SimView-owned socket mappings are removed.
7. Run a 60-second animated fixture and record delivered fps, first-frame time,
   frame-to-canvas p50/p95, and input-to-visible-frame latency with host and
   target details.
