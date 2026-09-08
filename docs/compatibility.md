# Compatibility boundary

SimView has separate iOS and Android compatibility boundaries. A successful
build is not support evidence for either platform.

All private paths, class names, selectors, C symbols, and ABI declarations live
under `native/SimViewCore/Sources/SimViewCore/Compatibility` and the native
`SimViewAXShim` accessibility boundary.

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

### 0.4.4 candidate lifecycle investigation

The 8 September 2026 checks used Xcode 26.5 (17F42), macOS 26.6.2,
arm64, and an iPhone 17 Pro Simulator on iOS 26.1.

- The candidate release build passed 269 Bun tests and 76 Swift tests with
  no failures; one opt-in Simulator test was skipped. The generated npm
  package passed isolated npm and bunx smoke checks.
- Earlier semantic-only navigation lost its native connection after about
  5.5 minutes while the Simulator remained booted and MCP stayed responsive.
  The native helper had exited, but its exit status was not captured.
- A subsequent browser-attached baseline completed 15 minutes, 25 fresh
  observations, and 12 navigation taps with both connections intact.
- Terminating only SimView's temporary XCTest runner produced a usable native
  AX fallback in both the baseline and patched candidate. A kernel process
  monitor confirmed exit code zero when the baseline was intentionally closed.
- An isolated subprocess reproduced SIGPIPE termination in the XCTest socket
  writer. The candidate suppresses that signal per send and returns a write
  error instead. A regression runs with default SIGPIPE handling so inherited
  signal settings cannot hide the defect. This has not been established as
  the cause of the earlier live exits. A later patched run was terminated by
  SIGKILL (signal 9), confirmed by a kernel process-event monitor.
- Restarting XCTest exceeded the tool's ten-second request deadline, then
  completed successfully; a later fresh observation confirmed XCTest output.
  This startup deadline mismatch remains a separate limitation.

The patched browser-attached navigation run lost its backend after about six
minutes; the Simulator remained booted and MCP remained responsive. The SIGKILL
sender or OS reason is still unknown, so the release remains blocked. A
read-only follow-up also ended with SIGKILL after ten successful observations.
The kernel event had neither memory-exit nor code-signing-exit flags; sampled
RSS peaked at about 570 MiB and returned near 300 MiB before termination. A
temporary diagnostic build confirmed unlimited CPU limits inside the helper.
An MKM
crash report also coincided with the earlier deliberate runner-stop test; that
fault injection is not evidence of an application-safe recovery path.

These checks do not establish the cause of the native kills or complete
all release gates. No new iOS 26.5 navigation acceptance was performed.

### 0.4.4 preview reconnect regression

The 9 September 2026 synthetic-motion check on the iOS 26.1 Simulator
reproduced delivery falling to 2.4–2.8 fps after the last H.264 viewer left
and rejoined. Native health counters showed capture itself slowing down;
encoding continued to keep up. Surface-change callbacks were unregistering
and recreating the display subscription, including forced captures during
registration. The candidate now reads the existing descriptor's current
surface without rebuilding its subscription.

With this change, the same initial subscription and two reconnects delivered
36.8, 37.6, and 37.8 fps. A second run of the checked-in smoke test delivered
38.2, 37.8, and 38.2 fps. The Swift suite passed 76 tests (one opt-in test
skipped), and TypeScript and targeted formatting checks passed. These are
encoded delivery rates; distinct browser frames and end-to-end latency were not measured.
The separate SIGKILL release blocker above remains unresolved.

Run against a freshly built core and a dedicated Simulator displaying a
continuously animated synthetic fixture:

```sh
SIMVIEW_DEVICE_ID=ios:<udid> SIMVIEW_BACKEND_MODE=ephemeral \
  SIMVIEW_CORE_BINARY="$PWD/native/SimViewCore/.build/arm64-apple-macosx/release/simview-core" \
  bun scripts/smoke-preview-reconnect.ts
```

The smoke check asserts at least 30 captured and delivered frames per second
across five-second samples, before and after each reconnect. It retains no
screen contents and keeps relay credentials private. Orientation and other
Xcode/runtime combinations remain separate acceptance checks.

### 0.4.3 lifecycle regression run

The 7 September 2026 local run used Xcode 26.5 (17F42), macOS 26.6.2,
arm64, and an iPhone 17 Pro Simulator on iOS 26.5.

- The fresh release build passed 214 Bun tests and 69 Swift tests with no
  failures; one application-specific, opt-in Swift test was skipped.
- The generated npm package passed isolated `npm exec` and `bunx` doctor
  checks. All release archive checksums passed.
- Two packaged MCP adapters shared one MCP daemon and one compatible native
  backend, with distinct review resources. Semantic observation returned 14
  nodes. Closing one review preserved the other; the final close stopped both
  daemons in 111 ms.
- A compiled MCP daemon closed during discovery reaped both the discovery
  process and its SIGTERM-ignoring descendant and removed its registry record.
- An ordinary MJPEG browser connection delivered 97 frames during the sample.
  Closing its final viewer released the fallback connection while its primary
  native client remained usable.
- On a warmed Simulator, the XCTest provider reached `enhanced-ready`;
  terminal native shutdown reaped its child and removed its generated private
  `.xctestrun` file. Initial provider activation attempts timed out during
  Simulator preparation.

This run covers the 0.4.3 lifecycle and preview regressions. The full input,
orientation, latency, soak, signing, and notarization release gates below still
apply.

### 0.4.3 foreground and capture acceptance

The follow-up on 7 September 2026 keeps Bun 1.3.14 and metro-bridge 0.2.10.
The former MJPEG fixture failure passed 50 consecutive runs under coverage.
Foreground matching, retained XCTest retargeting, and screenshot/preview
lifecycle regressions have dedicated automated coverage. The final release build
passed 252 Bun coverage tests and 71 Swift tests (zero failures; one opt-in
Simulator test skipped), formatting, toolchain/version checks, typechecking, and
fresh fixture builds. The production audit found no vulnerabilities. Fresh
release artifacts and isolated npm/Bun package smoke tests passed. The packaged
core and XCTest runner repeated the full MKM → Spenny → MKM, idle screenshot,
and preview/lease acceptance successfully.

Live checks used the same iPhone 17 Pro/iOS 26.5 Simulator, macOS 26.6.2 arm64,
and Xcode 26.5 (17F42), with the existing MKM and Spenny installations:

- MKM (`com.mkm.ecommerce.test`) returned a 692-node Fiber tree, 490–492
  measured nodes, a focused route, and 198 project-relative source locations.
  Incomplete host measurements correctly reported partial quality. Metro's
  opaque logical-device hash required a unique device-name match plus positive
  foreground app identity. MKM search and native semantic tapping selected
  its Shop tab, with native selected-state confirmation.
- MKM → Spenny → MKM passed while MKM's Metro server remained running. Spenny
  (`studio.churro.spenny`) returned a complete 89-node native XCTest tree and
  native iOS context with no MKM route or component source locations. Switching
  back recovered MKM enrichment. The same XCTest runner followed app switches
  without activating or relaunching either app.
- Spenny also passed native semantic inspection, search, navigation input,
  screenshots, and previews with Metro discovery disabled in the harness.
  This simulates an unavailable Metro server; the user's bundler was left
  running. The accepted navigation tap changed its native tree from 89 to 111
  nodes. No Hermes or app-side instrumentation was required.
- Both apps took fresh PNGs from idle capture, releasing the temporary
  connection and demand while preserving the primary client.
- Spenny's MJPEG-only preview delivered 19 frames with zero H.264 encodes.
  Mixed preview delivered both codecs; closing H.264 preserved MJPEG and
  stopped H.264 encoding. Closing all viewers and expiring the five-second
  embedded polling lease released capture; subsequent screenshots succeeded.
- Provider teardown left the Simulator booted after switching from SIGTERM
  cancellation to authenticated runner shutdown and bounded host-process
  reaping. Earlier attempts using the old teardown shut down the Simulator;
  those attempts are not passing evidence. No screenshots or UI trees were saved.

The foreground detector now maps the accessibility frontmost process ID to a
unique Simulator launch-service bundle ID and rechecks identity after lookup.
Multiple background apps can retain `spawn role = ui focal`, so that launch
policy flag is no longer used as foreground evidence. Private selectors remain
inside the native compatibility boundary. Background or unidentified UIKit
probe context is not merged into another app's native context.

A subsequent local PR review used the explicitly selected Pixel 9 Pro XL AVD
(`emulator-5554`, Android 16 / API 36) with MKM Test
(`com.mkm.ecommerce.test`). Native semantic search and navigation selected the
Shop tab. After connecting the installed development client to its existing
Metro server, the current source returned 629 Fiber nodes, 365 measured nodes,
149 project-relative source locations, and route context for the Android app;
incomplete host measurements reported partial quality. Exact PNG capture passed
at 1344×2992. React Native's model/release/API device name is matched against ADB
metadata, with app identity and ambiguity checks retained. Initial observations
discarded changing semantic state; the settled observation passed. No UI trees
or screenshots were saved. The local review follow-up passed `bun run check`: 254
Bun tests, 72 Swift tests (one opt-in skip), formatting, typechecking, and fresh
fixture builds. The full input, orientation, latency, soak, signing,
and notarization matrix below remains outside this follow-up's observed coverage.

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
   the compatible backend must exit within the five-second cleanup deadline.
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
