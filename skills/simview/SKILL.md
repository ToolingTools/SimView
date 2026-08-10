---
name: simview
description: Open, control, annotate, and send visual feedback from a local iOS Simulator or Android ADB device through SimView, or implement a saved SimView annotation handoff in the current project.
---

# SimView

Use SimView when a task needs visual inspection or input in an iOS Simulator,
Android Emulator, or authorized Android device connected through ADB.

1. Call `list_devices` once without `platform` and select an available device.
   Only filter by platform when the user explicitly requested iOS or Android;
   filtering prematurely can hide the only available device. Its default bounded
   response omits shutdown and unavailable inventory; request additional pages
   with `availableOnly: false` only when diagnosing device discovery. Prefer an
   explicitly supplied device ID. If multiple available devices are returned
   and no device ID was supplied, present them as a numbered list (including
   each device's name, platform, and ID) and prompt the user to select one;
   do not silently choose the first device. When exactly one available device
   remains, connect to it automatically. Once the user selects a device,
   use its ID for the connection. Always call `connect_device`
   first and continue only after it succeeds. If the user asked to view the
   interactive preview, then call `open_simview` with the same device ID; its
   already-connected initial state requests fullscreen immediately. Otherwise,
   use the connected session without opening the preview. Normal navigation is
   semantic-only: use `observationMode: "semantic"` and do not call
   `open_simview` merely because the user says to use SimView.
   On iOS, connection automatically starts a temporary XCTest runner and uses
   it as the primary accessibility provider. This activates the foreground app
   without relaunching it. If startup is unavailable, SimView reports the AX
   fallback in `iosAccessibility`; do not ask the user for approval.
2. Call `observe_screen` with `mode: "semantic"` to read compact prepared
   semantics without waiting for or returning an image.
   Pass the prior `observationId` as `sinceObservationId` to receive only a
   semantic delta. If compact semantics do not establish whether a target or
   state exists, follow this recovery ladder in order: call
   `get_accessibility_tree`, then use targeted `search_elements` queries built
   from likely visible copy, then make at most one `observe_screen` call with
   `mode: "visual"` if the state remains indeterminate. That single visual
   fallback is read-only and does not require a separate user request. Vision
   may establish existence, visible text, or selection state, but it must not
   justify coordinate input while a semantic target is available or authorize
   a consequential action such as submitting a payment. Do not repeat visual
   observations as a substitute for unresolved semantics. A tool-provided
   `coordinateFallback` is native semantic geometry, not vision evidence; use
   it only under the bounded recovery rule in step 4. When a
   matching development-mode React Native target is available through Metro,
   SimView uses its visual Fiber tree and screen/route context; otherwise it
   uses the platform accessibility tree. Prefer identifier, role, and
   accessible name selectors over coordinates.
3. Use `search_elements` with a short natural-language query to discover a
   target in the current semantic tree. Queries must contain at least one
   Unicode letter or number; do not send punctuation-only placeholders. It
   returns bounded ranked matches; pass the selected match's `ref` to
   `tap_element`. Use `find_elements` when exact
   identifier, role, name, value, or ref fields are already known. Never guess
   coordinates while semantic targets are available. If the target appears in
   `excludedCandidates`, swipe in its `suggestedScrollDirection`, then search
   again and use the new ref; never reuse the excluded generation's ref.
   Semantic search covers the currently rendered tree only. In a scroll view,
   table, list, or virtualized collection, a zero match or the presence of
   other rows does not prove that the requested item is absent. When the task
   expects a data row and no match is rendered, explore the surface with one
   viewport-sized swipe at a time, normally swiping up to reveal later rows.
   After every swipe, make a semantic observation and repeat the targeted
   search; never batch speculative swipes because each step may reveal the
   target and regenerates refs. Track the first and last visible row labels (or
   other stable edge markers) plus the observation revision. Stop when the
   target appears, a swipe leaves both semantics and edge markers unchanged
   (the boundary), the surface loops, or eight exploratory swipes have been
   made. If the starting position or continuation direction is unclear, explore
   to one boundary and then reverse within the same eight-swipe total. Prefer
   an exposed filter or search control over traversing a long collection. If
   the bound is exhausted, report discovery as inconclusive rather than saying
   that no matching item exists.
4. Prefer `perform_actions` with `observe: "semantic"` for ordered navigation.
   It sends up to 20 actions, waits for post-action stability, and returns one
   coherent post-action observation. A successful `tap_element` or tap batch
   returns its interaction summary followed by the stable compact semantic tree
   exactly once. Consume that embedded tree instead of immediately calling
   `observe_screen`; make a fresh observation only when the embedded result is
   unavailable or unstable. Use `tap_element` for a single semantic target; it
   re-resolves the target before input. Input acknowledgement alone is not proof
   that navigation or selection completed. `verifyDestination` is optional; do
   not attach it to every tap merely because the overall flow involves a
   payment, invoice, order, or account. For generic section/menu navigation,
   such as opening Invoices, omit it and rely on the stable semantic post-action
   observation. Use it only when a distinctive identity is known to be exposed
   on the destination, normally when opening a specific entity or before a
   consequential follow-up action. Never copy the tapped control's label into
   `verifyDestination.identity`, and never use a generic section/action label
   such as `Invoices`, `Orders`, `Card`, or `Pay`. Optional
   `verifyDestination.assertions` may establish amount, status, or other
   supporting facts.
   Build selectors from fields actually exposed by destination AX. `name`
   matches a native label/title and falls back to a non-redacted text value, so
   it also works for Android `TextView` content; use `value` when observation
   explicitly exposes that field.
   Destination selectors are exact by default. When only a stable fragment is
   known, such as an invoice number within `Invoice #30363063`, use a name
   selector with `exact: false` (for example `{name: "#30363063", exact:
   false}`); use exact matching only when the complete AX label is known.
   `verifyDestination.timeoutMs` accepts 100–5000 milliseconds and must never
   exceed 5000. Use an entity number or similarly stable identifier as identity.
   Identity must
   match exactly one native node or it fails closed as `destination_ambiguous`.
   Assertions only need to be present and may match multiple nodes, such as the
   same amount shown in total and outstanding fields. Strengthen an ambiguous
   identity and do not repeat the accepted tap.
   For a checkbox, radio control, switch, selectable tab, or payment option, add
   `checked` or `selected` to the identity/assertion when native accessibility
   exposes that state. `enabled` may prove that an independently identifiable
   downstream control became available.
   Before choosing a saved payment card, enumerate the enabled, unexpired masked
   cards exposed in semantics. Automatically choose one only when the user's
   prompt uniquely identifies that card or exactly one eligible card exists. If
   multiple eligible cards remain, show only their masked identifiers and ask
   the user to choose. Never request or expose a full card number or CVV. Prior
   approval of the payment task or card choice does not waive post-tap proof.
   Explicit `checked` or `selected` state proves the approved card was selected.
   When neither is exposed, accept proxy proof only when all of these hold: the
   approved card was uniquely targeted; input was dispatched; the snapshot
   changed and stabilized; that card remains present; and an independently
   identifiable next control appeared or changed to `enabled: true`. A decorative
   check icon alone is not proof. Pause when proof is incomplete; never repeat
   the accepted tap.
   Verify entity identity on the last screen where that identifier is exposed,
   before any consequential follow-up action. Treat MCP `isError` or
   `safeToContinue: false` as an unconditional stop even when the nested
   `interaction` receipt says the tap was accepted.
   `HARD STOP — INPUT WAS DISPATCHED` and `retryInput: false` mean no further
   device input may be sent until the user supplies new direction or an
   independent UI change occurs.
   When `inputDispatched` is false, `safeToContinue: false` still stops the
   current batch but is not a dispatched-input hard stop. Follow
   `recoveryAllowed` and `recoveryAction`: `search_again` requests a new semantic
   resolution, `scroll_then_search` permits one bounded scroll before resolving
   again, and `observe_then_search` permits a fresh observation before resolving
   again. `tap_known_coordinate` permits exactly one raw `tap` at the returned
   `coordinateFallback.point` when its source is
   `fresh-semantic-target-center`, `maxAttempts` is `1`, and the original user
   request already authorizes that action. This includes an authorized final
   submission. When those conditions hold, perform the fallback automatically
   without asking for separate confirmation; if the prompt does not authorize
   the consequential action, ask before tapping. Never use the hit node's
   coordinates or a point inferred from an image. Observe semantically
   immediately after the fallback tap and verify the intended state change;
   never repeat the fallback if verification is missing, unstable, or negative.
   Use the returned `hitNode`,
   `actionableHitNode`, `hitRelationship`,
   `selectorDiagnostics`, and `actionabilityDiagnostics`; the latter contains at
   most two actionable ancestors or descendants and reports ambiguity. Every
   selector field must match one native node; do not combine a container
   identifier with a child's accessible name. If diagnostics show split nodes,
   use `search_elements` and pass its generation-scoped ref. Never redirect input
   to a diagnostic relative automatically. Disabled or ambiguous targets, and
   hit mismatches without an explicit `tap_known_coordinate` recovery, require
   a new semantic resolution, an independent UI change, or user direction.
5. If an accepted semantic tap's embedded observation reports unstable or
   unavailable post-action state, make one fresh semantic observation. Never
   repeat the accepted tap, and never fall back to coordinates merely because
   its embedded observation was stale.
6. Use `tap`, `swipe`, `long_press`, `type_text`, and `press_button` for isolated
   actions when no useful accessible target exists, or for the single
   `tap_known_coordinate` recovery described above. Use `perform_gesture` for a
   timestamped pointer track. Two-track gestures require the device's
   `multiTouch` capability. Coordinates are normalized from 0 to 1.
   `type_text` inserts at the current selection and rejects control characters.
   Use `replace_text` with an identifier, name, value, or placeholder selector
   when a field must be cleared and replaced exactly. Use `press_key` for Return,
   Delete, Tab, Escape, arrows, and other named special keys; never paste
   backspace characters.
7. Use `inspect_point` to attach semantic context to a coordinate. Enable the
   UIKit probe only for an iOS Simulator when class, controller, window, or
   scene context is needed and relaunching an explicitly selected third-party
   app is acceptable. Android uses UIAutomator context and does not support the
   UIKit probe. Its raw `hitNode` is the deepest accessible node at the point,
   while `actionableHitNode` is the enabled actionable node selected from the
   same snapshot. Physical input is always dispatched through the native
   platform backend, never through the semantic tree.
8. Treat React Native route, component, testID, and source context as optional;
   never block on Metro or require Metro MCP itself to be installed.
   Native iOS output reports `context=native-ios` and the active element source
   (`core-simulator-xctest` or `core-simulator-ax`); do not interpret the absence
   of a Metro target as an error.
   `observe_screen.elementSource` is the authoritative provenance field;
   `metroStatus: "active"` confirms Fiber enrichment, while a
   `metro-target-unavailable`, `metro-fiber-unavailable`, or
   `metro-inspection-failed` status explains native fallback. Optional fallback
   detail distinguishes `metro-unreachable`, `metro-running-no-debug-targets`,
   `metro-target-mismatch`, `metro-fiber-root-missing`, and
   `metro-connect-or-evaluate-failed`. These diagnostics never make Metro
   authoritative: continue using the complete native tree whenever enrichment
   is unavailable.
9. Add point annotations at exact mismatch coordinates, or rectangular
   annotations when a bounded screen region is the relevant evidence. Keep
   comments brief and specific.
10. Annotations remain session-local. Use **Send to Chat** to save the current
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
