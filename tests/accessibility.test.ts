import { describe, expect, test } from "bun:test";
import {
  type AccessibilitySnapshot,
  compactAccessibilityTree,
  flattenAccessibilityTree,
} from "@simview/client";

const snapshot: AccessibilitySnapshot = {
  schemaVersion: 1,
  snapshotId: "snapshot-1",
  capturedAt: "2026-07-29T00:00:00Z",
  source: "core-simulator-ax",
  scope: "interactive",
  screen: { x: 0, y: 0, width: 430, height: 932 },
  stats: { nodeCount: 2, truncated: false },
  root: {
    ref: "ax:snapshot-1:0",
    role: "AXApplication",
    children: [
      {
        ref: "ax:snapshot-1:1",
        role: "AXButton",
        label: "Continue",
        identifier: "continue",
        enabled: true,
        frame: {
          points: { x: 20, y: 800, width: 390, height: 60 },
          normalized: { x: 0.047, y: 0.858, width: 0.907, height: 0.064 },
        },
      },
    ],
  },
};

describe("accessibility helpers", () => {
  test("flattens nested snapshots", () => {
    expect(flattenAccessibilityTree(snapshot.root).map((node) => node.ref)).toEqual([
      "ax:snapshot-1:0",
      "ax:snapshot-1:1",
    ]);
  });

  test("produces compact token-efficient element text", () => {
    const compact = compactAccessibilityTree(snapshot);
    expect(compact).toContain("screen 430x932 snapshot=snapshot-1");
    expect(compact).toContain('AXButton "Continue" id=continue');
    expect(compact).toContain("[0.047,0.858 0.907x0.064]");
  });

  test("includes React Native component and project source context", () => {
    const text = compactAccessibilityTree({
      ...snapshot,
      source: "react-native-fiber",
      root: {
        ...snapshot.root,
        children: [
          {
            ref: "rn:1",
            role: "button",
            label: "Open inbox",
            component: "InboxButton",
            hostComponent: "RCTView",
            testID: "inbox-button",
            sourceLocation: { file: "src/InboxButton.tsx", line: 24 },
          },
        ],
      },
      metro: {
        host: "127.0.0.1",
        port: 8081,
        targetId: "target-1",
        targetTitle: "Hermes React Native",
        renderer: "paper",
      },
    });

    expect(text).toContain("id=inbox-button");
    expect(text).toContain("component=InboxButton");
    expect(text).toContain("host=RCTView");
    expect(text).toContain("source=src/InboxButton.tsx:24");
  });
});
