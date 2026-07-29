# Security

SimView is local-only. Report security issues privately to the repository
maintainers before opening a public issue.

## Trust boundary

- The native server listens only on a Unix domain socket in a mode-0700
  temporary directory.
- The socket is mode 0600.
- The first request must present a random 256-bit session token.
- The browser relay binds only to `127.0.0.1` on a random port and requires the
  same-strength independent relay token.
- MCP App CSP metadata allowlists only the active relay's exact HTTP and
  WebSocket origins.
- Point comments remain session-local and do not write review files.
- Video frames are not inserted into model context.

Private SimulatorKit APIs are a compatibility and availability risk, not an
authorization boundary. SimView diagnoses missing interfaces and never broadens
the local endpoint to compensate.
