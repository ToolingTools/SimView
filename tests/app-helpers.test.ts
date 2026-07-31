import { describe, expect, test } from "bun:test";
import type { AccessibilityNode, AccessibilitySnapshot } from "@simview/contracts";
import {
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

  test("formats runtime names and frame messages", () => {
    expect(formatRuntime("com.apple.CoreSimulator.SimRuntime.iOS-26-0")).toBe("iOS 26.0");
    expect([...streamMessage(0x10, new Uint8Array([1, 2]))]).toEqual([0x10, 1, 2]);
  });
});
