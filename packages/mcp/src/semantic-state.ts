import { createHash } from "node:crypto";
import { type AccessibilitySnapshot, stableAccessibilityEntries } from "@simview/contracts";

export type SemanticSnapshotIndex = Map<string, { hash: string; ref: string }>;

/**
 * Builds the ref-aware index used for MCP observation deltas. Its hash is
 * intentionally distinct from the accessibility resource hash below; both
 * values are externally observable and must remain byte-compatible.
 */
export function indexSemanticSnapshot(snapshot: AccessibilitySnapshot): SemanticSnapshotIndex {
  return new Map(
    stableAccessibilityEntries(snapshot.root).map(({ key, ref, value }) => [
      key,
      { ref, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") },
    ]),
  );
}

export function semanticObservationHash(index: SemanticSnapshotIndex): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...index]
          .map(([key, entry]) => [key, entry.hash] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

export function accessibilityResourceSemanticHash(snapshot: AccessibilitySnapshot): string {
  const entries = stableAccessibilityEntries(snapshot.root)
    .map((entry) => [entry.key, entry.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function semanticSnapshotDelta(
  previous: SemanticSnapshotIndex,
  current: SemanticSnapshotIndex,
): { added: string[]; removed: string[]; changed: string[] } {
  const added = [...current.keys()].filter((key) => !previous.has(key));
  const removed = [...previous].filter(([key]) => !current.has(key)).map(([, entry]) => entry.ref);
  const changed = [...current]
    .filter(([key, entry]) => previous.get(key)?.hash !== entry.hash && previous.has(key))
    .map(([, entry]) => entry.ref);
  return {
    added: added.map((key) => current.get(key)?.ref ?? key),
    removed,
    changed,
  };
}
