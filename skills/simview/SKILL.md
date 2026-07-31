---
name: simview
description: Open, control, annotate, and send visual feedback from a local iOS Simulator through SimView, or implement a saved SimView annotation handoff in the current project.
---

# SimView

Use SimView when a task needs visual inspection or physical input in an iOS
Simulator.

1. Call `list_simulators` and select a booted simulator. Prefer an explicitly
   supplied UDID; otherwise SimView selects the first booted device and the user
   can switch devices in the preview. Always call `connect_simulator` first and
   continue only after it succeeds. If the user asked to view the interactive
   preview, then call `open_simview` with the same UDID; its already-connected
   initial state requests fullscreen immediately. Otherwise, use the connected
   session without opening the preview.
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

## Implementing annotations sent to chat

A **Send to Chat** message that begins with `/SimView` and asks to implement
saved annotations is an implementation handoff, not a request to start another
SimView review.

- Treat each annotation comment as a user-authored change request for the
  current project. Start by inspecting and editing that project's source.
- Use the full-screen image, element crops, coordinates, and accessibility
  context as supporting evidence. The annotation comment expresses the user's
  intent and takes priority over inferred visual changes.
- Use judgment when the requested change is clear. Ask a concise question only
  when the annotation is genuinely ambiguous or requires a product decision.
- Do not call `open_simview`, `connect_simulator`, or recreate the annotations
  merely to reproduce the supplied feedback. Use Simulator tooling later only
  when the user explicitly requests it or it is necessary to verify the
  implemented changes.
- Implement all clear annotations together and run verification proportionate
  to the changed project.

Multiple live tasks may view the same Simulator stream. SimView shares the
native capture backend per Simulator UDID, while each task keeps an isolated
review resource, relay, and annotation set. Closing one task does not stop the
stream for other authenticated tasks; the backend stops capture after the last
client leaves and exits after its idle window.
