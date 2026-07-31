import { describe, expect, test } from "bun:test";
import type { AccessibilityNode, AccessibilitySnapshot, Annotation } from "@simview/contracts";
import {
  ANNOTATION_IMPLEMENTATION_PROMPT,
  annotationCropRect,
  annotationMessageContent,
  annotationMessageContext,
  annotationMessageScreenContext,
  claimFullscreenRequest,
  commentableNodeAtPoint,
  contextForNode,
  elementPath,
  flattenTree,
  formatRuntime,
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
  test("flattens, filters, and hit-tests accessibility trees", () => {
    expect(flattenTree(root).map((node) => node.ref)).toEqual(["root", "button"]);
    expect(visibleTree(root, new Set(["root"]), "").map(({ node }) => node.ref)).toEqual([
      "root",
      "button",
    ]);
    expect(visibleTree(root, new Set(), "submit")[0]?.node.ref).toBe("button");
    expect(commentableNodeAtPoint(root, { kind: "point", x: 0.25, y: 0.25 })?.ref).toBe("button");
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
    const screenContext = annotationMessageScreenContext(
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
    const content = annotationMessageContent("full-frame", screenContext, [
      { text: "Increase title contrast", context, crop: "element-crop" },
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
      { type: "image", data: "full-frame", mimeType: "image/png" },
      {
        type: "text",
        text: `## Screen context\n\n${screenContext.map((value) => `- ${value}`).join("\n")}`,
      },
      {
        type: "text",
        text: `## Annotations\n\n1. Annotation: Increase title contrast\nContext:\n${context.map((value) => `- ${value}`).join("\n")}`,
      },
      { type: "image", data: "element-crop", mimeType: "image/png" },
    ]);
  });

  test("falls back to text blocks when the host does not support images", () => {
    expect(
      annotationMessageContent(
        "full-frame",
        ["Screen: InboxViewController"],
        [{ text: "Increase title contrast", context: ["Object: Button"], crop: "crop" }],
        false,
      ),
    ).toEqual([
      { type: "text", text: ANNOTATION_IMPLEMENTATION_PROMPT },
      {
        type: "text",
        text: "## Screen context\n\n- Screen: InboxViewController",
      },
      {
        type: "text",
        text: "## Annotations\n\n1. Annotation: Increase title contrast\nContext:\n- Object: Button",
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
