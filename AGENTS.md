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

<!-- REPOWISE_AGENTS:START — Do not edit below this line. Auto-generated by Repowise. -->
## Codebase Intelligence for SimView (Repowise)

Indexed by [Repowise](https://repowise.dev). Last indexed: 2026-08-08 (commit 717a93d). Confidence: 98%.
The MCP tools below serve pre-verified docs, symbols, history, and health from that index. Every response carries `_meta` freshness fields; a `stale_warning` appears only when a file the response actually serves changed after indexing, so silence means current.

### How to work in this repo

- **Pre-edit phase** (locate, understand, assess) is where these tools win: `get_answer` for how/where/why, `search_codebase` to find, `get_context` for a file's map, `get_risk` before touching a hotspot.
- **Edit phase**: reading a file before you edit it is correct and expected. Use these tools to decide *which* files to read and edit, not to replace that read.
- **Noisy commands** (tests, builds, `git log`/`diff`, searches, listings): prefer `repowise distill <cmd>`, the same command with its exit code preserved and errors-first compact output. A `[repowise#<ref>: N lines omitted]` marker is fully recoverable via `repowise expand <ref>` (add `-q <regex>` to filter); never re-run the command to see omitted output.

### Trust protocol

- `verified: true` means the served bytes were checked against the live tree. Never follow it with a re-read of the same lines.
- `get_answer` at `confidence: "high"` or `grounding: "extracted"` is content-grounded: cite it directly. `symbol_bodies`, `quotes`, and `code_rationale` entries are live source, so use them instead of opening the file.
- The **only** re-read triggers: `bounds: "approximate"`, `_meta.stale_warning`, `search_method: "bm25"`, `confidence: "low"`. `index_behind: true` alone is informational; the served content is unaffected by the drift.
- Not valid reasons to re-read: "just to be safe", "to see full context" (use the skeleton or a range read), "the file might have changed" (`verified` already checked).
- For exhaustive literal sweeps (rename every call site) plain text search is unbeatable, so use it. Reach for `get_context(include=["callers"])` when you need the `callers_total`/`callers_truncated` honesty signal instead of a maybe-incomplete grep.

### Tools

| Tool | When and why |
|------|--------------|
| `get_answer(question)` | First call for any how / where / why question. `confidence: "high"` or `grounding: "extracted"` is content-grounded — cite it directly. When the question names an indexed symbol, `symbol_bodies` carries its full live body (skip the `get_symbol` follow-up). Low confidence returns `best_guesses` with one-line justifications plus `code_rationale` (rationale comments mined live from candidate source). |
| `get_context(targets=[...])` | Triage card for files/modules/symbols: summary, signatures, `symbol_id`s, `hotspot` bit. File targets auto-serve a `verified` skeleton (every signature at a fraction of a full Read); `mostly_full` marks files where Read costs little more. Batch targets in one call. Opt-in blocks: `include=["callers"|"callees"|"ownership"|"decisions"|"metrics"]`. |
| `get_symbol(id)` | One verified body: `"path.py::Name"` (indexed symbol), `"path.py:140-180"` (live range read), or `"repowise#<hex>"` (omission ref). Source arrives in Read's numbered format — treat it as an already-performed Read. `truncated` responses carry a `continuation` naming the exact next range; ambiguous ids return every match in `candidates`. Index misses fall back to live-grep `fallback_lines`. |
| `search_codebase(query)` | Hybrid search, auto-routed by query shape: identifier → symbol hits (pipe `symbol_id` into `get_symbol`), path → file pages, prose → wiki-semantic. Force with `mode=symbol|path|concept|hybrid`. Concept hits carry a `sources` list; a hit whose sources are `[fts]` only is a keyword match with no semantic agreement — verify it. |
| `get_why(query, targets?)` | Why the code is shaped this way: decision records with evidence and supersession lineage, falling back to git archaeology and `code_rationale` comments. Call before refactors or pattern divergences. |
| `get_risk(targets, changed_files?)` | What history says about touching these files: churn, owners, co-change partners, blast radius. PR mode (`changed_files`) leads with a `directive` block — read `will_break` / `missing_cochanges` / `missing_tests` / `tests_to_run` first. `tests_to_run` is coverage-backed (the tests the per-test map proves exercise the changed files); empty means unknown, never no tests. To score a whole commit or diff range instead, use `get_change_risk`. |
| `get_change_risk(revspec, extensions?, exclude_patterns?)` | Pre-merge defect score for a whole commit or `base..head` range, computed from its diff shape on the live checkout (no index, no LLM). Lead with `risk_percentile` (this change ranked against sampled recent commits), summarized by `review_priority` and `classification`; `score` / `probability` / `level` are the corpus-calibrated fallback. Distinct from `get_risk`, which scores indexed files by path. A `warning` field flags an empty diff (bad revspec or over-tight extension / exclusion filters). |
| `get_health(targets?, include?)` | Health scores + findings on three dimensions (defect / maintainability / performance). Self-check the files you touched before finishing; `include=["biomarkers"|"refactoring"|"signals"]` for depth. |
| `get_dead_code()` | Confidence-tiered unreachable files / unused exports / zombie packages. For cleanup sweeps, not targeted fixes. |
| `get_overview()` | Architecture map + tool recipes. Call once, first, in an unfamiliar repo; skip it after that. |

**Compose them:** low-confidence `get_answer` then read `best_guesses[0].file`; `get_context` shows `hotspot: true` then `get_risk` before editing; `decision_records` titles then `get_why(targets=[...])`; PR review then `get_risk(targets, changed_files)` and read `directive` first. A `tombstone` error means the file moved, so follow `successor_paths`.

### Architecture
SimView consumes commands and UI-inspection requests from MCP, CLI, web, and native clients, routes them through typed contracts and authenticated transports to Android or iOS Simulator backends, and produces screenshots, accessibility trees, input actions, annotations, and inspection results. SimView is a monorepo with TypeScript packages and native platform implementations. It supports shared per-Simulator backend processes, validated protocol framing, session state, and browser-based preview workflows. Primary flows include CLI commands entering packages/cli/src/index.ts::run, MCP requests entering SimViewSession, and Android commands entering Main::main and AgentSession::run.

### Key modules
- `packages/contracts/src` — I’m using the repository’s graphify guidance to inspect the contract relationships before writing, so the page reflects the subsystem as a…
- `native/SimViewCore/Sources/SimViewCore` — I’m using the repository’s simview:graphify guidance because this is a codebase-subsystem documentation task; I’ll use it to keep the page…
- `packages/app` — Preview App Runtime connects the TypeScript preview, CLI, and client entrypoints, turning developer commands and preview interactions into…
- `scripts` — Release and toolchain automation turns repository, version, and build configuration inputs into Android-agent, probe, package, and release…
- `native/SimViewCore` — I’m using the repository’s graphify guidance because this is a codebase-synthesis task; I’ll inspect the scoped Swift files and their…
- `packages/mcp/src` — MCP application delivery and relay orchestration accepts MCP requests, session interactions, and Metro-backed app resources, then produces…
- `native/SimViewAndroid/src/dev/simview/agent` — I’m using the repository’s graphify guidance to inspect the supplied Android agent files as one subsystem, then I’ll write the…

### Entry points
- `packages/mcp/src/server.ts`
- `native/SimViewCore/Sources/SimViewCore/Server.swift`
- `native/SimViewCore/Sources/SimViewCore/main.swift`
- `native/SimViewAndroid/src/dev/simview/agent/Main.java`

### Files that need care (bug-fix history first, then churn — check `get_risk` before editing)
- `packages/mcp/src/server.ts` — 3 bug fixes, last fix 3 days ago; 17 commits/90d
- `packages/app/src/index.tsx` — 3 bug fixes, last fix 8 days ago; 18 commits/90d
- `tests/mcp-tools.test.ts` — 2 bug fixes, last fix 3 days ago; 13 commits/90d
- `native/SimViewCore/Sources/SimViewAXShim/SimViewAXShim.m` — 2 bug fixes, last fix 8 days ago; 5 commits/90d
- `packages/mcp/src/session.ts` — 2 bug fixes, last fix 8 days ago; 11 commits/90d

### Code health
Three co-equal signals: defect risk 5.9/10 avg, hotspot health 4.72/10 (stable), worst `packages/cli/src/index.ts` at 1.0/10 · maintainability 8.45/10 · performance risk 39 open static I/O-in-loop / N+1 findings. Detail: `get_health()`.

Critical files:
- `packages/cli/src/index.ts` — complex conditional (run) — impact −1.7
- `packages/app/src/helpers.ts` — complex conditional (commentableNodeAtPoint) — impact −1.4
- `README.md` — change entropy — impact −1.3
- `docs/distribution.md` — change entropy — impact −1.3
- `packages/client/src/protocol.ts` — churn risk — impact −1.3

### Standing decisions (ask `get_why` before diverging)
- The protocol-v2 SimViewMethodMap is the single validation boundary — A single declared map makes unknown methods and malformed frames and unsupported protocol versions a
- Android shares the user's ADB server and degrades rather than requiring the agent — Mutating a shared adb server breaks the developer's own tooling, and an agent that is required rathe
- Capability tokens travel by file descriptor and are never observable — A token in the process list or in a log line is readable by any local user and survives in scrollbac

### Commands
- Build: `npm run build`
- Test: `npm run test`
- Typecheck: `npm run typecheck`

<!-- REPOWISE_AGENTS:END -->

<!-- REPOWISE_DISTILL:START — Do not edit below this line. Auto-generated by Repowise. -->
### Output Distillation

- Prefer `repowise distill <cmd>` for noisy commands — test runs, builds, `git status`/`log`/`diff`, searches, file listings. It runs the command unchanged (exit code preserved) and prints a compact, errors-first rendering; every error line survives.
- Output may contain a marker like `[repowise#a1b2c3d4e5f6: 230 lines omitted (~6.1k tokens); restore: repowise expand a1b2c3d4e5f6]`. The omitted content is fully preserved — run `repowise expand <ref>` to retrieve it, or `repowise expand <ref> -q <regex>` for just the matching lines.
- Never re-run a command to see omitted output; expand the marker instead.
- For structure-level questions about a large indexed file ("what's in here", "which function handles X"), `get_context(["path"], include=["skeleton"])` returns the file with bodies elided — every signature plus the bodies of the most central symbols — at a fraction of the cost of a full Read.
<!-- REPOWISE_DISTILL:END -->
