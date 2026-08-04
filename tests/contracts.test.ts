import { describe, expect, test } from "bun:test";
import {
  accessibilitySelectorSchema,
  annotationGeometrySchema,
  deviceDescriptionSchema,
  ELEMENT_TREE_PAGE_RAW_BYTES,
  elementTreeOutputSchema,
  elementTreePageSchema,
  inspectPointOutputSchema,
  methodSchemas,
  parseDeviceDescription,
  parseMethodParams,
  parseMethodResult,
  protocolResponseSchema,
  sessionStateSchema,
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
    expect(result.protocolVersion).toBe(2);
  });

  test("rejects empty accessibility selectors", () => {
    expect(accessibilitySelectorSchema.safeParse({}).success).toBe(false);
    expect(accessibilitySelectorSchema.parse({ identifier: "submit" }).exact).toBe(true);
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

  test("rejects out-of-range input at the protocol boundary", () => {
    expect(methodSchemas["input.tap"].params.safeParse({ x: 1.1, y: 0.5 }).success).toBe(false);
  });

  test("normalizes legacy iOS descriptions and validates Android device capabilities", () => {
    expect(
      parseDeviceDescription({
        udid: "SIM-123",
        name: "iPhone",
        state: "Booted",
        runtime: "iOS 26.0",
      }),
    ).toMatchObject({
      id: "ios:SIM-123",
      platform: "ios",
      kind: "simulator",
      state: "ready",
      available: true,
      udid: "SIM-123",
    });

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
});
