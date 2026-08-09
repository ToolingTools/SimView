import { describe, expect, test } from "bun:test";
import type { AccessibilityNode, AccessibilitySnapshot } from "@simview/contracts";
import {
  accessibilityResourceSemanticHash,
  indexSemanticSnapshot,
  semanticObservationHash,
  semanticSnapshotDelta,
} from "../packages/mcp/src/semantic-state";

function semanticSnapshot(
  suffix: string,
  children: AccessibilityNode[] = [
    {
      ref: `button-${suffix}`,
      identifier: "continue",
      role: "button",
      label: "Continue",
      enabled: true,
      checked: false,
      selected: false,
    },
  ],
): AccessibilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: `snapshot-${suffix}`,
    capturedAt: `2026-08-10T00:00:0${suffix}.000Z`,
    source: "core-simulator-xctest",
    scope: "interactive",
    screen: { x: 0, y: 0, width: 1, height: 1 },
    root: {
      ref: `root-${suffix}`,
      role: "application",
      children,
    },
    stats: { nodeCount: children.length + 1, truncated: false },
  };
}

describe("semantic state hashing", () => {
  test("preserves the externally observable hash encodings", () => {
    const snapshot = semanticSnapshot("1");

    expect(accessibilityResourceSemanticHash(snapshot)).toBe(
      "2ce2e5bee41e5f006d1158e60a1dc6f3f7ed266c08c5917cad757e7acc41d579",
    );
    expect(semanticObservationHash(indexSemanticSnapshot(snapshot))).toBe(
      "57d4581b84c52b2c2b9eec69dc1f4421b81eaefff92b554e8f7119ace530925a",
    );
  });

  test("ignores regenerated refs and capture metadata", () => {
    const first = semanticSnapshot("1");
    const regenerated = semanticSnapshot("2");
    const firstIndex = indexSemanticSnapshot(first);
    const regeneratedIndex = indexSemanticSnapshot(regenerated);

    expect(accessibilityResourceSemanticHash(regenerated)).toBe(
      accessibilityResourceSemanticHash(first),
    );
    expect(semanticObservationHash(regeneratedIndex)).toBe(semanticObservationHash(firstIndex));
    expect(semanticSnapshotDelta(firstIndex, regeneratedIndex)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  test("reports checked and selected state transitions using the current ref", () => {
    const first = semanticSnapshot("1");
    const changed = semanticSnapshot("2");
    const changedButton = changed.root.children?.[0];
    if (!changedButton) throw new Error("Test snapshot is missing its button");
    changedButton.checked = true;
    changedButton.selected = true;

    const firstIndex = indexSemanticSnapshot(first);
    const changedIndex = indexSemanticSnapshot(changed);
    expect(accessibilityResourceSemanticHash(changed)).not.toBe(
      accessibilityResourceSemanticHash(first),
    );
    expect(semanticObservationHash(changedIndex)).not.toBe(semanticObservationHash(firstIndex));
    expect(semanticSnapshotDelta(firstIndex, changedIndex)).toEqual({
      added: [],
      removed: [],
      changed: ["button-2"],
    });
  });

  test("treats hierarchy reordering as a semantic change", () => {
    const first = semanticSnapshot("1", [
      { ref: "first-1", identifier: "first", role: "button", label: "First" },
      { ref: "second-1", identifier: "second", role: "button", label: "Second" },
    ]);
    const reordered = semanticSnapshot("2", [
      { ref: "second-2", identifier: "second", role: "button", label: "Second" },
      { ref: "first-2", identifier: "first", role: "button", label: "First" },
    ]);

    expect(accessibilityResourceSemanticHash(reordered)).not.toBe(
      accessibilityResourceSemanticHash(first),
    );
    expect(semanticObservationHash(indexSemanticSnapshot(reordered))).not.toBe(
      semanticObservationHash(indexSemanticSnapshot(first)),
    );
  });
});
