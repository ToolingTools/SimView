import { describe, expect, test } from "bun:test";
import type {
  AccessibilityNode,
  AccessibilitySnapshot,
  Annotation,
  ElementTreeOutput,
  ElementTreePage,
  ReactNativeElementSnapshot,
  ReactNativeScreenContext,
} from "@simview/contracts";
import {
  ANNOTATION_IMPLEMENTATION_PROMPT,
  annotationCropRect,
  annotationMessageContent,
  annotationMessageContext,
  annotationMessageScreenContext,
  assembleElementTreePages,
  claimFullscreenRequest,
  commentableNodeAtPoint,
  contextForNode,
  createUIKitScreenContext,
  elementPath,
  flattenTree,
  formatRuntime,
  inspectorTreeRows,
  PreviewBridgeGate,
  parseSessionState,
  requireAnnotation,
  streamMessage,
  visibleTree,
} from "../packages/app/src/helpers";

const child: AccessibilityNode = {
  ref: "button",
  role: "AXButton",
  label: "Submit",
  frame: {
    points: { x: 20, y: 20, width: 20, height: 10 },
    normalized: { x: 0.2, y: 0.2, width: 0.2, height: 0.1 },
  },
};
const root: AccessibilityNode = {
  ref: "root",
  role: "AXGroup",
  frame: {
    points: { x: 0, y: 0, width: 100, height: 100 },
    normalized: { x: 0, y: 0, width: 1, height: 1 },
  },
  children: [child],
};

describe("app helpers", () => {
  test("pauses fallback preview polling while priority bridge work is pending", () => {
    const gate = new PreviewBridgeGate();
    const releaseFirst = gate.beginPriority();
    const releaseSecond = gate.beginPriority();
    expect(gate.priorityPending).toBe(true);
    releaseFirst();
    expect(gate.priorityPending).toBe(true);
    releaseFirst();
    releaseSecond();
    expect(gate.priorityPending).toBe(false);
  });

  test("reassembles byte-paged Fiber trees without changing their structure", async () => {
    const output: ElementTreeOutput = {
      snapshot: {
        schemaVersion: 1,
        snapshotId: "fiber-1",
        capturedAt: "2026-07-31T10:00:00.000Z",
        source: "react-native-fiber",
        scope: "full",
        screen: { x: 0, y: 0, width: 430, height: 932 },
        root: {
          ref: "rn:root",
          kind: "component",
          label: 'Café 👋 \\"quoted\\"',
          children: [
            { ref: "rn:empty", kind: "host", children: [] },
            { ref: "rn:child", kind: "host", text: "日本語" },
          ],
        },
        stats: { nodeCount: 3, truncated: false },
        metro: {
          host: "127.0.0.1",
          port: 8081,
          targetId: "target-1",
          targetTitle: "Inbox",
          renderer: "fabric",
        },
      },
      screenContext: {
        schemaVersion: 1,
        kind: "react-native",
        capturedAt: "2026-07-31T10:00:00.000Z",
        frameId: "frame-1",
        renderer: "fabric",
        target: "Inbox",
        confidence: "exact",
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(output));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const chunks = [bytes.subarray(0, 137), bytes.subarray(137, 411), bytes.subarray(411)];
    const pages: ElementTreePage[] = chunks.map((chunk, pageIndex) => ({
      schemaVersion: 1,
      transferId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      encoding: "base64-json",
      pageIndex,
      pageCount: chunks.length,
      chunk: Buffer.from(chunk).toString("base64"),
      chunkBytes: chunk.byteLength,
      totalBytes: bytes.byteLength,
      sha256,
      ...(pageIndex + 1 < chunks.length ? { nextCursor: `cursor-${pageIndex + 1}` } : {}),
    }));

    expect(await assembleElementTreePages(pages)).toEqual(output);
    await expect(
      assembleElementTreePages([
        pages[1] as ElementTreePage,
        pages[0] as ElementTreePage,
        pages[2] as ElementTreePage,
      ]),
    ).rejects.toThrow("out of order");
  });

  test("flattens, filters, and hit-tests accessibility trees", () => {
    expect(flattenTree(root).map((node) => node.ref)).toEqual(["root", "button"]);
    expect(visibleTree(root, new Set(["root"]), "").map(({ node }) => node.ref)).toEqual([
      "root",
      "button",
    ]);
    expect(visibleTree(root, new Set(), "submit")[0]?.node.ref).toBe("button");
    expect(commentableNodeAtPoint(root, { kind: "point", x: 0.25, y: 0.25 })?.ref).toBe("button");
  });

  test("compacts React Native inspector rows to rendered on-screen hosts", () => {
    const visibleHost: AccessibilityNode = {
      ref: "rn:visible",
      kind: "host",
      hostComponent: "RCTText",
      text: "Visible",
      frame: {
        points: { x: 20, y: 40, width: 120, height: 30 },
        normalized: { x: 0.05, y: 0.05, width: 0.3, height: 0.04 },
      },
    };
    const reactRoot: AccessibilityNode = {
      ref: "rn:root",
      kind: "component",
      frame: {
        points: { x: 0, y: 0, width: 400, height: 800 },
        normalized: { x: 0, y: 0, width: 1, height: 1 },
      },
      children: [
        {
          ref: "rn:provider",
          kind: "component",
          component: "Provider",
          children: [
            visibleHost,
            {
              ref: "rn:offscreen",
              kind: "host",
              hostComponent: "RCTView",
              frame: {
                points: { x: 20, y: 900, width: 120, height: 30 },
                normalized: { x: 0.05, y: 1.125, width: 0.3, height: 0.04 },
              },
            },
          ],
        },
      ],
    };

    const rows = inspectorTreeRows(reactRoot, true);
    expect(rows.map(({ node, depth }) => [node.ref, depth])).toEqual([
      ["rn:root", 0],
      ["rn:visible", 1],
    ]);
    expect(rows[0]?.hasChildren).toBe(true);
    expect(rows[1]?.node).toBe(visibleHost);
  });

  test("prefers a measured React Native host when annotating a point", () => {
    const frame = {
      points: { x: 20, y: 20, width: 80, height: 40 },
      normalized: { x: 0.2, y: 0.2, width: 0.4, height: 0.2 },
    };
    const reactRoot: AccessibilityNode = {
      ref: "rn:root",
      kind: "component",
      children: [
        { ref: "rn:component", kind: "component", component: "Provider", frame },
        { ref: "rn:host", kind: "host", hostComponent: "RCTView", frame },
      ],
    };

    expect(commentableNodeAtPoint(reactRoot, { kind: "point", x: 0.3, y: 0.3 })?.ref).toBe(
      "rn:host",
    );
  });

  test("builds stable element paths and annotation context", () => {
    const snapshot: AccessibilitySnapshot = {
      schemaVersion: 1,
      snapshotId: "snapshot-1",
      capturedAt: "2026-07-31T10:00:00.000Z",
      source: "core-simulator-ax",
      scope: "visible",
      screen: { x: 0, y: 0, width: 100, height: 100 },
      root,
      stats: { nodeCount: 2, truncated: false },
    };
    expect(elementPath(root, child)).toEqual(["Screen", "Submit"]);
    expect(contextForNode(snapshot, child).accessibility?.snapshotId).toBe("snapshot-1");
  });

  test("formats React Native screen and element source context", () => {
    const host: AccessibilityNode = {
      ...child,
      kind: "host",
      component: "InboxButton",
      componentPath: ["App", "InboxScreen", "InboxButton"],
      hostComponent: "RCTView",
      testID: "inbox-button",
      sourceLocation: { file: "src/InboxButton.tsx", line: 24, column: 7 },
    };
    const snapshot: ReactNativeElementSnapshot = {
      schemaVersion: 1,
      snapshotId: "fiber-1",
      capturedAt: "2026-07-31T10:00:00.000Z",
      source: "react-native-fiber",
      scope: "visible",
      screen: { x: 0, y: 0, width: 430, height: 932 },
      root: { ...root, children: [host] },
      stats: { nodeCount: 2, truncated: false },
      metro: {
        host: "127.0.0.1",
        port: 8081,
        targetId: "target-1",
        targetTitle: "Hermes React Native",
        renderer: "fabric",
      },
    };
    const screen: ReactNativeScreenContext = {
      schemaVersion: 1,
      kind: "react-native",
      capturedAt: "2026-07-31T10:00:00.000Z",
      frameId: "frame-1",
      simulatorName: "iPhone 17 Pro",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      bundleId: "com.example.Inbox",
      viewport: { x: 0, y: 0, width: 430, height: 932 },
      orientation: "portrait",
      renderer: "fabric",
      target: "Hermes React Native",
      route: "Inbox",
      navigationPath: ["Tabs", "Inbox"],
      screenComponent: "InboxScreen",
      testID: "inbox-screen",
      sourceLocation: { file: "src/InboxScreen.tsx", line: 12 },
      confidence: "exact",
    };

    expect(contextForNode(snapshot, host).metro).toMatchObject({
      component: "InboxButton",
      componentPath: ["App", "InboxScreen", "InboxButton"],
      hostComponent: "RCTView",
      testID: "inbox-button",
      sourceLocation: { file: "src/InboxButton.tsx", line: 24, column: 7 },
    });
    expect(annotationMessageScreenContext(screen)).toEqual([
      "Simulator: iPhone 17 Pro · iOS 26.0",
      "App: com.example.Inbox",
      "Route: Inbox",
      "Navigation: Tabs › Inbox",
      "Screen component: InboxScreen",
      "Screen test ID: inbox-screen",
      "Screen source: src/InboxScreen.tsx:12",
      "Viewport: 430 × 932 · portrait",
      "Renderer: fabric",
      "Frame: frame-1",
    ]);
  });

  test("validates app-facing state and annotation payloads", () => {
    expect(
      parseSessionState({
        reviewId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
        annotations: [],
        codec: "h264",
        connected: true,
      })?.connected,
    ).toBe(true);
    expect(parseSessionState({ connected: "yes" })).toBeUndefined();
    expect(() => requireAnnotation({ id: "not-a-uuid" })).toThrow();
  });

  test("claims fullscreen only once after the host advertises it", () => {
    const gate = { claimed: false };
    expect(claimFullscreenRequest(gate, undefined)).toBe(false);
    expect(gate.claimed).toBe(false);
    expect(
      claimFullscreenRequest(gate, {
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
      }),
    ).toBe(true);
    expect(
      claimFullscreenRequest(gate, {
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
      }),
    ).toBe(false);
  });

  test("formats runtime names and frame messages", () => {
    expect(formatRuntime("com.apple.CoreSimulator.SimRuntime.iOS-26-0")).toBe("iOS 26.0");
    expect([...streamMessage(0x10, new Uint8Array([1, 2]))]).toEqual([0x10, 1, 2]);
  });

  test("builds an implementation-first annotation handoff", () => {
    const annotation: Annotation = {
      id: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      frameId: "frame-1",
      createdAt: "2026-07-31T10:00:00.000Z",
      geometry: { kind: "point", x: 0.25, y: 0.25 },
      note: "Increase title contrast",
      context: {
        capturedAt: "2026-07-31T10:00:00.000Z",
        accessibility: {
          snapshotId: "snapshot-1",
          role: "AXButton",
          label: "Inbox",
          identifier: "inbox-button",
          actions: ["AXPress"],
          frame: { x: 0.2, y: 0.2, width: 0.2, height: 0.1 },
          path: ["Screen", "Inbox"],
        },
        metro: {
          route: "/inbox",
          component: "InboxButton",
          testID: "inbox-cta",
          source: "src/InboxButton.tsx",
        },
        native: {
          viewClass: "UIButton",
          controllerClass: "InboxViewController",
          sceneIdentifier: "scene-1",
        },
      },
    };
    const context = annotationMessageContext(annotation);
    const screenContextValue = createUIKitScreenContext(
      {
        device: {
          udid: "device-1",
          name: "iPhone 17 Pro",
          state: "Booted",
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        },
        frameId: "frame-1",
        route: "/inbox",
        component: {
          label: "InboxScreen",
          testID: "inbox-screen",
          source: "src/InboxScreen.tsx",
        },
      },
      {
        status: { bundled: true, connected: true, bundleId: "com.example.Inbox" },
        target: { source: "probe", bundleId: "com.example.Inbox" },
        context: {
          schemaVersion: 1,
          scenes: [
            {
              persistentIdentifier: "scene-1",
              role: "UIWindowSceneSessionRoleApplication",
              activationState: "foregroundActive",
              configurationName: "Default Configuration",
              delegateClass: "InboxSceneDelegate",
              windows: [
                {
                  className: "UIWindow",
                  key: true,
                  hidden: false,
                  visibleControllerPath: ["UINavigationController", "InboxViewController"],
                },
              ],
            },
          ],
        },
      },
      [annotation],
    );
    const screenContext = annotationMessageScreenContext(screenContextValue);
    const content = annotationMessageContent("full-frame", screenContext, [
      { text: "Increase title contrast", context, screenshotPath: "element-crop" },
    ]);

    expect(ANNOTATION_IMPLEMENTATION_PROMPT.startsWith("/SimView\n")).toBe(false);
    expect(ANNOTATION_IMPLEMENTATION_PROMPT).toContain("Do not open another SimView review");
    expect(context).toEqual([
      "Object: Button",
      "Coordinate: x=25.0%, y=25.0%",
      "ID: inbox-button",
      'Label: "Inbox"',
      "Hierarchy: Screen › Inbox",
      "Route: /inbox",
      "Component: InboxButton",
      "Test ID: inbox-cta",
      "Source: src/InboxButton.tsx",
      "View: UIButton",
    ]);
    expect(screenContext).toEqual([
      "Simulator: iPhone 17 Pro · iOS 26.0",
      "App: com.example.Inbox",
      "Screen: UINavigationController › InboxViewController",
      "Route: /inbox",
      "Component: InboxScreen",
      "Test ID: inbox-screen",
      "Source: src/InboxScreen.tsx",
      "Window: UIWindow",
      "Scene delegate: InboxSceneDelegate",
      "Scene configuration: Default Configuration",
      "Frame: frame-1",
    ]);
    expect(context.join("\n")).not.toContain("AXPress");
    expect(context.join("\n")).not.toContain("0.2");
    expect(context.join("\n")).not.toContain("scene-1");
    expect(content).toEqual([
      { type: "text", text: ANNOTATION_IMPLEMENTATION_PROMPT },
      { type: "text", text: "Frozen frame screenshot: full-frame" },
      {
        type: "text",
        text: `## Screen context\n\n${screenContext.map((value) => `- ${value}`).join("\n")}`,
      },
      {
        type: "text",
        text: `## Annotations\n\n1. Annotation: Increase title contrast\nContext:\n${context.map((value) => `- ${value}`).join("\n")}\nCropped screenshot: element-crop`,
      },
    ]);
  });

  test("always sends local image paths as text blocks", () => {
    expect(
      annotationMessageContent(
        "full-frame",
        ["Screen: InboxViewController"],
        [
          {
            text: "Increase title contrast",
            context: ["Object: Button"],
            screenshotPath: "crop",
          },
        ],
      ),
    ).toEqual([
      { type: "text", text: ANNOTATION_IMPLEMENTATION_PROMPT },
      { type: "text", text: "Frozen frame screenshot: full-frame" },
      {
        type: "text",
        text: "## Screen context\n\n- Screen: InboxViewController",
      },
      {
        type: "text",
        text: "## Annotations\n\n1. Annotation: Increase title contrast\nContext:\n- Object: Button\nCropped screenshot: crop",
      },
    ]);
  });

  test("crops around an annotation when no accessibility bounds are available", () => {
    const crop = annotationCropRect({
      id: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      frameId: "frame-1",
      createdAt: "2026-07-31T10:00:00.000Z",
      geometry: { kind: "point", x: 0.9, y: 0.9 },
      note: "Move this control",
    });

    expect(crop.x).toBeCloseTo(0.64);
    expect(crop.y).toBeCloseTo(0.76);
    expect(crop.width).toBeCloseTo(0.36);
    expect(crop.height).toBeCloseTo(0.24);
  });
});
