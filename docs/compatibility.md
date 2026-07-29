# Compatibility boundary

All private paths, class names, selectors, C symbols, and ABI declarations live
under `native/SimViewCore/Sources/SimViewCore/Compatibility`.

The core currently probes:

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
| retained Intel line | — | x86_64 | — | — | — | not tested |

## Required release smoke test

For every supported row:

1. `simview doctor --json` reports required framework and symbol availability.
2. Capture a PNG without Screen Recording permission.
3. Stream a 60-second animated fixture and record delivered fps and p50/p95
   frame-to-canvas latency.
4. Tap a known target and verify the resulting state.
5. Type ASCII, spaces, punctuation, emoji, and a composed accented character.
6. Rotate portrait to both landscape directions without restarting.
7. Connect two clients and verify a new keyframe is delivered.
8. Leave the simulator static and verify only the 5 fps idle heartbeat encodes.
9. Retrieve the frontmost host-side accessibility tree and inspect one point.
10. Relaunch one third-party fixture with the bundled probe and verify scene,
    window, visible controller path, view class, owning controller, bounded
    view search, and bounded hierarchy.

ScreenCaptureKit is reserved for an explicit compatibility backend. It is not
the default and requires Screen Recording permission.

The passing row used development ad-hoc signatures for the core and universal
probe dylib. Developer ID signing,
notarization, the 60 fps soak, typing matrix, rotation, and multi-client checks
remain release gates rather than claims made from this local spike.
