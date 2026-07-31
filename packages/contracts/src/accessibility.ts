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
  frame?: { points: NormalizedRect; normalized: NormalizedRect } | undefined;
  children?: AccessibilityNode[] | undefined;
  [key: string]: unknown;
}

export const accessibilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string(),
    capturedAt: z.string(),
    source: z.literal("core-simulator-ax"),
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
