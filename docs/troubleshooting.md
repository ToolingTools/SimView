# Troubleshooting MCP connections and previews

`simview mcp` starts automatically from existing Cursor, Codex, Claude Code, and
MCPB configurations. It is a stdio adapter. Adapters from compatible builds join
one authenticated local MCP daemon; each retains its own review and project.
The daemon is on demand, with no login item or background service to install.

## Understanding process counts

While connected, expect one adapter per host connection, one MCP daemon per
compatible build, and native backends/helpers for devices in use. Identical
packaged builds installed in different directories share the MCP daemon.
Different builds intentionally coexist. Native backends also isolate different
explicit native tool configurations.

Run `simview mcp status --json` to see daemon PID, build identity, version,
connection count, and unique owner count. It does not expose credentials or
Simulator contents. Status queries do not keep a daemon alive. Use the existing
`simview daemon status --json` commands for native backend diagnostics.

An idle, connected agent is still an owner. Closing a preview tab does not end
the agent's review. Closing the agent connection does: its browser relay and
native clients close, and another agent's review continues independently.
The last connection starts MCP shutdown immediately, capped at five seconds.
Unused native backends stop capture on disconnect and start bounded shutdown immediately. Startup has a separate bounded allowance for the first client.

If a host leaves an orphaned worker after its GUI quits, adapters also watch the
original GUI ancestor and its process start time. They close their own connection
without terminating the host's worker. Existing older SimView processes must
be restarted through their host to gain this behavior; rebuilding source does
not replace a running installed MCP server.

A new adapter recovers trusted records from dead processes and waits for a
shutting-down compatible service before starting another. Reconnect through the
host after a daemon crash. Device input is never replayed after transport loss.
Do not copy registry records, tokens, or capability URLs into bug reports.

## Cursor and fullscreen

Cursor 3.18.15 advertises inline MCP Apps only. SimView stays inline there.
Click **Open in browser** in the preview toolbar for a resizable browser view of
the same review. Browser access ends with its owning agent connection.

Hosts advertising fullscreen receive an automatic request when the device and
host bridge are ready, including when capabilities arrive later. If that request
is refused, the toolbar's **Enter fullscreen** button allows a manual retry.
The host ultimately controls which display modes it permits.

**Review disconnected** means the owning session or transport ended. Reconnect
SimView from the agent to start a new review. **Starting live preview** means the
device is connected but its first video frame has not arrived yet.

## Metro and project selection

Each adapter sends its working directory and `SIMVIEW_PROJECT_ROOT` explicitly.
Set that variable in a host's MCP configuration when the host launches SimView
from a plugin/cache directory instead of the React Native project. Another
host's project settings cannot replace this review's settings. Metro inspection
is optional; native inspection remains available without a matching Metro target.
