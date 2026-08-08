# Native protocol version 3

The TypeScript source of truth for this protocol is
`packages/contracts/src/protocol.ts`. It exports the `SimViewMethodMap`,
`ParamsFor<M>`, `ResultFor<M>`, protocol constants, and Zod parsers used by the
client and MCP server. Swift keeps an explicit `Codable` mirror. Changes to a
method, event, or error must update the contract, Swift handling, fixtures, and
both Bun/XCTest coverage together.

`simview-core serve` accepts authenticated clients over a Unix domain socket.
Every frame has a five-byte header:

```text
uint8  kind
uint32 payload_length_be
bytes  payload
```

| Kind | Payload |
| --- | --- |
| `0x01` | UTF-8 JSON request |
| `0x02` | UTF-8 JSON response |
| `0x10` | H.264 decoder configuration in `avcC` format |
| `0x11` | 8-byte big-endian microsecond timestamp, 1-byte keyframe flag, AVCC NAL data |
| `0x12` | JPEG frame |
| `0x20` | PNG screenshot |

The maximum payload is 64 MiB. Unknown kinds, oversized frames, and requests
before authentication are rejected. Receivers must accept arbitrary TCP/Unix
socket fragmentation and coalescing; a frame is complete only after its full
five-byte header and payload have arrived.

## Handshake

The first request must be:

```json
{
  "id": "uuid",
  "protocolVersion": 3,
  "method": "hello",
  "params": {
    "token": "32-byte random session token",
    "codecs": ["h264", "mjpeg"],
    "maxFrameRate": 60
  }
}
```

The response selects one codec and confirms the protocol version. Tokens are
read from the launch-time file descriptor and compared in constant time. The
token is never written to logs, process arguments, MCP structured state, or a
browser URL. Unauthenticated sockets are closed after the native handshake
deadline.

After the handshake, each request has the following shape:

```json
{
  "id": "uuid",
  "protocolVersion": 3,
  "method": "devices.list",
  "params": {}
}
```

The client parses `params` against the method schema before sending and parses
the corresponding `result` schema after receiving it. Native errors retain a
stable code, message, recoverability flag, and JSON details object. A response
must contain a result or an error; the client then validates the selected
method's result shape.

## Methods

- `devices.list`
- `device.describe`
- `capture.start`
- `capture.preview`
- `capture.stop`
- `capture.keyframe`
- `capture.screenshot`
- `input.touch`
- `input.gesture`
- `input.tap`
- `input.longPress`
- `input.swipe`
- `input.typeText`
- `input.key`
- `input.button`
- `device.orientation.set`
- `accessibility.snapshot`
- `accessibility.observe`
- `accessibility.elementAtPoint`
- `accessibility.find`
- `accessibility.wait`
- `probe.status`
- `probe.enable`
- `probe.disable`
- `probe.context`
- `probe.inspectPoint`
- `probe.findViews`
- `probe.fullHierarchy`
- `health.get`
- `server.shutdown`

`devices.list` returns a normalized `DeviceDescription`. `id` is an opaque,
namespaced identifier such as `ios:<uuid>` or `android:<adb-serial>`;
`platform`, `kind`, `state`, and `available` are normalized independently of
CoreSimulator and ADB spelling. `capabilities` declares capture, touch, text,
buttons, orientation, accessibility, Android context, and UIKit probe support.
`input.rawTouch` distinguishes continuous contact injection from discrete
tap/swipe shell fallbacks when present. `input.multiTouch` advertises support
for two simultaneous pointer tracks.
`udid` is present for iOS and `serial` for Android. Selected-device parameters
use `deviceId`; `udid` remains an iOS compatibility alias for one release.

Public coordinates are normalized from 0 to 1. `input.touch` carries
`contactId`, `phase`, `x`, `y`, and may carry pressure and a monotonic timestamp.
`input.gesture` carries one or two pointer tracks with bounded, monotonic
timestamps. On iOS Simulator, two-track gestures use the private SimulatorKit
legacy HID client and `IndigoHIDMessageForMouseNSEvent`; the capability is
reported only when both are available in the active Xcode runtime. This is the
same class of Simulator-only HID path used for pointer input and supports pinch
gestures without synthesizing Option-key UI interaction. Android uses the
packaged agent's multi-pointer `MotionEvent` injection.

Accessibility responses carry `schemaVersion: 1` and generation-scoped
`ax:<snapshot>:<ordinal>` references. References are not stable across
navigation; semantic actions re-resolve identifiers, roles, and names before
using existing physical HID input.

`accessibility.observe` accepts an optional opaque `afterRevision`, a scope,
node limit, quiet-settle window, bounded maximum wait, and `requireChange`.
`requireChange` defaults to true for change observation; interaction
re-resolution sets it to false so an unchanged fresh tree becomes stable only
after the requested quiet period. The result includes `revision`,
`eventChanged`, `stable`, `timedOut`, `strategy`, and settlement timestamps.
Additive diagnostics report `fallbackUsed`, `captureCount`, and `changeSource`
(`event`, `snapshot-diff`, or `none`) without changing the protocol version.
iOS keeps AXP event-first. When no event arrives, it probes after 150 ms with at
most two snapshot captures: a changed first probe is confirmed once after the
quiet window, while an unchanged first probe reserves its second capture for
the deadline. A stable fallback diff is reported as a changed, settled result;
a still-changing confirmation is unstable.
Transient root-only iOS trees are retried three times with a 25 ms delay;
persistent root-only application placeholders are returned as degraded rather
than complete. Event-backed observation debounces before one post-event capture.
The current Android agent runs a bounded shell `uiautomator dump` and reports
`android-agent-shell`; without the agent the host reports
`android-uiautomator`. Shell observation polls from 150 ms with backoff to
500 ms, and root-only/zero-sized results receive at most two retries. A future
direct agent `UiAutomation` capture is reserved as
`android-agent-uiautomation`, but is not currently advertised.

Accessibility selectors must include at least one of `ref`, `identifier`,
`role`, `name`, or `value`. `accessibility.wait` uses `state: "visible"` or
`state: "hidden"`; the same names are used by the CLI and MCP tools. Probe
inspection exposes `probe.target` so callers can see the currently selected
bundle before requesting context or changing it.

At the MCP layer, `get_element_tree` and its app-only alias return a versioned
element snapshot plus frame-scoped screen context. The snapshot source is
`react-native-fiber` when a matching local Metro/Hermes development target can
be inspected, otherwise `core-simulator-ax` on iOS or
`android-agent-shell` is used when the persistent Android agent is available;
`android-uiautomator` is the bounded host fallback when it is not.
React Native nodes use
generation-scoped `rn:<ordinal>` references and may include component ancestry,
host type, test ID, visible text, measured bounds, and a project-relative source
location. Native results from this unified layer include a bounded Metro
fallback reason. The native protocol, CLI `ax-tree`, and
`get_accessibility_tree` bypass Metro but retain their compatibility names.
Screen context is platform-qualified; Android context may include the
foreground package, activity, process, and task.

MCP semantic taps always return the successful physical-input receipt under
`interaction`. Destination verification mismatch is a hard-stop MCP error with
`accepted: false`, `safeToContinue: false`, `inputDispatched: true`, and
`code: "destination_mismatch"`; unstable or unavailable verification uses
`destination_unconfirmed` and is retryable. Multiple native matches use the
non-retryable hard-stop code `destination_ambiguous`. Failed checks may include up to
three native-derived selector `suggestions`, never refs or indexes. Search
keeps ordinary `matches` visible and actionable while reporting bounded
`excludedCandidates` with exclusion reasons and swipe guidance.
Destination selectors use exact matching by default. Callers that know only a
stable fragment of a composite native AX label must set `exact: false`; they
must not assume an identifier fragment is a complete accessible name. When a
later destination-verification snapshot proves the native tree settled, its
revision and fallback diagnostics supersede an earlier embedded post-action
timeout in the returned observation receipt.
`verifyDestination.timeoutMs` is bounded to 100–5000 milliseconds.
`verifyDestination.identity` must match exactly one native node, while each
optional `verifyDestination.assertions` selector must be present at least once.
An identity count above one returns the hard-stop code `destination_ambiguous`, `inputDispatched: true`,
`safeToContinue: false`, and `retryable: false`; callers must strengthen the
identity without repeating the accepted tap. Assertions may match multiple nodes,
for example when an amount is displayed in both total and outstanding fields.
When React Native supplies screen context while native AX supplies the
rendered semantic nodes, compact text reports both as
`context=react-native-fiber ... elements=core-simulator-ax`.

`health.get` is a diagnostic response. It reports server status, native PID,
instance ID, configured device ID, selected device, capture state, idle deadline,
capabilities, authenticated client counts (including counts by codec), and
bounded capture metrics. It deliberately excludes socket paths and capability
tokens.

The native server supports multiple authenticated clients and broadcasts one
H.264 or MJPEG stream to clients that requested that codec. `capture.stop` is a
process-global capture operation in the current protocol; callers should treat
device selection, orientation, physical input, and probe state as device-global
rather than review-local. Protocol version 3 supports both the explicit
ephemeral client path and the shared daemon client path; the latter is selected
by `SimViewClient.acquire` and is keyed by platform plus native identifier and compatible
binary/protocol identity. Review isolation is provided above the native
protocol by the MCP session's `reviewId` and per-review relay/annotation state.

The optional probe is a bundled, read-only iOS Simulator dylib and is
capability-gated off for Android. `probe.enable`
requires an explicit non-Apple bundle identifier and terminates/relaunches that
app with per-launch `SIMCTL_CHILD_*` environment. It reports UIKit view,
controller, window, and scene context; accessibility remains available when the
probe is disabled or rejected.

Errors use:

```json
{
  "id": "uuid",
  "error": {
    "code": "DEVICE_UNAVAILABLE",
    "message": "Device is offline",
    "recoverable": true,
    "details": {}
  }
}
```
