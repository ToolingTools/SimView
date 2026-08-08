---
name: simview
description: Open, control, annotate, and send visual feedback from a local iOS Simulator or Android ADB device through SimView, or implement a saved SimView annotation handoff in the current project.
---

# SimView

Use SimView when a task needs visual inspection or input in an iOS Simulator,
Android Emulator, or authorized Android device connected through ADB.

1. Call `list_devices` and select an available device. Its default bounded
   response omits shutdown and unavailable inventory; request additional pages
   with `availableOnly: false` only when diagnosing device discovery. Prefer an
   explicitly supplied device ID; otherwise SimView selects the first available
   device and the user can switch devices in the preview. Always call `connect_device`
   first and continue only after it succeeds. If the user asked to view the
   interactive preview, then call `open_simview` with the same device ID; its
   already-connected initial state requests fullscreen immediately. Otherwise,
   use the connected session without opening the preview. Normal navigation is
   semantic-only: use `observationMode: "semantic"` and do not call
   `open_simview` merely because the user says to use SimView.
2. Call `observe_screen` with `mode: "semantic"` to read compact prepared
   semantics without waiting for or returning an image.
   Pass the prior `observationId` as `sinceObservationId` to receive only a
   semantic delta. Use `mode: "visual"` only when the user explicitly requests
   visual inspection; semantic failure alone is not permission to request an
   image. When a
   matching development-mode React Native target is available through Metro,
   SimView uses its visual Fiber tree and screen/route context; otherwise it
   uses the platform accessibility tree. Prefer identifier, role, and
   accessible name selectors over coordinates.
3. Use `search_elements` with a short natural-language query to discover a
   target in the current semantic tree. It returns bounded ranked matches; pass
   the selected match's `ref` to `tap_element`. Use `find_elements` when exact
   identifier, role, name, value, or ref fields are already known. Never guess
   coordinates while semantic targets are available.
4. Prefer `perform_actions` with `observe: "semantic"` for ordered navigation.
   It sends up to 20 actions, waits for post-action stability, and returns one
   coherent post-action observation. Use `tap_element` for a single semantic
   target; it re-resolves the target before input. Input acknowledgement alone
   is not proof that navigation completed.
5. Use `tap`, `swipe`, `long_press`, `type_text`, and `press_button` for isolated
   actions when no useful accessible target exists. Use `perform_gesture` for a
   timestamped pointer track. Two-track gestures require the device's
   `multiTouch` capability. Coordinates are normalized from 0 to 1.
6. Use `inspect_point` to attach semantic context to a coordinate. Enable the
   UIKit probe only for an iOS Simulator when class, controller, window, or
   scene context is needed and relaunching an explicitly selected third-party
   app is acceptable. Android uses UIAutomator context and does not support the
   UIKit probe.
7. Treat React Native route, component, testID, and source context as optional;
   never block on Metro or require Metro MCP itself to be installed.
8. Add point annotations at exact mismatch coordinates, or rectangular
   annotations when a bounded screen region is the relevant evidence. Keep
   comments brief and specific.
9. Annotations remain session-local. Use **Send to Chat** to save the current
   PNG and crops in a private temporary directory and send their paths with the
   compact coordinate comments.

## Implementing annotations sent to chat

A **Send to Chat** message that asks to implement saved annotations and includes
the frozen frame and annotation crops is an implementation handoff, not a
request to start another SimView review.

- Treat each annotation comment as a user-authored change request for the
  current project. Start by inspecting and editing that project's source.
- Use the full-screen image, screen-level route or native view-controller path,
  element crops, coordinates, and accessibility context as supporting evidence.
  The annotation comment expresses the user's intent and takes priority over
  inferred visual changes.
- Use judgment when the requested change is clear. Ask a concise question only
  when the annotation is genuinely ambiguous or requires a product decision.
- Do not call `open_simview`, `connect_device`, or recreate the annotations
  merely to reproduce the supplied feedback. Use device tooling later only
  when the user explicitly requests it or it is necessary to verify the
  implemented changes.
- Implement all clear annotations together and run verification proportionate
  to the changed project.

Multiple live tasks may view the same device stream. SimView shares the native
capture backend per platform and native device identifier, while each task
keeps an isolated review resource, relay, and annotation set. Closing one task does not stop the
stream for other authenticated tasks; the backend stops capture after the last
client leaves and exits after its idle window.
