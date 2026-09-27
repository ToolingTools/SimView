---
name: simview-lan
description: Share the current SimView review with another device on a trusted local network, check LAN sharing status, or stop sharing.
---

# SimView LAN sharing

Use this skill when the user requests LAN access to a SimView preview. Ordinary
local preview requests do not enable sharing.

- Reuse the current connected review. Check `get_simview_state` when its state is
  unknown. If disconnected, call `list_devices` without a platform filter. Use an
  explicitly selected device; connect automatically when only one is available,
  otherwise ask the user to select a device. Call `connect_device` before sharing.
- Call `start_lan_sharing` with no arguments for automatic address selection and
  an available port. Use `host` and `port` only when the user specifies them or
  address selection requires a choice. For ambiguous interfaces, present the
  returned candidates and ask which network to use. Do not guess a VPN address.
- Present the returned URL as a clickable link along with its notice: anyone
  with the link can control the device, and HTTP traffic is unencrypted. The
  viewer must be on a network that can reach the host. This link is intentionally
  returned by the sharing tool; do not save it in project files or other logs.
- `get_lan_sharing_status` checks sharing without revealing the link. Repeating
  `start_lan_sharing` with the same options returns the current link; stop first
  to change options. If a link must be retrieved and the original arguments are
  unknown, report the active status rather than interrupting sharing to recreate it.
- Call `stop_lan_sharing` when asked to stop or revoke access. This preserves the
  connected review and local preview. Sharing otherwise lasts until the MCP
  session closes. Device selection changes are reflected in the shared review.

LAN viewing uses MJPEG with the existing interactive controls and annotations.
Keep the host awake and the MCP session running. If a link cannot be reached,
check the selected address, same-network connectivity, macOS firewall permission,
and Wi-Fi client isolation. Do not alter firewall or router settings automatically.
After a network change, stop and start sharing to obtain a fresh link.

For an explicitly requested standalone terminal preview, use
`simview preview --lan`, optionally with `--lan-host <local-ipv4>`,
`--lan-port <port>`, and `--no-open`. This creates a separate review; prefer the
MCP tools when sharing the agent's current annotations. Ctrl-C stops that process.
