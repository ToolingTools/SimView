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
    source: z.enum(["core-simulator-ax", "android-uiautomator"]),
    scope: z.enum(["interactive", "visible", "full"]),
    screen: normalizedRectSchema,
    root: accessibilityNodeSchema,
    stats: z.object({
      nodeCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  })
  .passthrough();

export type AccessibilitySnapshot = z.infer<typeof accessibilitySnapshotSchema>;

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
});

export type ElementSearchMatch = z.infer<typeof elementSearchMatchSchema>;
