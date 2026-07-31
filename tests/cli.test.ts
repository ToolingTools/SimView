import { describe, expect, test } from "bun:test";
import type { ElementTreeOutput } from "@simview/contracts";
import { formatElementTree } from "../packages/cli/src/index";

describe("CLI element tree output", () => {
  test("identifies the React Native renderer and focused screen", () => {
    const result: ElementTreeOutput = {
      snapshot: {
        schemaVersion: 1,
        snapshotId: "fiber-1",
        capturedAt: "2026-07-31T10:00:00.000Z",
        source: "react-native-fiber",
        scope: "interactive",
        screen: { x: 0, y: 0, width: 430, height: 932 },
        root: { ref: "rn:root" },
        stats: { nodeCount: 1, truncated: false },
        metro: {
          host: "127.0.0.1",
          port: 8081,
          targetId: "target-1",
          targetTitle: "Shop",
          renderer: "fabric",
        },
      },
      screenContext: {
        schemaVersion: 1,
        kind: "react-native",
        capturedAt: "2026-07-31T10:00:00.000Z",
        frameId: "frame-1",
        renderer: "fabric",
        target: "Shop",
        route: "ShopMenuRoot",
        navigationPath: ["Tabs", "ShopTab", "ShopMenuRoot"],
        screenComponent: "ShopMenuScreen",
        confidence: "exact",
      },
    };

    expect(formatElementTree(result).split("\n")[0]).toBe(
      "source=react-native-fiber renderer=fabric screen=Tabs > ShopTab > ShopMenuRoot component=ShopMenuScreen",
    );
  });

  test("identifies a diagnostic AX fallback", () => {
    const result: ElementTreeOutput = {
      snapshot: {
        schemaVersion: 1,
        snapshotId: "ax-1",
        capturedAt: "2026-07-31T10:00:00.000Z",
        source: "core-simulator-ax",
        scope: "interactive",
        screen: { x: 0, y: 0, width: 430, height: 932 },
        root: { ref: "ax:root" },
        stats: { nodeCount: 1, truncated: false },
      },
      screenContext: {
        schemaVersion: 1,
        kind: "uikit",
        capturedAt: "2026-07-31T10:00:00.000Z",
        frameId: "frame-1",
      },
      fallback: { reason: "metro-target-unavailable" },
    };

    expect(formatElementTree(result).split("\n")[0]).toBe(
      "source=core-simulator-ax fallback=metro-target-unavailable",
    );
  });
});
