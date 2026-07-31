# Security policy

Do not disclose suspected vulnerabilities in a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/ToolingTools/SimView/security/advisories/new)
to contact the maintainers. Include affected versions, reproduction steps,
impact, and any suggested mitigation. A maintainer will acknowledge a complete
report within seven days.

Only the latest source revision and latest tagged release receive security
fixes before SimView 1.0. Compatibility failures caused solely by unsupported
private Simulator APIs should use the compatibility issue form instead.

## Trust boundary

- The native server listens only on a mode-0600 Unix socket inside a mode-0700
  temporary directory and requires a random 256-bit token as its first request.
- Shared backend records live below a per-user mode-0700 temporary registry;
  records and sockets are mode 0600, ownership and paths are validated before
  attachment, and a record is removed only after its recorded process is
  confirmed dead. The record token is never included in daemon status output.
- Unauthenticated native and WebSocket connections are closed after a short
  handshake deadline.
- The browser relay binds only to `127.0.0.1` on a random port. HTTP uses an
  `Authorization: Bearer` header and WebSockets authenticate in their first
  message; capability tokens are not placed in query strings or MCP output.
- MCP App CSP metadata allowlists only required local resources.
- Point comments remain session-local and Simulator UI contents are not
  persisted. Review IDs isolate resources and annotations even when multiple
  sessions share one native backend. Video frames are not inserted into model
  context.

Private SimulatorKit APIs are a compatibility and availability risk, not an
authorization boundary. SimView diagnoses missing interfaces and never
broadens the local endpoint to compensate.
