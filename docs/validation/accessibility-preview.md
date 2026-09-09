# Accessibility and preview validation — 9 September 2026

Implementation baseline: `06eadbd` (0.4.4), with the local accessibility-worker,
provider-recovery, and explicit viewer-pause changes. This is validation of a
working-tree patch, not a published release.

## Automated checks

- `bun run check` with Bun 1.3.14 passed the toolchain/version/format gates,
  TypeScript, distributable test-fixture builds, Bun coverage tests, and XCTest.
- Final release checks passed **285 Bun tests** and **90 Swift tests**, with one
  optional environment-configured provider test skipped. Real-Simulator coverage
  below supplements that skipped test. Both forced and already-exited child
  regressions verify Foundation has reaped the child.
- Rendered app tests run the actual bundled Preact app in an isolated Happy DOM
  process with controlled host/relay responses. They cover embedded and browser
  transport pauses, overlapping annotation/Inspector states, pagination,
  timeout/retry, cancellation, retained trees, unsent-annotation confirmation,
  resumption, and suppression of native touches on the frozen Inspector canvas.
- MCP tests verify that cancelled and device-stale captures cannot overwrite a
  newer page transfer. Native tests cover serialized provider lifecycle, queued
  work invalidation, interrupted socket reads, and numeric JSON zero/one values.

## Shared native backend under continuous motion

Two clients acquired the same release-mode native backend; equality of their
socket identities was asserted without logging credentials or socket paths.
One received H.264 frames while the other started XCTest and read four full
accessibility snapshots. A synthetic CADisplayLink animation ran on a dedicated
iOS 26.1 Simulator. Input taps were confined to that synthetic fixture.

| Measurement | Result |
| --- | ---: |
| Baseline delivered FPS (before/after mean) | 37.60 |
| Delivered FPS during repeated trees | 38.13 |
| Retained baseline FPS | 101.42% |
| XCTest startup duration | 14.66 s |
| Largest frame gap during startup | 62.31 ms |
| Largest frame gap during repeated trees | 47.24 ms |
| Slowest concurrent health response | 2.81 ms |
| Slowest concurrent input acknowledgement | 110.01 ms |

Passed: no accessibility-correlated one-second gap and no greater than 10% FPS
reduction. This verifies continuity; it does not establish a new 60 FPS target.

## Previously affected app

The already-open app on iOS 26.5 was checked without sending input. With the
patched backend, four successive XCTest snapshots each returned 191 nodes,
correctly marked **partial/truncated**. Startup took 8.64 seconds; the largest
frame gaps were 409.47 ms during startup and 401.00 ms during tree reads, matching
the roughly 400 ms static-screen refresh cadence.

An earlier isolated attempt fell back to native AX on its first tree. A fresh
attempt passed all four reads; this does not prove that transient XCTest failures
are eliminated. Recovery remains bounded and explicit, and native provider status
now retains the runtime failure code when fallback occurs.

The existing installed Codex session was restored to XCTest after isolated tests,
and its 191-node partial tree was verified. Its installed plugin was not replaced:
new pause behavior was verified through rendered embedded/relay app tests, not a
reinstalled plugin in the live Codex host. Host-level visual acceptance remains a
release smoke check. The dedicated QA Simulator is shut down after testing.


## Inspector recovery and Expo Router follow-up

A later live failure exposed Foundation `waitUntilExit` blocking the accessibility
worker even though the owned XCTest process was no longer running and had no
surviving child. Cleanup now uses bounded monotonic polling, with asynchronous
retention if process termination is delayed. Native regressions assert the child
has already been reaped (`waitpid` returns `ECHILD`) after both forced termination
and an already-exited process.

The affected Expo Router app uses React Native 0.86.3 and Expo Router 57.0.19.
Its message screen had nine `RCTText` hosts without public instances; the new
Fabric shadow-node path measured all nine. On the Jobs tab, the root navigation
state ended at the tab and omitted its nested `index` route. The revised scene
filter retained the nested screen: 462 inspected nodes, 103 visible rows, and 13
measured visible text nodes. The existing inactive-sibling and React Navigation
fixtures remain covered.

An isolated ephemeral backend was connected to the already-running iOS 26.5 app.
The test killed only that backend's owned `xcodebuild` child, then requested a tree
and reconnected through the same native connection. The failure/fallback read
returned in 1.01 seconds; reconnect plus a full Fiber tree completed in 20.55
seconds. All 13 visible text centers selected their corresponding text nodes.
A second authenticated viewer received 57 frames during recovery, with a largest
frame gap of 429.43 ms; a concurrent health request completed in 2.29 ms. The
Simulator was not restarted and no app input was sent.

Three independent simplify passes completed. Applied follow-ups close browser
video sockets during intentional pauses, preserve an explicitly requested app
when it overlaps automatic accessibility recovery, and simplify repeated
supersession guards. Hover scheduling and provider-status caching were deferred;
no unverified timing optimization was added.

The final rendered regression also disconnects the native preview, recovers via
an explicit Inspector load, and verifies video resumes after closing Inspector.
Successful recovery updates both provider metadata and preview connection state.

Final packaged-browser acceptance used the official MCP App bridge in a local
browser harness. A reload while the loading indicator was visible, followed by
leaving and returning to the preview, each completed a fresh tree successfully
(462 Fiber nodes, 102 visible rows on the current Jobs view). Refresh preserved
the previous tree and the 30px search field beside the compact spinner. The
browser harness is separate from the installed Codex plugin; actual Codex task
switching was not automated. Final release packaging and npm smoke both passed.
