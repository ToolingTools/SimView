# Contributing to SimView

SimView combines a Bun workspace with a Swift/Objective-C native boundary. By
contributing, you agree that your contribution is licensed under Apache-2.0.

The source repository is the supported contributor surface. Generated binaries
are build outputs and are intentionally excluded from Git; binary publishing is
maintainer-only and remains gated by signing, licensing, and real-Simulator
acceptance.

## Development setup

Install Bun 1.3.14 and an Xcode version listed in `docs/compatibility.md`, then
run:

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` is the normal pre-PR gate. It verifies Bun 1.3.14, version
consistency, Biome/Swift/Objective-C formatting, TypeScript, Bun tests with
coverage, and Swift tests. Run `bun run check:format` or `bun run check:version`
when iterating on one of those gates.

If SwiftPM cannot access its cache in a managed environment, use:

```sh
swift test --disable-sandbox --package-path native/SimViewCore
```

`bun run check:toolchain` deliberately rejects a different Bun version. Do not
regenerate `bun.lock` with another version.

For a release-shaped local build, use:

```sh
bun run release:build
bun run smoke:npm
```

The release build refreshes the packaged universal CLI, native core, and probe,
then writes checksums, a release manifest, packages, and a CycloneDX SBOM. Do
not package an npm, MCPB, or Codex artifact from stale `dist` or native output.

## Ownership and boundaries

- `packages/contracts` is the only shared TypeScript contract package. Add or
  change Zod schemas, inferred types, protocol method maps, and JSON fixtures
  there rather than duplicating request/result shapes in the app, CLI, client,
  or MCP server.
- `packages/client` owns framing, socket authentication, typed request
  correlation, deadlines/cancellation, partial writes, and ephemeral native
  process cleanup.
- `packages/mcp` owns one MCP stdio session, its per-review relay, preview
  buffers, and in-memory annotations. MCP sessions acquire a shared native
  backend per Simulator UDID, while review IDs and annotations remain isolated.
- `packages/client/src/daemon.ts` owns the registry record, atomic startup lock,
  binary/protocol compatibility identity, health verification, and sanitized
  status/stop/prune helpers. `SimViewClient.start()` remains the explicit
  ephemeral path and `SIMVIEW_BACKEND_MODE=ephemeral` is the diagnostic rollback.
- `native/SimViewCore` owns SimulatorKit/CoreSimulator access, capture and
  encoding, HID, accessibility, probe compatibility, and the authenticated
  Unix-socket server.

Keep private selectors and ABI assumptions in native compatibility modules.
Keep browser-safe data and validation in `packages/contracts`. If a protocol
method changes, update the Zod method map, Swift `Codable`/JSON handling, shared
fixtures, and both Bun/XCTest coverage in the same change.

The native backend is Simulator-global for capture, selected device, physical
input, orientation, and probe state. Treat those operations as shared-resource
operations even when they are requested by one review. The backend record lives
under a mode-0700 temporary registry; its record and socket are mode 0600, and
its token must not appear in logs or model-visible state. A compatible backend
is retained for five minutes after the last authenticated client disconnects,
while capture and encoders stop immediately.

## Change rules

- Put browser-safe Zod schemas and public wire types in `packages/contracts`.
- Update the shared JSON fixtures and both Bun/XCTest coverage for protocol
  changes. Unknown, malformed, and version-mismatched input must be rejected.
- Use `request<M extends Method>(method, params)` and parse both outbound
  parameters and inbound native results; do not reintroduce generic requests,
  `as never`, or unchecked protocol casts at a boundary.
- Add an MCP `outputSchema` for every structured tool result and validate the
  result before returning it. Annotation context must use the explicit JSON
  value schema rather than `z.any()`.
- Keep private selectors, symbols, framework paths, and ABI declarations in
  native compatibility modules.
- Preserve loopback-only authenticated transports, path validation, and the
  non-persistence of Simulator contents.
- Do not claim Simulator support from compilation alone. Capture, HID,
  accessibility, orientation, probe, and preview work require a real Simulator.
- Preserve the preview latency invariants documented in `docs/architecture.md`.
- Use unit-bearing CLI options such as `--timeout-ms` and `--duration-ms`, reject
  unknown flags, and keep human and JSON errors consistent.

## Pull requests

Keep behavioral and dependency/formatting changes separate where practical.
Describe the user-visible result, protocol compatibility, private-API risks,
verification commands, and Xcode/runtime matrix. Include screenshots for UI
changes and update `THIRD_PARTY_NOTICES.md` when adapting external code.

Every PR should state whether it changes the protocol, native private-API
compatibility, packaged artifacts, or the preview performance path. For a
release-affecting change, include the output of `simview doctor --json`, the
real-Simulator commands run, and any new or changed files in the generated
release manifest/SBOM.

Binary publishing is maintainer-only and remains disabled until every gate in
`docs/binary-redistribution.md` passes.
