# Repository Guidelines

These instructions describe the current source tree and release workflow. Keep
documentation aligned with the implementation, especially the shared native
backend and per-review MCP boundaries.

## Project Structure & Module Organization

SimView is a Bun workspace with a native Swift boundary:

- `packages/app`: Preact MCP App preview.
- `packages/contracts`: browser-safe Zod schemas, inferred wire types, method
  maps, protocol constants, and MCP/relay payload contracts.
- `packages/client`: binary framing, validated method-keyed requests, request
  deadlines/cancellation, ephemeral process lifecycle, and the race-safe shared
  per-Simulator daemon registry.
- `packages/core`: packaged `simview-core` resolver.
- `packages/cli`: command-line interface.
- `packages/mcp`: MCP tools, session state, and authenticated relay.
- `native/SimViewCore`: Swift executable, Objective-C accessibility shim, and XCTest suite.
- `tests`: Bun integration and protocol tests.
- `scripts`: release, plugin, MCPB, and simulator-smoke tooling.
- `docs`, `plans`, `skills`, and `assets`: contracts, implementation plans,
  agent guidance, operational instructions, and branded media.

Keep private selectors, ABI assumptions, and framework paths inside native
compatibility modules. Shared wire types and runtime schemas belong in
`packages/contracts`; `packages/client` owns native framing and
process/daemon transport, while MCP-specific review state stays in
`packages/mcp`.

## Build, Test, and Development Commands

Use Bun 1.3.14 and commit `bun.lock`. `bun run check:toolchain` fails fast when
another Bun version is active.

```sh
bun install --frozen-lockfile  # Install exact dependencies
bun run build                  # Build app, packages, and release-mode native core
bun run typecheck              # Run TypeScript without emitting files
bun test                       # Run Bun tests
bun run check                  # Typecheck plus Bun and Swift tests
bun run check:format           # Biome, swift-format, and clang-format checks
bun run check:version          # Reject version drift across manifests and native sources
bun run check:release          # Verify maintainer-only binary release acknowledgements
bun run dev:app                # Start the hot-reloading preview
bun run dev:mcp                # Run the MCP server over stdio
bun run doctor                 # Report Xcode, Simulator, capture, and input capabilities
```

`bun run check` includes the toolchain and version gates, formatting, TypeScript
type-checking, Bun coverage tests, and XCTest. For a distributable build, run
`bun run release:build`; it rebuilds the arm64 CLI/core/probe and produces
the release manifest, checksums, packages, and CycloneDX SBOM. Run
`bun run smoke:npm` against the generated tarball before publishing. Packaging
must happen after a fresh release build so compiled MCP/CLI binaries and the
packaged native core cannot drift from source.

MCP sessions use `SimViewClient.acquire({ udid, codec })`, which shares one
detached native backend per Simulator UDID and compatible binary/protocol
identity. `SimViewClient.start()` remains the explicit ephemeral/test path;
set `SIMVIEW_BACKEND_MODE=ephemeral` when diagnosing the shared registry.
Backends stop capture as soon as their last authenticated client disconnects and
exit after the configured five-minute idle window. Registry records and tokens
are private temporary files and must never be logged.

If SwiftPM sandboxing fails in a managed environment, use `swift test --disable-sandbox --package-path native/SimViewCore`.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript, HTML, CSS, and Objective-C; use four
spaces in Swift. Biome is authoritative for TypeScript, TSX, JSON, CSS, and
HTML; `xcrun swift-format` and `xcrun clang-format` are checked in CI. Prefer
explicit types at protocol and process boundaries. Use `PascalCase` for types,
`camelCase` for functions and variables, and `snake_case` for public MCP tool
names. Keep source files focused by responsibility and run the formatter check
before submitting changes.

The root `package.json` is the authoritative version source. Manifests,
`packages/contracts/src/version.ts`, and
`native/SimViewCore/Sources/SimViewCore/Version.swift` are checked mirrors;
update them through the version workflow rather than introducing a second
source of truth. Keep `skipLibCheck` disabled and preserve the strict optional,
unused-symbol, and return-value checks in `tsconfig.json`.

## Testing Guidelines

TypeScript tests use `bun:test` and follow `*.test.ts`. Native tests use XCTest
and `*Tests.swift`. Add contract and fixture coverage for framing, malformed
payloads, schema changes, and Swift/TypeScript compatibility. Add real-simulator
coverage for capture, HID, accessibility, orientation, or private-API
compatibility. Never treat compilation alone as Simulator acceptance.

## Commit & Pull Request Guidelines

The repository has no established commit history yet. Use concise, imperative subjects such as `Add accessibility snapshot query`. Keep dependency upgrades separate from behavioral changes. Pull requests should explain the user-visible outcome, private-API risks, verification commands, and supported Xcode/runtime matrix. Include screenshots for preview changes and update `THIRD_PARTY_NOTICES.md` when adapting external code.

## Security & Configuration

Keep transports loopback-only and authenticated. Native sockets use a mode-0700
temporary directory, mode-0600 socket, and launch-time token; browser relay
HTTP uses `Authorization: Bearer`, and WebSockets authenticate in their first
message. Never log capability tokens, expose relay URLs in normal model-visible
state, or persist Simulator UI contents. Do not weaken path validation,
code-signing/release gates, or explicit probe/app-relaunch boundaries.
