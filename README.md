# SimView

SimView is a local-first iOS Simulator and Android device preview and input
transport for agents, MCP hosts, and humans. On iOS it captures the Simulator's
`IOSurface` directly, encodes H.264 with VideoToolbox, and injects physical input
through SimulatorKit's Indigo HID functions. On Android it discovers emulators,
authorized USB devices, and already-paired Wi-Fi devices with the installed
official ADB, using a transient SimView-owned agent for streaming and input.

The native boundary is one executable, `simview-core`. The TypeScript client,
CLI, MCP server, MCP App, Codex plugin, Claude Code plugin, and MCPB package all
consume its versioned binary protocol.

> SimView uses private SimulatorKit interfaces and Android system APIs available
> to the ADB shell user. It is distributed as a macOS developer tool, not an App
> Store or Play Store product. Supported Xcode and Android runtime rows must be
> verified on real targets before each release.

## Requirements

- macOS 14 or later
- Full Xcode with an installed iOS Simulator runtime for iOS support
- Android SDK Platform Tools (`adb`) for Android support
- Bun 1.3.14 for source development only
- XcodeGen, JDK 17, Android SDK platform 35, and build-tools 35.0.0 when building from source

Android support targets API 26 or later. SimView uses the user's existing ADB
server and authorization keys; it does not pair devices, enable legacy
`adb tcpip 5555`, or install a persistent helper app. ADB is resolved from
`SIMVIEW_ADB_PATH`, `ANDROID_SDK_ROOT`, `ANDROID_HOME`, `PATH`, then the standard
macOS Android SDK location. Missing ADB does not prevent iOS use.

Release archives contain compiled arm64 Bun clients, an arm64 Swift executable,
and the versioned Android agent DEX/JAR.
End users do not need Bun, Node, Homebrew, AXe, IDB, a simulator helper app, or
Screen Recording permission.

## Quick Start

Run SimView from npm without a global install:

```sh
npx --yes --package @toolingtools/simview -- simview doctor --json
bunx --package @toolingtools/simview simview preview
```

`npx` requires Node and `bunx` requires Bun only as the package runner. The
SimView command they launch is a standalone arm64 executable. GitHub
release archives and agent plugins do not require either runtime.

### Try it with Android

Start an Android Emulator or connect an already-authorized Android device, then
list the platform-qualified device IDs SimView can use:

```sh
npx --yes --package @toolingtools/simview -- simview devices --json
npx --yes --package @toolingtools/simview -- simview doctor --json
```

Open a device by passing its returned `android:<adb-serial>` ID. For example:

```sh
npx --yes --package @toolingtools/simview -- simview preview --device-id android:emulator-5554
```

SimView works with ready Android Emulators, authorized USB devices, and devices
that are already paired over Wi-Fi. It reports unauthorized or offline targets
without trying to change their ADB transport or pairing state.

### Codex plugin

Install the [ToolingTools plugin marketplace](https://github.com/ToolingTools/Plugins),
then install SimView:

```sh
codex plugin marketplace add toolingtools/plugins
codex plugin add simview@toolingtools
```

The marketplace is catalog-only: Codex downloads the versioned
`@toolingtools/simview` npm
package, which includes the plugin manifest, MCP server, skills, and assets.

### MCP server

SimView can also be used directly by any MCP host. Configure it to run the
packaged command:

```json
{
  "mcpServers": {
    "simview": {
      "command": "npx",
      "args": ["--yes", "--package", "@toolingtools/simview", "--", "simview", "mcp"]
    }
  }
}
```

The equivalent Bun runner command is
`bunx --package @toolingtools/simview simview mcp`. Running only
`bunx @toolingtools/simview` starts the CLI without a subcommand, prints its
usage, and exits; it does not start the MCP server. For a local npm
installation, replace `npx` and its arguments with the installed `simview`
executable and `mcp` argument. Run `simview mcp` directly while developing from
source.

## Build from source

```sh
bun install --frozen-lockfile
bun run build
bun run check
```

The repository requires Bun 1.3.14. `bun run check` also verifies the shared
version source, Biome/Swift/Objective-C formatting, TypeScript, Bun coverage,
and Swift tests. For a release-shaped build and package smoke test:

```sh
bun run release:build
bun run smoke:npm
```

With a ready Android emulator, `bun run smoke:android` verifies the transient
agent, H.264, exact PNG capture, UIAutomator, and foreground context. Set
`SIMVIEW_ANDROID_INPUT_SMOKE=1` to include state-changing input and keyframe
recovery, and `SIMVIEW_ANDROID_ROTATION_SMOKE=1` to rotate and restore the
target. Physical targets additionally require `SIMVIEW_ANDROID_ALLOW_PHYSICAL=1`.

`release:build` refreshes the arm64 CLI, native core, and probe before
writing checksums, `release-manifest.json`, and a CycloneDX SBOM. Do not test a
packaged plugin or npm tarball against stale `dist` or native output.

If SwiftPM's nested sandbox conflicts with a managed environment:

```sh
swift test --disable-sandbox --package-path native/SimViewCore
```

## CLI

```sh
bun packages/cli/src/index.ts devices --json
bun packages/cli/src/index.ts devices --booted --json
bun packages/cli/src/index.ts doctor --json
bun packages/cli/src/index.ts preview
bun packages/cli/src/index.ts screenshot --device-id android:emulator-5554 --output ./device.png
bun packages/cli/src/index.ts tree --json
bun packages/cli/src/index.ts ax-tree --json
bun packages/cli/src/index.ts tap --x 0.5 --y 0.75
bun packages/cli/src/index.ts swipe --from 0.5,0.8 --to 0.5,0.2 --duration-ms 350
bun packages/cli/src/index.ts type "Hello"
bun packages/cli/src/index.ts button home
bun packages/cli/src/index.ts daemon status --json
bun packages/cli/src/index.ts daemon stop --device-id <id>
bun packages/cli/src/index.ts daemon prune
```

`tree` and `observe` use the same unified inspection path as the preview: they
return a matching development-mode React Native Fiber tree and screen/route
context when Metro is available, with the native accessibility tree otherwise.
`ax-tree` explicitly bypasses Metro. iOS sessions automatically start a
temporary XCTest runner against the existing foreground app process and use it
as the primary tree and point provider; Simulator AX is the startup fallback.
Android reads UIAutomator.

`preview` binds an authenticated relay to a random port on `127.0.0.1`. The
session token is random, endpoints reject unauthenticated requests, and the
native core uses a mode-0700 temporary directory with a mode-0600 Unix socket.
MCP sessions acquire one detached native backend per platform and native device
identifier, so several Codex/MCP tasks share the same capture and encoder
process. Each task still has
its own stdio bridge, relay, review ID, and annotations. The backend stops
capture when its last authenticated client leaves and exits after five idle
minutes. `SimViewClient.start()` remains the explicit ephemeral/test path; set
`SIMVIEW_BACKEND_MODE=ephemeral` to diagnose the registry in isolation.
Use `simview daemon status`, `stop --device-id <id>` (or `stop --all`), and
`prune` to inspect or explicitly manage sanitized backend records. `prune`
only removes records whose recorded process is confirmed dead.
All device-scoped CLI commands accept `--device-id`; `--udid` remains an iOS
compatibility alias.

`devices --booted` returns only currently booted iOS Simulators and ready
Android Emulators. The unfiltered command continues to include unavailable
virtual devices and physical Android devices for diagnostics.

`simview doctor --json` reports iOS framework/probe readiness and Android ADB
path/version, agent compatibility, and discovered transport states. Unauthorized
devices remain visible with an instruction to accept the ADB prompt; offline or
still-booting targets remain visible but unavailable. No ADB key or agent token
is included in diagnostics.

## MCP

Development:

```sh
bun packages/mcp/src/index.ts
```

Tools:

- `open_simview`
- `connect_device`
- `list_devices`
- `tap`, `swipe`, `long_press`, `type_text`, `press_button`, `set_orientation`, `perform_gesture`
- `perform_actions`
- `take_screenshot`
- `observe_screen`, `get_element_tree`, `get_accessibility_tree`, `search_elements`, `find_elements`, `tap_element`
- `inspect_point`, `wait_for_element`
- `get_ui_context`, `enable_ui_probe`
- `get_simview_state`
- `add_annotation`, `update_annotation`, `delete_annotation`

`list_devices` returns only available devices by default and caps each response
at 25 entries. Pass `availableOnly: false` with `offset` and `limit` to inspect
shutdown or unavailable inventory without overflowing MCP host result limits.

The standalone browser preview uses the authenticated localhost stream. The
embedded MCP App does not make localhost HTTP or WebSocket requests: Codex
requires secure network origins, so it carries bounded video packet batches and
byte-paged React Native/AX element snapshots through app-only bridge tools. A
priority gate pauses video polling only while an explicitly opened or refreshed
Inspector (or the already-frozen Annotate mode) transfers element pages. SimView
does not refresh the tree in the background while both surfaces are closed, so
normal interaction leaves the serialized bridge dedicated to video and input.
`connect_device` starts the selected device session without opening UI. Always
call it first and proceed only if it succeeds. When an interactive preview is
requested, follow it with `open_simview` using the same device ID; the preview
then boots from the connected session and immediately requests fullscreen.
`open_simview` is the only model-callable tool linked to the MCP App resource;
discovery and connection results remain text-only so preflight calls cannot
mount or replace the preview. Once open, resource-scoped app-only tools handle
device switching and preview interactions. Headless connection does not create
a relay, preview window, encoder subscription, or preview packet ring.

Agents navigate with the warm semantic loop: call `observe_screen` in
`semantic` mode, pass `sinceObservationId` on subsequent calls, use
`search_elements` for bounded ranked discovery, and pass the chosen ref to
`tap_element`. Physical semantic taps always settle and re-resolve a fresh
native accessibility target, then hit-test it before input; React Native Fiber
is discovery-only fallback and never supplies tap coordinates. Fiber-only test
IDs require a unique exact native accessible-name corroboration before input.
Offscreen ranked results appear under `excludedCandidates` with swipe guidance.
Search covers only the currently rendered semantic tree, so a zero result does
not establish that an item is absent from a scrollable list, table, or
virtualized collection. Explore expected data surfaces one swipe at a time,
searching each changed snapshot and stopping at an unchanged semantic boundary
or a bounded attempt limit; never batch speculative swipes or reuse an old ref.
`verifyDestination` is optional. Do not attach it to every tap merely because a
flow involves invoices, orders, payments, or accounts. For generic section/menu
navigation, omit it and rely on the stable semantic post-action observation.
Use `verifyDestination.identity` only when a distinctive identity is known to
be exposed on the destination, normally when opening a specific entity or
before a consequential follow-up action. Never copy the tapped control's label
or use a generic label such as `Invoices`, `Orders`, `Card`, or `Pay` as the
destination identity. Optional `verifyDestination.assertions` can establish
amount, status, or other supporting facts.
Selectors are exact by default. `name` matches native label/title and falls back
to non-redacted text values such as Android `TextView` content; use `value` when
that field is explicitly exposed. Use a native name fragment with
`exact: false` when the destination exposes a composite label such as
`Invoice #30363063`. `isError` or `safeToContinue: false` is a hard stop even though
the nested `interaction` receipt confirms that input was dispatched. Prefer
an identity that uniquely establishes the entity, such as an invoice number;
the verification timeout is bounded to 100–5000 ms. Identity must match exactly
one native node. Assertions only need to be present and may match multiple nodes,
such as an amount repeated in total and outstanding fields. An ambiguous identity
hard-stops as `destination_ambiguous` with `safeToContinue: false`; strengthen it
without repeating the already accepted tap. Use `checked` or `selected` to verify
control state when native accessibility exposes it, or `enabled` to verify an
independently identifiable downstream control. Successful standalone and batch
semantic taps return the interaction summary followed by one stable compact
post-action tree; callers should consume it instead of immediately observing
again. Non-dispatched failures expose `retryInput: false`, `recoveryAllowed`, an
optional `recoveryAction`, and bounded actionability diagnostics. Only failures
that report `inputDispatched: true` use the dispatched-input hard stop. Prefer
`tap_known_coordinate` only when SimView returns a `coordinateFallback` derived
from the fresh semantic target center. It permits one raw tap at that exact point
when the requested action is already authorized, followed immediately by a
semantic observation; callers must not repeat it or substitute hit-test/image
coordinates. Prefer
`perform_actions` with `observe: "semantic"` for ordered input plus a coherent
post-action observation. Images are never an automatic input fallback; use explicit `visual`
mode only when the user requests visual inspection. iOS input uses SimulatorKit
HID; Android uses the SimView agent with ADB shell input as a reduced-capability
fallback. Pixel coordinates remain an explicit last resort for inaccessible
targets except for the bounded native-semantic recovery above.
Android currently declares ASCII text support; iOS supports the full Unicode
typing path. Callers should inspect the selected device capability before typing.

When a development-mode React Native target is available on a local Metro
port, SimView uses `metro-bridge` to project its Fiber tree into visual elements
with component ancestry, test IDs, measured host bounds, focused route, and
project-relative source locations. When Metro MCP's daemon is already running,
SimView reuses its loopback CDP multiplexer instead of competing for Hermes'
debugger connection; Metro MCP itself is not required. SimView never
starts Metro, serializes component props or navigation params, or attaches an
ambiguous target to a Simulator.
Discovery uses `localhost` through the packaged `metro-bridge`, including its
IPv4 fallback, and probes the bridge's pinned ports without extending successful
discovery. Native fallback keeps the coarse Metro status and may add a bounded
detail distinguishing unreachable Metro, no debug targets, device mismatch,
missing Fiber roots, and CDP inspection failures.
Without a matching target it uses the frontmost native accessibility hierarchy:
the automatically started XCTest provider on iOS or UIAutomator on Android.
For Android semantic taps, the raw deepest hit and selected actionable hit are
resolved from that same fresh hierarchy; the tree validates the target, while
physical input remains native-only.
XCTest activates but does not relaunch the target app, and the packaged runner
is reused for warm snapshots during the session. Simulator AX remains available
when XCTest cannot start. An optional
bundled UIKit probe can explicitly relaunch one third-party app to add concrete
view class, hit-test, controller, window, and scene context on iOS only. Android
screen context reports the foreground package and activity when available.

Protocol requests and results are keyed by method and validated at runtime with
the browser-safe Zod contracts in `packages/contracts`. Accessibility selectors
must contain a matching field, wait states are `visible` or `hidden`, and CLI
durations/timeouts use millisecond-bearing options. See
[docs/protocol.md](docs/protocol.md) for the wire contract.

Point annotations remain in memory for the current session. **Send to Chat**
saves the exact frozen canvas and element crops as private PNGs in a
session-owned temporary directory, then sends an implementation prompt, their
absolute paths, frame-scoped React Native screen/route or UIKit view-controller
context, and each concise annotation/context block. This avoids relying on host
image-message support while keeping the images available to the local agent.
The handoff tells the agent to implement the saved feedback in the current
project without opening another SimView review. Temporary review images are
removed when the session closes. Annotations are
isolated by review and platform-qualified device ID, survive switching away and
back during that live review, and are deleted when its MCP bridge closes. Entering
**Annotate** freezes the visible frame and returning to **Interact** resumes the
live stream.

## Repository map

```text
packages/core     npm binary resolver
packages/contracts shared Zod schemas, wire types, and method map
packages/client   framing, validated requests, process lifecycle, daemon registry
packages/cli      human and automation CLI
packages/mcp      MCP tools, review state, authenticated relay
packages/app      Preact MCP App and browser fallback
native/SimViewCore
                  iOS/Android device backends and local protocol server
native/SimViewAndroid
                  transient Android capture/input agent
skills/simview    portable Codex/Claude operational skill
```

The protocol is documented in [docs/protocol.md](docs/protocol.md). Private API
compatibility and the release matrix live in
[docs/compatibility.md](docs/compatibility.md).
The ownership and trust boundaries are described in
[docs/architecture.md](docs/architecture.md), and contributor workflows are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Release safety

`scripts/build-release.ts` creates an arm64 standalone command, the arm64
native core and probe, plugin/MCPB/npm packages, checksums, and a
CycloneDX-style SBOM. Generated executables remain ignored by Git. When
`SIMVIEW_SIGNING_IDENTITY` is present, it signs every distributed Mach-O before
packaging; release CI requires that identity and notarizes the signed plugin.

Before publishing:

1. Pass the real-target capture, tap, typing, resize, orientation, accessibility,
   disconnect, and reconnect smoke tests on every supported Xcode and Android
   runtime row.
2. Sign with Developer ID Application and submit the final archives for
   notarization.
3. Validate the Codex plugin and MCPB archive on a clean macOS account.
4. Measure the 60-second animated fixture and publish fps plus p50/p95 latency
   with hardware details.

See [docs/distribution.md](docs/distribution.md) for signing secrets, npm trusted
publishing, and the catalog-only Codex/Claude marketplace layout.

## License and attribution

Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted
Apache-licensed implementation references.
