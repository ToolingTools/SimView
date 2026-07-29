# Native protocol version 1

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
before authentication are rejected.

## Handshake

The first request must be:

```json
{
  "id": "uuid",
  "protocolVersion": 1,
  "method": "hello",
  "params": {
    "token": "random session token",
    "codecs": ["h264", "mjpeg"],
    "maxFrameRate": 60
  }
}
```

The response selects one codec and confirms the protocol version. Tokens are
read from the launch-time file descriptor and compared in constant time.

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

Public coordinates are normalized from 0 to 1. `input.touch` carries
`contactId`, `phase`, `x`, `y`, and may carry pressure and a monotonic timestamp.
Version 1 injects the first contact; the stable shape reserves compatible
multi-touch expansion.

Accessibility responses carry `schemaVersion: 1` and generation-scoped
`ax:<snapshot>:<ordinal>` references. References are not stable across
navigation; semantic actions re-resolve identifiers, roles, and names before
using existing physical HID input.

The optional probe is a bundled, read-only iOS Simulator dylib. `probe.enable`
requires an explicit non-Apple bundle identifier and terminates/relaunches that
app with per-launch `SIMCTL_CHILD_*` environment. It reports UIKit view,
controller, window, and scene context; accessibility remains available when the
probe is disabled or rejected.

Errors use:

```json
{
  "id": "uuid",
  "error": {
    "code": "DEVICE_NOT_BOOTED",
    "message": "Simulator is Shutdown, not Booted",
    "recoverable": true,
    "details": {}
  }
}
```
