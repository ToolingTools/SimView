# Deferred Performance and Reliability Plan

Status: Implemented; real-device performance acceptance pending  
Created: 2026-08-08  
Scope: Follow-up work intentionally deferred from the semantic observation and input review.

## Context

The current working tree has passed the full repository verification gate:

- `bun run check`
- 99 Bun tests
- 28 Swift tests
- Release-mode `simview-core`, Android agent, preview, probe, and CLI builds

The work below was deferred because it changes buffering, latency, or public paging semantics and should be implemented with measurements and focused tests rather than as speculative refactoring.

## Work Summary

| ID | Priority | Workstream | Current risk or cost | Primary files | Status |
| --- | --- | --- | --- | --- | --- |
| DPR-1 | High | Bound Android H.264 observation decoding | Access units can be queued and submitted to VideoToolbox without an explicit upper bound; decode failures are mostly silent. Sustained decoder lag could increase memory use and semantic-observation latency. | `native/SimViewCore/Sources/SimViewCore/Encoding/H264Decoder.swift`, `native/SimViewCore/Sources/SimViewCore/Server.swift`, `native/SimViewCore/Sources/SimViewCore/Metrics.swift` | Implemented; emulator smoke pending |
| DPR-2 | Medium | Make prepared JPEG work policy-aware | Unchanged frames now reuse the image cache, but meaningful changes are still prepared eagerly in semantic-only sessions. This spends CPU for sessions that may never request visual output. | `native/SimViewCore/Sources/SimViewCore/Observation/ObservationCoordinator.swift`, `native/SimViewCore/Sources/SimViewCore/Server.swift`, `native/SimViewCore/Sources/SimViewCore/Encoding/ImageEncoder.swift` | Implemented; device benchmark pending |
| DPR-3 | Medium | Snapshot device inventory pagination | Every App page can trigger a fresh native device enumeration. Large or changing inventories repeat expensive work and can duplicate or omit devices between offset-based pages. | `packages/mcp/src/server.ts`, `packages/contracts/src/mcp.ts`, `packages/app/src/index.tsx`, `tests/mcp-tools.test.ts` | Complete |

## DPR-1: Bound Android H.264 Observation Decoding

### Objective

Keep the observation-only H.264 decode path bounded under sustained load, surface failures, and recover on a keyframe without changing the H.264 packets delivered to preview clients.

### Investigation

1. Add temporary benchmark instrumentation for:
   - access units received;
   - decode submissions and callbacks;
   - queued and outstanding decode work;
   - callback latency;
   - dropped observation frames;
   - VideoToolbox submission and callback failures.
2. Exercise an Android emulator at the supported frame rates while:
   - no observations are requested;
   - semantic observations are requested repeatedly;
   - visual observations and preview streaming run together;
   - CPU pressure is introduced on the host.
3. Record the baseline queue depth, memory growth, and observation latency before selecting limits.

### Implementation

1. Extract a small, testable decoder scheduling policy from `H264Decoder`.
2. Pass keyframe information into the observation decoder instead of accepting only raw access-unit bytes.
3. Bound queued and outstanding work using the measured limit.
4. Do not discard arbitrary inter-frames and then continue decoding from an invalid dependency chain. On overflow:
   - enter a resynchronization state;
   - drop observation-only access units until a keyframe;
   - request a keyframe from the Android agent;
   - recreate or flush the VideoToolbox session if required;
   - resume from the keyframe.
5. Add an explicit decoder failure callback and a bounded consecutive-failure policy in `SimViewServer`.
6. Extend health metrics without exposing tokens, socket paths, or device contents.

### Tests and acceptance criteria

- Unit-test the scheduling policy with a fake decoder clock and deterministic keyframe sequence.
- Prove queued plus outstanding observation decode work never exceeds the selected bound.
- Prove overflow recovery waits for a keyframe and does not corrupt subsequent observations.
- Prove repeated decode failures trigger one bounded recovery/fallback path rather than a retry loop.
- Verify preview packet delivery is unchanged because only the observation decoder is bounded.
- Run real-emulator smoke tests on at least one current and one older supported Android runtime.
- Define latency and memory thresholds from the recorded baseline, then document them in the test or benchmark output.

### Rollback boundary

Keep the scheduling policy behind one decoder-local switch until real-device verification passes. Reverting it must restore the existing submission behavior without changing the wire protocol.

## DPR-2: Policy-Aware Prepared JPEG Work

### Objective

Avoid JPEG preparation in semantic-only sessions while preserving fast cached visual observations in hybrid/preview workflows.

### Investigation

1. Measure actual encode count, duration, and CPU use for:
   - a static screen;
   - animation at 60 fps;
   - frequent meaningful screen changes;
   - semantic-only and hybrid sessions.
2. Measure first-visual-observation latency with eager and on-demand encoding.

### Implementation

1. Introduce an explicit image preparation policy, for example:
   - `eagerOnChange` for hybrid sessions;
   - `onDemand` for semantic sessions.
2. Set the policy from the existing `observationMode` during capture startup and mode changes.
3. In on-demand mode:
   - do not encode during `ingest`;
   - schedule one encode when a visual observation requests the current `changeRevision`;
   - coalesce concurrent requests for that revision;
   - retain the existing generation guard and bounded failure behavior.
4. Continue caching images by `changeRevision`, so visually unchanged frames reuse the prepared image.
5. Count actual encode attempts/completions in metrics rather than only images returned to clients.

### Tests and acceptance criteria

- Inject or wrap the image encoder so coordinator tests can count attempts deterministically.
- Prove a semantic-only session performs zero JPEG encodes.
- Prove the first visual request prepares and returns one image within its deadline.
- Prove concurrent visual requests share one encode for the same revision.
- Prove an unchanged frame is a cache hit and a meaningful change invalidates the cache.
- Prove encoder failure does not create a zero-delay retry loop and a later visual request can retry.
- Compare first-visual latency against the baseline before making on-demand mode the default anywhere new.

### Rollback boundary

Keep the existing eager-on-change behavior as the hybrid policy. If on-demand latency is unacceptable, semantic mode can temporarily select the eager policy without a protocol change.

## DPR-3: Snapshot Device Inventory Pagination

### Objective

Enumerate native devices once per paging traversal and return a stable, bounded snapshot to the MCP App.

### Contract design

1. Preserve the current first-page request for compatibility.
2. Extend the result with an opaque snapshot/cursor value for continuation.
3. Continuation requests should accept only the cursor; filter, offset, platform, and availability options remain fixed by the first request.
4. Keep cursor values private and random. Do not encode device inventory or filesystem information in them.

### Implementation

1. Add a per-MCP-session inventory snapshot cache with:
   - a short explicit TTL;
   - a small fixed entry count;
   - eager deletion after the final page;
   - invalid/expired cursor errors.
2. Store the filtered, deterministically sorted inventory once and page that immutable snapshot.
3. Update the App loop to use the returned continuation cursor.
4. Retain offset paging as a compatibility path for older callers, but do not use it for the App traversal.
5. Ensure session close clears cached inventories.

### Tests and acceptance criteria

- Count calls to `SimViewClient.listDevices()` and prove a multi-page traversal calls it once.
- Mutate the mocked native inventory between pages and prove the active traversal remains stable.
- Prove a new traversal sees the new inventory.
- Test cursor expiry, reuse after completion, malformed cursors, and option changes during continuation.
- Prove cache entry count and retained inventory size are bounded.
- Verify current single-page callers remain compatible.

### Rollback boundary

The offset fields remain available until cursor paging has shipped and been exercised. The App can revert to offset paging independently of the server cache.

## Recommended Execution Order

1. Capture baselines and add benchmark scaffolding for DPR-1 and DPR-2.
2. Implement DPR-1, because unbounded decoder work has the highest reliability risk.
3. Implement DPR-2 using the decoder and observation metrics established earlier.
4. Implement DPR-3 independently after the native performance work is stable.
5. Run the full verification and platform smoke matrix.

## Verification Checklist

Run after each workstream where applicable:

```sh
bun run check:toolchain
bun run check:format
bun run typecheck
bun test
swift test --package-path native/SimViewCore
bun run build:android-agent
```

Before merging the complete plan:

```sh
bun run check
bun run doctor
```

Also complete real-Simulator/emulator acceptance for capture, observation stability, keyframe recovery, accessibility, and preview delivery. Compilation alone is not device acceptance.

## Out of Scope

- Changing the public frame wire format.
- Dropping or transcoding preview packets to solve observation decoder pressure.
- Persisting device inventories across MCP sessions.
- Increasing queue or cache limits without measurements.
- Broad refactors of unrelated capture, relay, or accessibility code.

## Completion Record

When work begins, update each row in the summary table and record:

- implementation commit or pull request;
- benchmark before/after results;
- test commands and supported runtime matrix;
- any accepted trade-offs or follow-up tasks.

### 2026-08-08 implementation

- Implementation: current working tree; no commit or pull request created.
- DPR-1 bounds observation-only decode admission to four queued plus outstanding access units. Overflow invalidates the observation decoder, requests a keyframe, and drops observation access units until that keyframe. Three consecutive decoder failures trigger the existing single-restart-then-fallback path. Preview H.264 packets remain broadcast independently and unchanged. Set `SIMVIEW_BOUNDED_ANDROID_OBSERVATION_DECODER=0` for the decoder-local rollback switch.
- DPR-1 health metrics now expose access units, submissions, callbacks, queued and outstanding work, peak work, drops, recoveries, submission/callback failures, and callback latency without device content or transport secrets.
- DPR-2 maps semantic capture to `onDemand` and hybrid capture to `eagerOnChange`. On-demand visual requests coalesce by generation and change revision; policy changes cancel stale scheduled work. Metrics count actual preparation attempts and completions.
- DPR-3 uses 30-second random continuation cursors, at most four active snapshots, at most 250 retained devices per snapshot, cursor-only continuation, eager final-page deletion, and session-close cleanup. Offset paging remains available for compatibility.
- Deterministic acceptance: 101 Bun tests and 34 Swift tests pass. The new tests cover decode bounds/keyframe recovery, bounded failure recovery, zero semantic-only JPEG work, policy-switch cancellation, coalesced on-demand encoding, failure retry, stable device traversal, native enumeration count, mutation isolation, expiry, malformed/changed continuation, completion reuse, cache count, and retained-size bounds.
- Build and static verification: Bun 1.3.14 toolchain check, TypeScript typecheck, targeted Biome/Swift formatting, the full release-mode repository build, and Android-agent build pass.
- Runtime matrix: `bun run doctor` reports Android tooling operational but no connected Android devices, and no available iOS Simulator runtime. Current/older Android runtime smoke, CPU-pressure baselines, memory growth, preview delivery, and first-visual latency measurements remain pending on device-capable hosts; no device benchmark numbers are claimed here.
- Accepted trade-off: inventories beyond 250 matching devices are explicitly marked `snapshotTruncated`; callers still receive the true filtered total. The bound prevents an MCP session from retaining an unbounded native inventory.
