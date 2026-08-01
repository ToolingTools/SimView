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

## Quick Start

Run SimView from npm without a global install:

```sh
npx simview doctor --json
bunx simview preview
```

`npx` requires Node and `bunx` requires Bun only as the package runner. The
SimView command they launch is a standalone universal executable. GitHub
release archives and agent plugins do not require either runtime.

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
      "args": ["-y", "simview", "mcp"]
    }
  }
}
```

For a local npm installation, replace `npx` and its arguments with the
installed `simview` executable and `mcp` argument. Run `simview mcp` directly
while developing from source.

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

`release:build` refreshes the universal CLI, native core, and probe before
writing checksums, `release-manifest.json`, and a CycloneDX SBOM. Do not test a
packaged plugin or npm tarball against stale `dist` or native output.

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
bun packages/cli/src/index.ts tree --json
bun packages/cli/src/index.ts ax-tree --json
bun packages/cli/src/index.ts tap --x 0.5 --y 0.75
bun packages/cli/src/index.ts swipe --from 0.5,0.8 --to 0.5,0.2 --duration-ms 350
bun packages/cli/src/index.ts type "Hello 👋"
bun packages/cli/src/index.ts button home
bun packages/cli/src/index.ts daemon status --json
bun packages/cli/src/index.ts daemon stop --udid <uuid>
bun packages/cli/src/index.ts daemon prune
```

`tree` and `observe` use the same unified inspection path as the preview: they
return a matching development-mode React Native Fiber tree and screen/route
context when Metro is available, with a diagnostic AX fallback otherwise.
`ax-tree` explicitly bypasses Metro and reads only the native accessibility
hierarchy.

`preview` binds an authenticated relay to a random port on `127.0.0.1`. The
session token is random, endpoints reject unauthenticated requests, and the
native core uses a mode-0700 temporary directory with a mode-0600 Unix socket.
MCP sessions acquire one detached native backend per Simulator UDID, so several
Codex/MCP tasks share the same capture and encoder process. Each task still has
its own stdio bridge, relay, review ID, and annotations. The backend stops
capture when its last authenticated client leaves and exits after five idle
minutes. `SimViewClient.start()` remains the explicit ephemeral/test path; set
`SIMVIEW_BACKEND_MODE=ephemeral` to diagnose the registry in isolation.
Use `simview daemon status`, `stop --udid <uuid>` (or `stop --all`), and
`prune` to inspect or explicitly manage sanitized backend records. `prune`
only removes records whose recorded process is confirmed dead.

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
- `observe_screen`, `get_element_tree`, `get_accessibility_tree`, `find_elements`, `tap_element`
- `inspect_point`, `wait_for_element`
- `get_ui_context`, `enable_ui_probe`
- `get_simview_state`
- `add_annotation`, `update_annotation`, `delete_annotation`

The standalone browser preview uses the authenticated localhost stream. The
embedded MCP App does not make localhost HTTP or WebSocket requests: Codex
requires secure network origins, so it carries bounded video packet batches and
byte-paged React Native/AX element snapshots through app-only bridge tools. A
priority gate pauses video polling only while an explicitly opened or refreshed
Inspector (or the already-frozen Annotate mode) transfers element pages. SimView
does not refresh the tree in the background while both surfaces are closed, so
normal interaction leaves the serialized bridge dedicated to video and input.
`connect_simulator` starts the simulator session without opening UI. Always call
it first and proceed only if it succeeds. When an interactive preview is
requested, follow it with `open_simview` using the same UDID; the preview then
boots from the connected session and immediately requests fullscreen.
`open_simview` is the only model-callable tool linked to the MCP App resource;
discovery and connection results remain text-only so preflight calls cannot
mount or replace the preview. Once open, resource-scoped app-only tools handle
device switching and preview interactions.

Agents navigate with a semantic visual loop: call `observe_screen`, choose an
accessible identifier/role/name, call `tap_element`, wait for an observable
state, and observe again. Input still uses physical SimulatorKit HID. Pixel
coordinates remain the fallback for inaccessible or purely visual targets.

When a development-mode React Native target is available on a local Metro
port, SimView uses `metro-bridge` to project its Fiber tree into visual elements
with component ancestry, test IDs, measured host bounds, focused route, and
project-relative source locations. When Metro MCP's daemon is already running,
SimView reuses its loopback CDP multiplexer instead of competing for Hermes'
debugger connection; Metro MCP itself is not required. SimView never
starts Metro, serializes component props or navigation params, or attaches an
ambiguous target to a Simulator.
Without a matching target it atomically falls back to the frontmost
accessibility hierarchy read host-side through CoreSimulator. An optional
bundled UIKit probe can explicitly relaunch one third-party app to add concrete
view class, hit-test, controller, window, and scene context.

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
isolated by review and Simulator UDID, survive switching away and back during
that live review, and are deleted when its MCP bridge closes. Entering
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
                  SimulatorKit capture/input and local protocol server
skills/simview    portable Codex/Claude operational skill
```

The protocol is documented in [docs/protocol.md](docs/protocol.md). Private API
compatibility and the release matrix live in
[docs/compatibility.md](docs/compatibility.md).
The ownership and trust boundaries are described in
[docs/architecture.md](docs/architecture.md), and contributor workflows are in
[CONTRIBUTING.md](CONTRIBUTING.md).

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
