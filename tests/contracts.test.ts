import { describe, expect, test } from "bun:test";
import {
  type AccessibilitySnapshot,
  accessibilityObserveParamsSchema,
  accessibilityObserveResultSchema,
  accessibilityResourceSchema,
  accessibilitySelectorSchema,
  accessibilitySnapshotSchema,
  annotationGeometrySchema,
  deviceDescriptionSchema,
  ELEMENT_TREE_PAGE_RAW_BYTES,
  elementSearchMatchSchema,
  elementSearchQuerySchema,
  elementTreeOutputSchema,
  elementTreePageSchema,
  inputReceiptSchema,
  inspectPointOutputSchema,
  iosAccessibilityStatusSchema,
  methodSchemas,
  parseDeviceDescription,
  parseMethodParams,
  parseMethodResult,
  protocolResponseSchema,
  sessionStateSchema,
  stableAccessibilityEntries,
} from "@simview/contracts";

describe("shared protocol contracts", () => {
  test("round-trips the canonical hello fixture", async () => {
    const fixture = (await Bun.file("tests/fixtures/protocol/hello.json").json()) as {
      request: { params: unknown };
      response: unknown;
    };
    const params = parseMethodParams("hello", fixture.request.params);
    const response = protocolResponseSchema.parse(fixture.response);
    const result = parseMethodResult("hello", response.result);

    expect(params.codecs).toEqual(["h264", "mjpeg"]);
    expect(result.codec).toBe("h264");
    expect(result.protocolVersion).toBe(4);
  });

  test("rejects empty accessibility selectors", () => {
    expect(accessibilitySelectorSchema.safeParse({}).success).toBe(false);
    expect(accessibilitySelectorSchema.parse({ identifier: "submit" }).exact).toBe(true);
    expect(accessibilitySelectorSchema.parse({ placeholder: "Merchant" })).toMatchObject({
      placeholder: "Merchant",
      exact: true,
    });
    expect(
      accessibilitySelectorSchema.safeParse({ identifier: "submit", unsupported: true }).success,
    ).toBe(false);
  });

  test("requires explicit non-replayable input receipts", () => {
    expect(
      inputReceiptSchema.parse({
        accepted: true,
        inputDispatched: true,
        safeToContinue: true,
        retryable: false,
        retryInput: false,
        recoveryAllowed: false,
        code: "input_accepted",
      }),
    ).toMatchObject({ accepted: true, inputDispatched: true, retryInput: false });
    expect(
      inputReceiptSchema.parse({
        accepted: false,
        inputDispatched: true,
        safeToContinue: false,
        retryable: false,
        retryInput: false,
        recoveryAllowed: true,
        recoveryAction: "reconnect_then_observe",
        code: "input_dispatch_uncertain",
      }),
    ).toMatchObject({ accepted: false, recoveryAction: "reconnect_then_observe" });
    expect(inputReceiptSchema.safeParse({ accepted: true }).success).toBe(false);
    expect(
      inputReceiptSchema.safeParse({
        accepted: false,
        inputDispatched: true,
        safeToContinue: false,
        retryable: true,
        retryInput: true,
        recoveryAllowed: true,
        code: "unsafe_retry",
      }).success,
    ).toBe(false);
  });

  test("uses named bounded key input instead of raw HID usages", () => {
    expect(
      methodSchemas["input.key"].params.parse({
        key: "delete",
        modifiers: ["command"],
        repeat: 100,
      }),
    ).toEqual({ key: "delete", modifiers: ["command"], repeat: 100 });
    expect(
      methodSchemas["input.key"].params.safeParse({ key: "delete", repeat: 101 }).success,
    ).toBe(false);
    expect(methodSchemas["input.key"].params.parse({ key: "select-all" })).toEqual({
      key: "select-all",
    });
    expect(methodSchemas["input.key"].params.safeParse({ usage: 42, phase: "down" }).success).toBe(
      false,
    );
  });

  test("bounds semantic element searches", () => {
    expect(elementSearchQuerySchema.parse({ query: "Shop" })).toMatchObject({
      query: "Shop",
      actionableOnly: true,
      visibleOnly: true,
      limit: 10,
    });
    expect(elementSearchQuerySchema.safeParse({ query: "", limit: 50 }).success).toBe(false);
    const punctuationOnly = elementSearchQuerySchema.safeParse({ query: "***" });
    expect(punctuationOnly.success).toBe(false);
    if (!punctuationOnly.success) {
      expect(punctuationOnly.error.issues[0]?.message).toContain(
        "Query must contain at least one letter or number",
      );
    }
    expect(elementSearchQuerySchema.safeParse({ query: "#30363063" }).success).toBe(true);
  });

  test("uses visible and hidden as the only wait states", () => {
    const base = {
      selector: { identifier: "submit" },
      timeoutMs: 1_000,
    };
    expect(
      methodSchemas["accessibility.wait"].params.safeParse({
        ...base,
        state: "visible",
      }).success,
    ).toBe(true);
    expect(
      methodSchemas["accessibility.wait"].params.safeParse({
        ...base,
        state: "absent",
      }).success,
    ).toBe(false);
  });

  test("validates accessibility observation and resource envelopes", () => {
    const snapshot = observationSnapshot("ax-1", "first-ref", "Continue");
    expect(accessibilityObserveParamsSchema.parse({})).toMatchObject({
      scope: "interactive",
      maxNodes: 1_200,
      settleQuietMs: 75,
      maxWaitMs: 500,
      requireChange: true,
    });
    const observation = accessibilityObserveResultSchema.parse({
      snapshot,
      revision: "7",
      eventChanged: true,
      stable: true,
      timedOut: false,
      strategy: "snapshot-diff",
      fallbackUsed: true,
      captureCount: 2,
      changeSource: "snapshot-diff",
      settledAt: snapshot.capturedAt,
    });
    const resource = accessibilityResourceSchema.parse({
      schemaVersion: 1,
      revision: observation.revision,
      semanticHash: "a".repeat(64),
      capturedAt: snapshot.capturedAt,
      strategy: observation.strategy,
      snapshot,
    });
    expect(resource.snapshot.snapshotId).toBe("ax-1");
    expect(observation).toMatchObject({
      fallbackUsed: true,
      captureCount: 2,
      changeSource: "snapshot-diff",
    });
  });

  test("keeps semantic identities stable when snapshot refs are regenerated", () => {
    const first = observationSnapshot("ax-1", "first-ref", "Continue");
    const regenerated = observationSnapshot("ax-2", "second-ref", "Continue");
    const changed = observationSnapshot("ax-3", "third-ref", "Continue");
    const changedButton = changed.root.children?.[0];
    if (!changedButton) throw new Error("Test snapshot is missing its button");
    changedButton.enabled = false;

    const firstEntries = stableAccessibilityEntries(first.root);
    const regeneratedEntries = stableAccessibilityEntries(regenerated.root);
    const changedEntries = stableAccessibilityEntries(changed.root);
    expect(regeneratedEntries.map(({ key }) => key)).toEqual(firstEntries.map(({ key }) => key));
    expect(regeneratedEntries.map(({ value }) => value)).toEqual(
      firstEntries.map(({ value }) => value),
    );
    expect(changedEntries.map(({ key }) => key)).toEqual(firstEntries.map(({ key }) => key));
    expect(changedEntries.map(({ value }) => value)).not.toEqual(
      firstEntries.map(({ value }) => value),
    );
  });

  test("includes checked and selected state in semantic entries", () => {
    const initial = observationSnapshot("ax-1", "first-ref", "Continue");
    const changed = observationSnapshot("ax-2", "second-ref", "Continue");
    const initialButton = initial.root.children?.[0];
    const changedButton = changed.root.children?.[0];
    if (!initialButton || !changedButton) throw new Error("Test snapshot is missing its button");
    initialButton.checked = false;
    initialButton.selected = false;
    changedButton.checked = true;
    changedButton.selected = true;

    expect(stableAccessibilityEntries(changed.root).map(({ value }) => value)).not.toEqual(
      stableAccessibilityEntries(initial.root).map(({ value }) => value),
    );
  });

  test("rejects out-of-range input at the protocol boundary", () => {
    expect(methodSchemas["input.tap"].params.safeParse({ x: 1.1, y: 0.5 }).success).toBe(false);
  });

  test("bounds timestamped gestures by pointers, duration, and total samples", () => {
    const track = {
      pointerId: 0,
      waypoints: [
        { x: 0.2, y: 0.3, timestampMs: 0 },
        { x: 0.8, y: 0.7, timestampMs: 350 },
      ],
    };
    expect(methodSchemas["input.gesture"].params.safeParse({ tracks: [track] }).success).toBe(true);
    expect(
      methodSchemas["input.gesture"].params.safeParse({
        tracks: [{ ...track, waypoints: [...track.waypoints].reverse() }],
      }).success,
    ).toBe(false);
    expect(
      methodSchemas["input.gesture"].params.safeParse({
        tracks: [track, { ...track, pointerId: 0 }],
      }).success,
    ).toBe(false);
  });

  test("normalizes legacy iOS descriptions and validates Android device capabilities", () => {
    const legacyIOSDevice = parseDeviceDescription({
      udid: "SIM-123",
      name: "iPhone",
      state: "Booted",
      runtime: "iOS 26.0",
    });
    expect(legacyIOSDevice).toMatchObject({
      id: "ios:SIM-123",
      platform: "ios",
      kind: "simulator",
      state: "ready",
      available: true,
      udid: "SIM-123",
    });
    expect(legacyIOSDevice.capabilities.input.keys).toEqual(
      expect.arrayContaining(["return", "delete"]),
    );

    expect(
      deviceDescriptionSchema.parse({
        id: "android:emulator-5554",
        platform: "android",
        kind: "emulator",
        state: "ready",
        available: true,
        serial: "emulator-5554",
        name: "Pixel 9",
        runtime: "Android 15 (API 35)",
        capabilities: {
          capture: { h264: true, mjpeg: true, screenshot: true },
          input: {
            touch: true,
            text: "unicode",
            keys: [],
            buttons: ["home", "back", "overview", "lock"],
          },
          orientation: true,
          accessibility: true,
          androidContext: true,
          uikitProbe: false,
        },
      }),
    ).toMatchObject({ id: "android:emulator-5554", serial: "emulator-5554" });
  });

  test("reports the primary iOS accessibility provider without approval state", () => {
    expect(
      iosAccessibilityStatusSchema.parse({
        schemaVersion: 1,
        status: "enhanced-ready",
        activeProvider: "core-simulator-xctest",
        bundleId: "studio.churro.spenny",
      }),
    ).toMatchObject({
      status: "enhanced-ready",
      activeProvider: "core-simulator-xctest",
    });
    expect(
      iosAccessibilityStatusSchema.safeParse({
        schemaVersion: 1,
        status: "approval-required",
        activeProvider: "core-simulator-ax",
      }).success,
    ).toBe(false);
  });

  test("accepts XCTest as native snapshot and search provenance", () => {
    const snapshot = {
      schemaVersion: 1,
      snapshotId: "xctest-snapshot",
      capturedAt: "2026-08-09T01:11:24Z",
      source: "core-simulator-xctest",
      scope: "visible",
      screen: { x: 0, y: 0, width: 402, height: 874 },
      root: { ref: "ax:xctest-snapshot:0", role: "AXApplication", label: "Spenny" },
      stats: {
        nodeCount: 1,
        truncated: false,
        quality: "complete",
        provider: "core-simulator-xctest",
      },
    };

    expect(accessibilitySnapshotSchema.parse(snapshot).source).toBe("core-simulator-xctest");
    expect(parseMethodResult("accessibility.snapshot", snapshot).source).toBe(
      "core-simulator-xctest",
    );
    expect(
      elementSearchMatchSchema.parse({
        element: { ref: "ax:xctest-snapshot:1", role: "AXButton", label: "Continue" },
        score: 1,
        matchedFields: ["name"],
        exact: true,
        source: "core-simulator-xctest",
        snapshotId: "xctest-snapshot",
      }).source,
    ).toBe("core-simulator-xctest");
  });

  test("accepts bounded rectangular annotations", () => {
    expect(
      annotationGeometrySchema.safeParse({
        kind: "rect",
        x: 0.2,
        y: 0.3,
        width: 0.5,
        height: 0.4,
      }).success,
    ).toBe(true);
    expect(
      annotationGeometrySchema.safeParse({
        kind: "rect",
        x: 0.8,
        y: 0.3,
        width: 0.4,
        height: 0.4,
      }).success,
    ).toBe(false);
  });

  test("keeps relay secrets out of model-visible session state", () => {
    const state = sessionStateSchema.parse({
      reviewId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      annotations: [],
      codec: "h264",
      connected: true,
      relayToken: "must-not-survive",
      browserUrl: "http://127.0.0.1/#token=must-not-survive",
    });
    expect(state).toEqual({
      reviewId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      annotations: [],
      codec: "h264",
      connected: true,
    });
  });

  test("bounds element tree chunks by UTF-8 bytes", () => {
    const chunk = Buffer.alloc(ELEMENT_TREE_PAGE_RAW_BYTES).toString("base64");
    expect(
      elementTreePageSchema.safeParse({
        schemaVersion: 1,
        transferId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
        encoding: "base64-json",
        pageIndex: 0,
        pageCount: 1,
        chunk,
        chunkBytes: ELEMENT_TREE_PAGE_RAW_BYTES,
        totalBytes: ELEMENT_TREE_PAGE_RAW_BYTES,
        sha256: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      elementTreePageSchema.safeParse({
        schemaVersion: 1,
        transferId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
        encoding: "base64-json",
        pageIndex: 0,
        pageCount: 1,
        chunk: `${chunk}AAAA`,
        chunkBytes: ELEMENT_TREE_PAGE_RAW_BYTES + 3,
        totalBytes: ELEMENT_TREE_PAGE_RAW_BYTES + 3,
        sha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  test("wraps point inspection as an element instead of mislabeling it as a snapshot", () => {
    const output = inspectPointOutputSchema.parse({
      element: { ref: "node:1", role: "button" },
      probe: { bundled: true, connected: false },
    });
    expect(output.element.ref).toBe("node:1");
    expect(() =>
      inspectPointOutputSchema.parse({
        root: { ref: "node:1" },
        probe: { bundled: true, connected: false },
      }),
    ).toThrow();
  });

  test("accepts a React Native Fiber element tree and screen context", () => {
    expect(
      elementTreeOutputSchema.safeParse({
        snapshot: {
          schemaVersion: 1,
          snapshotId: "fiber-1",
          capturedAt: "2026-07-31T12:00:00.000Z",
          source: "react-native-fiber",
          scope: "full",
          screen: { x: 0, y: 0, width: 430, height: 932 },
          root: {
            ref: "rn:root",
            kind: "component",
            label: "Screen",
            children: [
              {
                ref: "rn:1",
                kind: "host",
                component: "InboxButton",
                hostComponent: "View",
                testID: "inbox-button",
                sourceLocation: { file: "src/InboxButton.tsx", line: 12 },
              },
            ],
          },
          stats: { nodeCount: 2, truncated: false },
          metro: {
            host: "127.0.0.1",
            port: 8081,
            targetId: "target-1",
            targetTitle: "Hermes React Native",
            renderer: "fabric",
          },
        },
        screenContext: {
          schemaVersion: 1,
          kind: "react-native",
          capturedAt: "2026-07-31T12:00:00.000Z",
          frameId: "frame-1",
          renderer: "fabric",
          target: "Hermes React Native",
          route: "Inbox",
          navigationPath: ["Root", "Inbox"],
          screenComponent: "InboxScreen",
          sourceLocation: { file: "src/InboxScreen.tsx", line: 8 },
          confidence: "exact",
        },
      }).success,
    ).toBe(true);
  });

  test("accepts bounded Metro fallback detail without changing the coarse reason", () => {
    const output = elementTreeOutputSchema.parse({
      snapshot: observationSnapshot("native-1", "native:continue", "Continue"),
      screenContext: {
        schemaVersion: 1,
        kind: "native-ios",
        capturedAt: "2026-08-08T10:00:00.000Z",
        frameId: "frame-1",
      },
      fallback: {
        reason: "metro-target-unavailable",
        detail: "metro-running-no-debug-targets",
      },
    });

    expect(output.fallback).toEqual({
      reason: "metro-target-unavailable",
      detail: "metro-running-no-debug-targets",
    });
  });
});

function observationSnapshot(
  snapshotId: string,
  ref: string,
  label: string,
): AccessibilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    capturedAt: "2026-08-08T10:00:00.000Z",
    source: "core-simulator-ax",
    scope: "interactive",
    screen: { x: 0, y: 0, width: 402, height: 874 },
    root: {
      ref: "root-ref",
      children: [
        {
          ref,
          identifier: "continue-button",
          role: "button",
          label,
          enabled: true,
        },
      ],
    },
    stats: { nodeCount: 2, truncated: false },
  };
}
