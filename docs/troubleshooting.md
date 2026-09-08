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
effective native tool environments. Explicitly passing an unchanged inherited
environment shares the same backend as leaving it unspecified.

Run `simview mcp status --json` to see daemon PID, build identity, version,
connection count, and unique owner count. It does not expose credentials or
Simulator contents. Status queries do not keep a daemon alive. Use the existing
`simview daemon status --json` commands for native backend diagnostics.

An idle, connected agent is still an owner. Closing a preview tab does not end
the agent's review. Closing the agent connection does: its browser relay and
native clients close, and another agent's review continues independently.
The last connection starts MCP shutdown immediately, capped at five seconds.
Unused native backends stop capture on disconnect and start bounded shutdown immediately. Startup has a separate bounded allowance for the first client.
When iOS accessibility uses the temporary XCTest provider, terminal backend shutdown also stops and reaps its provider process and removes the generated `.xctestrun` configuration. Preview and capture toggles keep an enabled provider alive.

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
Browser MJPEG fallback enables preview on its own native connection. Closing
the final MJPEG viewer releases that connection while the agent review remains
available.

## Metro and project selection

Each adapter sends its working directory and `SIMVIEW_PROJECT_ROOT` explicitly.
Set that variable in a host's MCP configuration when the host launches SimView
from a plugin/cache directory instead of the React Native project. Another
host's project settings cannot replace this review's settings. Metro inspection
is optional; native inspection remains available without a matching Metro target.

## MCP transport closes unexpectedly

The process-owner watchdog keeps an established connection alive when `ps`
cannot inspect its owners. It retries on the next tick, closing only when a
successful snapshot confirms owner exit or PID reuse, or a signal-zero probe
reports `ESRCH`. Permission failures are inconclusive. EOF, closed sockets, and
termination signals still clean up immediately; device actions are never replayed.

Adapter stderr reports fixed shutdown reason codes and error categories. The MCP
daemon retains `<build-identity>.json.diagnostics.log` in its private MCP registry
(`sv-mcp/<uid>` under the OS user temporary directory). Each file is mode 0600 and
limited to 64 KiB; it resets when full and survives daemon shutdown. These files
contain timestamps, component names, fixed reason codes, and error categories,
never raw errors, tokens, environment values, or device contents. Inspection
failure and recovery are logged once per transition. Look for
`owner_inspection_failed`, `owner_inspection_recovered`, `owner_exited`,
`owner_identity_changed`, or transport/termination reasons around the failure.
Only share the diagnostic log, never the adjacent registry JSON containing tokens.

### Native target failures and disconnected devices

`native_target_unconfirmed` includes `failureReason`: `missing_action_semantics`,
`invalid_geometry`, or `native_corroboration_failed`. These rejections send no input.
A visible, enabled `AXUnknown` node may be discoverable without exposing native
activation semantics. For `missing_action_semantics`, repeated searches cannot
repair that metadata; do not infer tappability from a label, test ID, React Native
press handler, or screen coordinates. The app or accessibility provider must
supply reliable native action evidence. Other failures retain their specific
search, observation, scroll, or bounded hit-test recovery guidance.

MCP availability does not prove the native device connection is alive.
`get_simview_state.connected` reports native connectivity. The optional
`lastNativeDisconnect` records the most recent loss with a sanitised reason and
timestamp, retained as history after reconnecting. Native disconnect diagnostic
reasons have a `native_` prefix, distinct from MCP adapter/daemon shutdown events.
`connection_closed` means the native socket closed; it does not establish why the
backend closed it. `unknown` means the cause is not yet classified.
Call `connect_device`, then obtain a fresh `observe_screen` before continuing.
Never replay input that may already have been dispatched, and never reuse refs
from before the disconnect. Diagnostic logs contain no Simulator UI content.

For an unknown-role XCTest target, SimView can consult a fresh native point hit.
If native observation exposes such a candidate, obtain its ref with
`find_elements` or `search_elements(actionableOnly: false)` and let `tap_element`
verify it; discovery alone does not establish tappability.
It accepts activation only when that hit exposes `AXPress`, agrees with the
unique target's identifier/name and other identity fields, and matches its frame
within one screen point. Scrolling actions alone do not qualify. Successful
receipts preserve the original XCTest role and report `actionabilityEvidence`
with `source: native-point-hit`; hit diagnostics retain the native action list.
A missing XCTest point does not disable a healthy XCTest provider. Foreground
changes fail closed. The agent must not reproduce this check with guessed input.
