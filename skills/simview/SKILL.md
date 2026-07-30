---
name: simview
description: Open, control, annotate, and send visual feedback from a local iOS Simulator through SimView.
---

# SimView

Use SimView when a task needs visual inspection or physical input in an iOS
Simulator.

1. Call `list_simulators` and select a booted simulator. Prefer an explicitly
   supplied UDID; otherwise use the only booted device. Call `open_simview` only
   when the user asks to view the interactive preview. Otherwise call
   `connect_simulator` to control the simulator without opening a preview.
2. Call `observe_screen` to receive one PNG and a compact accessibility tree.
   Prefer identifier, role, and accessible name selectors over coordinates.
3. Use `tap_element` for semantic targets. It re-resolves the target and sends a
   physical HID tap. Use `wait_for_element` or observe again to verify outcome;
   input acknowledgement is not proof that navigation completed.
4. Use `tap`, `swipe`, `long_press`, `type_text`, and `press_button` when no
   useful accessible target exists. Coordinates are normalized from 0 to 1.
5. Use `inspect_point` to attach semantic context to a coordinate. Enable the
   UIKit probe only when class, controller, window, or scene context is needed
   and relaunching an explicitly selected third-party app is acceptable.
6. If Metro MCP is connected, include its route, component, and testID context,
   but label that context as optional and never block on it.
7. Add point annotations at the exact mismatch coordinates. Keep comments brief
   and specific.
8. Annotations remain session-local. Use **Send to Chat** to capture the current
   PNG and send it with the compact coordinate comments.
