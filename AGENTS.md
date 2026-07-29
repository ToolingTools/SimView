# Repository Guidelines

## Project Structure & Module Organization

SimView is a Bun workspace with a native Swift boundary:

- `packages/app`: Preact MCP App preview.
- `packages/client`: binary protocol types and native-process lifecycle.
- `packages/core`: packaged `simview-core` resolver.
- `packages/cli`: command-line interface.
- `packages/mcp`: MCP tools, session state, and authenticated relay.
- `native/SimViewCore`: Swift executable, Objective-C accessibility shim, and XCTest suite.
- `tests`: Bun integration and protocol tests.
- `scripts`: release, plugin, MCPB, and simulator-smoke tooling.
- `docs`, `plans`, `skills`, and `assets`: contracts, implementation plans, agent guidance, and branded media.

Keep private selectors inside native compatibility modules. Shared wire types belong in `packages/client`.

## Build, Test, and Development Commands

Use Bun 1.3.14 and commit `bun.lock`.

```sh
bun install --frozen-lockfile  # Install exact dependencies
bun run build                  # Build app, packages, and release-mode native core
bun run typecheck              # Run TypeScript without emitting files
bun test                       # Run Bun tests
bun run check                  # Typecheck plus Bun and Swift tests
bun run dev:app                # Start the hot-reloading preview
bun run dev:mcp                # Run the MCP server over stdio
bun run doctor                 # Report Xcode, Simulator, capture, and input capabilities
```

If SwiftPM sandboxing fails in a managed environment, use `swift test --disable-sandbox --package-path native/SimViewCore`.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript, HTML, CSS, and Objective-C; use four spaces in Swift. Prefer explicit types at protocol and process boundaries. Use `PascalCase` for types, `camelCase` for functions and variables, and `snake_case` for public MCP tool names. Keep source files focused by responsibility. No formatter or linter is configured, so match surrounding style and run `bun run typecheck`.

## Testing Guidelines

TypeScript tests use `bun:test` and follow `*.test.ts`. Native tests use XCTest and `*Tests.swift`. Add protocol tests for framing or schema changes and real-simulator coverage for capture, HID, accessibility, orientation, or private-API compatibility. Never treat compilation alone as Simulator acceptance.

## Commit & Pull Request Guidelines

The repository has no established commit history yet. Use concise, imperative subjects such as `Add accessibility snapshot query`. Keep dependency upgrades separate from behavioral changes. Pull requests should explain the user-visible outcome, private-API risks, verification commands, and supported Xcode/runtime matrix. Include screenshots for preview changes and update `THIRD_PARTY_NOTICES.md` when adapting external code.

## Security & Configuration

Keep transports loopback-only and authenticated. Never log capability tokens or persist simulator UI contents. Do not weaken path validation, code-signing checks, or explicit probe/app-relaunch boundaries.
