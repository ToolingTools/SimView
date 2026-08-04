# Runner protocol v1

Every frame is one byte of kind, a four-byte unsigned big-endian payload length,
then the payload. Requests are limited to 4 MiB and responses to 64 MiB.

| Kind | Direction | Payload |
| --- | --- | --- |
| `0x01` | host to runner | JSON request |
| `0x02` | runner to host | JSON response |
| `0x10` | runner to host | AVCDecoderConfigurationRecord (`avcC`) |
| `0x11` | runner to host | UInt64 BE monotonic microseconds, keyframe byte, AVCC sample |

Requests have `{ "id", "protocolVersion": 1, "method", "params" }`.
Responses have either `{ "id", "ok": true, "result" }` or
`{ "id", "ok": false, "error": { "code", "message", "recoverable" } }`.
`authenticate` with `{ "token" }` must be the first request on every TCP
connection. Authentication state is not retained across reconnects.

## Methods

- `authenticate {token}` returns the protocol version, `ios-xcui` source, and
  backend-derived capabilities. Physical iOS always reports `rawTouch: false`
  and `uikitProbe: false`.
- `health` reports authentication, target app, streaming state, frame count,
  average stream rate, and guarded private-screenshot availability.
- `selectApp {bundleId}` selects the XCUI target for semantic and input calls.
- `screenshot {quality?}` returns full PNG data as base64 plus pixel dimensions,
  scale, monotonic timestamp, and `capturePath`. `full` always uses public XCUI;
  `preview` may use the guarded private compatibility seam.
- `snapshot {maxDepth?,maxChildren?}` returns the repository's public
  accessibility snapshot envelope with `ios-xcui` source, bounded nodes,
  screen bounds, and truncation stats. Node frames contain `points` and
  `normalized` rectangles.
- `find {selector,timeout?}` and `wait {selector,exists?,timeout?}` accept
  `identifier`, `label`, `value`, and/or numeric XCUI `type` fields.
- `elementAtPoint {x,y}` returns the smallest public accessibility node
  containing the normalized screen point, or an element-not-found error.
- `tap {x,y}`, `longPress {x,y,duration?}`, `drag|swipe {from,to,duration?}` use
  normalized screen coordinates and public XCUICoordinate gestures.
- `typeText {text}`, `pressButton {button}`, and
  `setOrientation {orientation}` use public XCUI device APIs. Supported button
  names are `home`, `volume-up`, `volume-down`, `action`, and `camera`; capabilities
  include only buttons reported by the connected device. On iOS 15, where Apple
  does not expose hardware-button discovery, only `home` is accepted.
- `activateApp`, `terminateApp`, `startStream {fps?,maxLongEdge?,bitrate?}`,
  `stopStream`, `requestKeyframe`, and `shutdown` complete the lifecycle.

The server accepts one active host connection. A replacement or failed
connection stops streaming and requires a fresh authenticated session.
