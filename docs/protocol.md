# Native protocol version 2

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
  "protocolVersion": 2,
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
  "protocolVersion": 2,
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
- `capture.stop`
- `capture.keyframe`
- `capture.screenshot`
- `input.touch`
- `input.tap`
- `input.longPress`
- `input.swipe`
- `input.typeText`
- `input.key`
- `input.button`
- `device.orientation.set`
- `accessibility.snapshot`
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
tap/swipe shell fallbacks when present.
`udid` is present for iOS and `serial` for Android. Selected-device parameters
use `deviceId`; `udid` remains an iOS compatibility alias for one release.

Public coordinates are normalized from 0 to 1. `input.touch` carries
`contactId`, `phase`, `x`, `y`, and may carry pressure and a monotonic timestamp.
Version 2 injects the first contact; the stable shape reserves compatible
multi-touch expansion.

Accessibility responses carry `schemaVersion: 1` and generation-scoped
`ax:<snapshot>:<ordinal>` references. References are not stable across
navigation; semantic actions re-resolve identifiers, roles, and names before
using existing physical HID input.

Accessibility selectors must include at least one of `ref`, `identifier`,
`role`, `name`, or `value`. `accessibility.wait` uses `state: "visible"` or
`state: "hidden"`; the same names are used by the CLI and MCP tools. Probe
inspection exposes `probe.target` so callers can see the currently selected
bundle before requesting context or changing it.

At the MCP layer, `get_element_tree` and its app-only alias return a versioned
element snapshot plus frame-scoped screen context. The snapshot source is
`react-native-fiber` when a matching local Metro/Hermes development target can
be inspected, otherwise `core-simulator-ax` on iOS or `android-uiautomator` on
Android. React Native nodes use
generation-scoped `rn:<ordinal>` references and may include component ancestry,
host type, test ID, visible text, measured bounds, and a project-relative source
location. Native results from this unified layer include a bounded Metro
fallback reason. The native protocol, CLI `ax-tree`, and
`get_accessibility_tree` bypass Metro but retain their compatibility names.
Screen context is platform-qualified; Android context may include the
foreground package, activity, process, and task.

`health.get` is a diagnostic response. It reports server status, native PID,
instance ID, configured device ID, selected device, capture state, idle deadline,
capabilities, authenticated client counts (including counts by codec), and
bounded capture metrics. It deliberately excludes socket paths and capability
tokens.

The native server supports multiple authenticated clients and broadcasts one
H.264 or MJPEG stream to clients that requested that codec. `capture.stop` is a
process-global capture operation in the current protocol; callers should treat
device selection, orientation, physical input, and probe state as device-global
rather than review-local. Protocol version 2 supports both the explicit
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
