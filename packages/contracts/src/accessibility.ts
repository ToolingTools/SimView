import { z } from "zod";

export const normalizedRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

export type NormalizedRect = z.infer<typeof normalizedRectSchema>;

export const accessibilityNodeSchema: z.ZodType<AccessibilityNode> = z.lazy(() =>
  z
    .object({
      ref: z.string(),
      role: z.string().optional(),
      roleDescription: z.string().optional(),
      subrole: z.string().optional(),
      label: z.string().optional(),
      value: z.string().optional(),
      valueRedacted: z.boolean().optional(),
      identifier: z.string().optional(),
      title: z.string().optional(),
      help: z.string().optional(),
      placeholder: z.string().optional(),
      enabled: z.boolean().optional(),
      hidden: z.boolean().optional(),
      focused: z.boolean().optional(),
      expanded: z.boolean().optional(),
      actions: z.array(z.string()).optional(),
      kind: z.enum(["component", "host"]).optional(),
      component: z.string().optional(),
      componentPath: z.array(z.string()).optional(),
      hostComponent: z.string().optional(),
      testID: z.string().optional(),
      text: z.string().optional(),
      interactive: z.boolean().optional(),
      sourceLocation: z
        .object({
          file: z.string(),
          line: z.number().int().positive().optional(),
          column: z.number().int().positive().optional(),
        })
        .optional(),
      frame: z
        .object({
          points: normalizedRectSchema,
          normalized: normalizedRectSchema,
        })
        .optional(),
      children: z.array(accessibilityNodeSchema).optional(),
    })
    .passthrough(),
);

export interface AccessibilityNode {
  ref: string;
  role?: string | undefined;
  roleDescription?: string | undefined;
  subrole?: string | undefined;
  label?: string | undefined;
  value?: string | undefined;
  valueRedacted?: boolean | undefined;
  identifier?: string | undefined;
  title?: string | undefined;
  help?: string | undefined;
  placeholder?: string | undefined;
  enabled?: boolean | undefined;
  hidden?: boolean | undefined;
  focused?: boolean | undefined;
  expanded?: boolean | undefined;
  actions?: string[] | undefined;
  kind?: "component" | "host" | undefined;
  component?: string | undefined;
  componentPath?: string[] | undefined;
  hostComponent?: string | undefined;
  testID?: string | undefined;
  text?: string | undefined;
  interactive?: boolean | undefined;
  sourceLocation?:
    | { file: string; line?: number | undefined; column?: number | undefined }
    | undefined;
  frame?: { points: NormalizedRect; normalized: NormalizedRect } | undefined;
  children?: AccessibilityNode[] | undefined;
  [key: string]: unknown;
}

export function flattenAccessibilityTree(root: AccessibilityNode): AccessibilityNode[] {
  const nodes: AccessibilityNode[] = [];
  const visit = (node: AccessibilityNode) => {
    nodes.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  return nodes;
}

export const accessibilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string(),
    capturedAt: z.string(),
    source: z.enum([
      "core-simulator-ax",
      "android-uiautomator",
      "android-agent-uiautomation",
      "android-agent-shell",
    ]),
    scope: z.enum(["interactive", "visible", "full"]),
    screen: normalizedRectSchema,
    root: accessibilityNodeSchema,
    stats: z.object({
      nodeCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
      quality: z.enum(["complete", "partial", "degraded"]).optional(),
      reason: z.string().optional(),
      capturedBudget: z.number().int().positive().optional(),
    }),
  })
  .passthrough();

export type AccessibilitySnapshot = z.infer<typeof accessibilitySnapshotSchema>;

export const accessibilityObservationStrategySchema = z.enum([
  "ios-axp",
  "android-uiautomation",
  "android-shell-dump",
  "snapshot-diff",
]);

export type AccessibilityObservationStrategy = z.infer<
  typeof accessibilityObservationStrategySchema
>;

export const accessibilityObserveParamsSchema = z
  .object({
    afterRevision: z.string().min(1).optional(),
    scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
    maxNodes: z.number().int().min(1).max(5_000).default(1_200),
    settleQuietMs: z.number().int().min(20).max(500).default(75),
    maxWaitMs: z.number().int().min(0).max(5_000).default(500),
    requireChange: z.boolean().default(true),
  })
  .passthrough();

export type AccessibilityObserveParams = z.infer<typeof accessibilityObserveParamsSchema>;

export const accessibilityObserveResultSchema = z
  .object({
    snapshot: accessibilitySnapshotSchema,
    revision: z.string().min(1),
    eventChanged: z.boolean(),
    stable: z.boolean(),
    timedOut: z.boolean(),
    strategy: accessibilityObservationStrategySchema,
    firstChangedAt: z.string().optional(),
    settledAt: z.string(),
    fallbackUsed: z.boolean().optional(),
    captureCount: z.number().int().nonnegative().optional(),
    changeSource: z.enum(["event", "snapshot-diff", "none"]).optional(),
  })
  .passthrough();

export type AccessibilityObserveResult = z.infer<typeof accessibilityObserveResultSchema>;

export const accessibilityResourceSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().min(1),
  semanticHash: z.string().length(64),
  capturedAt: z.string(),
  strategy: accessibilityObservationStrategySchema,
  snapshot: accessibilitySnapshotSchema,
});

export type AccessibilityResource = z.infer<typeof accessibilityResourceSchema>;

export interface StableAccessibilityEntry {
  key: string;
  ref: string;
  value: Record<string, unknown>;
}

/**
 * Produces revision-independent semantic identities. Snapshot refs are useful
 * for actions, but are intentionally excluded from identity so a regenerated
 * tree can still produce an unchanged semantic hash.
 */
export function stableAccessibilityEntries(root: AccessibilityNode): StableAccessibilityEntry[] {
  const visited: Array<{ node: AccessibilityNode; path: number[] }> = [];
  const visit = (node: AccessibilityNode, path: number[]) => {
    visited.push({ node, path });
    node.children?.forEach((child, index) => {
      visit(child, [...path, index]);
    });
  };
  visit(root, []);
  const identityCounts = new Map<string, number>();
  for (const { node } of visited) {
    const identifier = node.testID ?? node.identifier;
    if (!identifier) continue;
    const role = node.role ?? node.roleDescription ?? "";
    const identity = `${identifier}\u0000${role}`;
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }
  return visited.map(({ node, path }) => {
    const role = node.role ?? node.roleDescription ?? "";
    const name = node.label ?? node.title ?? "";
    const identifier = node.testID ?? node.identifier;
    const identity = identifier ? `${identifier}\u0000${role}` : "";
    const key =
      identifier && identityCounts.get(identity) === 1
        ? `identifier:${identifier}\u0000role:${role}`
        : `position:${path.join(".")}\u0000role:${role}\u0000name:${name}`;
    const value = {
      hierarchyPosition: path,
      role: node.role,
      name,
      value: node.valueRedacted ? "<redacted>" : node.value,
      valueRedacted: node.valueRedacted,
      identifier,
      enabled: node.enabled,
      hidden: node.hidden,
      focused: node.focused,
      expanded: node.expanded,
      actions: node.actions?.slice().sort(),
      frame: node.frame?.normalized,
    } satisfies Record<string, unknown>;
    return { key, ref: node.ref, value };
  });
}

const selectorFields = {
  ref: z.string().min(1).optional(),
  identifier: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  exact: z.boolean().default(true),
  index: z.number().int().nonnegative().optional(),
};

export const accessibilitySelectorSchema = z
  .object(selectorFields)
  .refine(
    (selector) =>
      Boolean(
        selector.ref || selector.identifier || selector.role || selector.name || selector.value,
      ),
    { message: "An accessibility selector requires ref, identifier, role, name, or value" },
  );

export type AccessibilitySelector = z.infer<typeof accessibilitySelectorSchema>;

export const semanticNodeSummarySchema = z.object({
  ref: z.string(),
  role: z.string().optional(),
  label: z.string().optional(),
  title: z.string().optional(),
  value: z.string().optional(),
  valueRedacted: z.boolean().optional(),
  identifier: z.string().optional(),
  testID: z.string().optional(),
  placeholder: z.string().optional(),
  enabled: z.boolean().optional(),
  hidden: z.boolean().optional(),
  focused: z.boolean().optional(),
  expanded: z.boolean().optional(),
  actions: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
  component: z.string().optional(),
  sourceLocation: z
    .object({
      file: z.string(),
      line: z.number().int().positive().optional(),
      column: z.number().int().positive().optional(),
    })
    .optional(),
  frame: z
    .object({
      points: normalizedRectSchema,
      normalized: normalizedRectSchema,
    })
    .optional(),
});

export type SemanticNodeSummary = z.infer<typeof semanticNodeSummarySchema>;

export function summarizeAccessibilityNode(node: AccessibilityNode): SemanticNodeSummary {
  return {
    ref: node.ref,
    ...(node.role ? { role: node.role } : {}),
    ...(node.label ? { label: node.label } : {}),
    ...(node.title ? { title: node.title } : {}),
    ...(node.value ? { value: node.valueRedacted ? "<redacted>" : node.value } : {}),
    ...(node.valueRedacted ? { valueRedacted: true } : {}),
    ...(node.identifier ? { identifier: node.identifier } : {}),
    ...(node.testID ? { testID: node.testID } : {}),
    ...(node.placeholder ? { placeholder: node.placeholder } : {}),
    ...(node.enabled !== undefined ? { enabled: node.enabled } : {}),
    ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
    ...(node.focused !== undefined ? { focused: node.focused } : {}),
    ...(node.expanded !== undefined ? { expanded: node.expanded } : {}),
    ...(node.actions?.length ? { actions: node.actions } : {}),
    ...(node.interactive !== undefined ? { interactive: node.interactive } : {}),
    ...(node.component ? { component: node.component } : {}),
    ...(node.sourceLocation ? { sourceLocation: node.sourceLocation } : {}),
    ...(node.frame ? { frame: node.frame } : {}),
  };
}

export const elementSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  roles: z.array(z.string().trim().min(1)).max(10).optional(),
  actionableOnly: z.boolean().default(true),
  visibleOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(20).default(10),
});

export type ElementSearchQuery = z.infer<typeof elementSearchQuerySchema>;

export const elementSearchMatchSchema = z.object({
  element: semanticNodeSummarySchema,
  score: z.number().min(0).max(1),
  matchedFields: z.array(z.string()),
  exact: z.boolean(),
  // Search results can combine native and Fiber projections. Provenance keeps
  // a partial projection from being mistaken for a degraded native snapshot.
  source: z.enum([
    "core-simulator-ax",
    "android-uiautomator",
    "android-agent-uiautomation",
    "android-agent-shell",
    "react-native-fiber",
  ]),
  snapshotId: z.string().min(1),
});

export type ElementSearchMatch = z.infer<typeof elementSearchMatchSchema>;
