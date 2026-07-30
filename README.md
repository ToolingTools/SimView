# SimView

SimView is a local-first iOS Simulator framebuffer and input transport for
agents, MCP hosts, and humans. It captures the simulator's `IOSurface` directly,
encodes H.264 with VideoToolbox, and injects physical input through
SimulatorKit's Indigo HID functions.

The native boundary is one executable, `simview-core`. The TypeScript client,
CLI, MCP server, MCP App, Codex plugin, Claude Code plugin, and MCPB package all
consume its versioned binary protocol.

> SimView uses private SimulatorKit interfaces and is distributed as a macOS
> developer tool. It is not an App Store product. Xcode compatibility is checked
> at runtime and must be verified on real simulators before each release.

## Requirements

- macOS 14 or later
- Full Xcode with an installed iOS Simulator runtime
- Bun 1.3.14 for source development only

Release archives contain compiled Bun clients and a universal Swift executable.
End users do not need Bun, Node, Homebrew, AXe, IDB, a simulator helper app, or
Screen Recording permission.

## Install

The generated npm package can be run without installing SimView globally:

```sh
npx simview doctor --json
bunx simview preview
```

`npx` requires Node and `bunx` requires Bun only as the package runner. The
SimView command they launch is a standalone universal executable. GitHub
release archives and agent plugins do not require either runtime.

## Build from source

```sh
bun install --frozen-lockfile
bun run build:app
bun run build:packages
swift build --package-path native/SimViewCore -c release
bun run check
```

If SwiftPM's nested sandbox conflicts with a managed environment:

```sh
swift test --disable-sandbox --package-path native/SimViewCore
```

## CLI

```sh
bun packages/cli/src/index.ts devices --json
bun packages/cli/src/index.ts doctor --json
bun packages/cli/src/index.ts preview
bun packages/cli/src/index.ts screenshot --output ./simulator.png
bun packages/cli/src/index.ts tap --x 0.5 --y 0.75
bun packages/cli/src/index.ts swipe --from 0.5,0.8 --to 0.5,0.2 --duration 350
bun packages/cli/src/index.ts type "Hello 👋"
bun packages/cli/src/index.ts button home
```

`preview` binds an authenticated relay to a random port on `127.0.0.1`. The
session token is random, endpoints reject unauthenticated requests, and the
native core uses a mode-0700 temporary directory with a mode-0600 Unix socket.

## MCP

Development:

```sh
bun packages/mcp/src/index.ts
```

Tools:

- `open_simview`
- `connect_simulator`
- `list_simulators`
- `tap`, `swipe`, `long_press`, `type_text`, `press_button`, `set_orientation`
- `take_screenshot`
- `observe_screen`, `get_accessibility_tree`, `find_elements`, `tap_element`
- `inspect_point`, `wait_for_element`
- `get_ui_context`, `enable_ui_probe`
- `get_simview_state`
- `add_annotation`, `update_annotation`, `delete_annotation`

Video never travels through MCP results. It uses the authenticated localhost
relay; MCP carries controls, screenshots, compact state, and session comments.
`open_simview` is the only tool that renders the interactive MCP App preview;
`connect_simulator` starts the same simulator session without opening UI.

Agents navigate with a semantic visual loop: call `observe_screen`, choose an
accessible identifier/role/name, call `tap_element`, wait for an observable
state, and observe again. Input still uses physical SimulatorKit HID. Pixel
coordinates remain the fallback for inaccessible or purely visual targets.

SimView reads the frontmost accessibility hierarchy host-side through
CoreSimulator, with no simulator service or separate install. An optional
bundled UIKit probe can explicitly relaunch one third-party app to add concrete
view class, hit-test, controller, window, and scene context.

Point annotations remain in memory for the current session. **Send to Chat**
sends the exact displayed canvas as a PNG with compact normalized coordinate
comments; no review files are written. Entering **Annotate** freezes the visible
frame and returning to **Interact** resumes the live stream.

## Repository map

```text
packages/core     npm binary resolver
packages/client   protocol types, framing, process lifecycle
packages/cli      human and automation CLI
packages/mcp      MCP tools, review state, authenticated relay
packages/app      Preact MCP App and browser fallback
native/SimViewCore
                  SimulatorKit capture/input and local protocol server
skills/simview    portable Codex/Claude operational skill
```

The protocol is documented in [docs/protocol.md](docs/protocol.md). Private API
compatibility and the release matrix live in
[docs/compatibility.md](docs/compatibility.md).

## Release safety

`scripts/build-release.ts` creates a universal standalone command, the
universal native core and probe, plugin/MCPB/npm packages, checksums, and a
CycloneDX-style SBOM. Generated executables remain ignored by Git. When
`SIMVIEW_SIGNING_IDENTITY` is present, it signs every distributed Mach-O before
packaging; release CI requires that identity and notarizes the signed plugin.

Before publishing:

1. Pass the real-simulator capture, tap, typing, resize, and orientation smoke
   tests on every supported Xcode line.
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
