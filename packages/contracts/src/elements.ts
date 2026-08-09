import { z } from "zod";
import {
  accessibilityNodeSchema,
  accessibilitySnapshotSchema,
  normalizedRectSchema,
} from "./accessibility";

export const sourceLocationSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});

export const reactNativeElementMetadataSchema = z.object({
  kind: z.enum(["component", "host"]),
  component: z.string().optional(),
  componentPath: z.array(z.string()).optional(),
  hostComponent: z.string().optional(),
  testID: z.string().optional(),
  text: z.string().optional(),
  interactive: z.boolean().optional(),
  sourceLocation: sourceLocationSchema.optional(),
});

export const reactNativeElementNodeSchema = accessibilityNodeSchema.and(
  reactNativeElementMetadataSchema,
);

export const reactNativeElementSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string(),
  capturedAt: z.string(),
  source: z.literal("react-native-fiber"),
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
  metro: z.object({
    host: z.string(),
    port: z.number().int().positive(),
    targetId: z.string(),
    targetTitle: z.string(),
    renderer: z.enum(["fabric", "paper", "unknown"]),
  }),
});

export const elementSnapshotSchema = z.discriminatedUnion("source", [
  accessibilitySnapshotSchema,
  reactNativeElementSnapshotSchema,
]);

const screenContextCommonSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string(),
  frameId: z.string(),
  platform: z.enum(["ios", "android"]).optional(),
  deviceName: z.string().optional(),
  simulatorName: z.string().optional(),
  runtime: z.string().optional(),
  bundleId: z.string().optional(),
  viewport: normalizedRectSchema.optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
});

export const reactNativeScreenContextSchema = screenContextCommonSchema.extend({
  kind: z.literal("react-native"),
  renderer: z.enum(["fabric", "paper", "unknown"]),
  target: z.string(),
  route: z.string().optional(),
  navigationPath: z.array(z.string()).optional(),
  screenComponent: z.string().optional(),
  componentPath: z.array(z.string()).optional(),
  testID: z.string().optional(),
  sourceLocation: sourceLocationSchema.optional(),
  confidence: z.enum(["exact", "inferred", "none"]),
  packageName: z.string().optional(),
  activityName: z.string().optional(),
});

export const nativeIOSScreenContextSchema = screenContextCommonSchema.extend({
  kind: z.literal("native-ios"),
  route: z.string().optional(),
  component: z.string().optional(),
  testID: z.string().optional(),
  source: z.string().optional(),
  controllerPath: z.array(z.string()).optional(),
  windowClass: z.string().optional(),
  sceneDelegate: z.string().optional(),
  sceneConfiguration: z.string().optional(),
});

export const androidScreenContextSchema = screenContextCommonSchema.extend({
  kind: z.literal("android"),
  packageName: z.string().optional(),
  activityName: z.string().optional(),
  processId: z.number().int().positive().optional(),
  taskId: z.number().int().nonnegative().optional(),
  route: z.string().optional(),
  component: z.string().optional(),
  testID: z.string().optional(),
  source: z.string().optional(),
});

export const screenContextSchema = z.discriminatedUnion("kind", [
  reactNativeScreenContextSchema,
  nativeIOSScreenContextSchema,
  androidScreenContextSchema,
]);

export const elementFallbackReasonSchema = z.enum([
  "metro-target-unavailable",
  "metro-fiber-unavailable",
  "metro-inspection-failed",
]);

export const elementFallbackDetailSchema = z.enum([
  "metro-unreachable",
  "metro-running-no-debug-targets",
  "metro-target-mismatch",
  "metro-fiber-root-missing",
  "metro-connect-or-evaluate-failed",
]);

export const elementTreeOutputSchema = z.object({
  snapshot: elementSnapshotSchema,
  screenContext: screenContextSchema,
  fallback: z
    .object({
      reason: elementFallbackReasonSchema,
      detail: elementFallbackDetailSchema.optional(),
    })
    .optional(),
});

export const ELEMENT_TREE_PAGE_RAW_BYTES = 48 * 1_024;
export const ELEMENT_TREE_TRANSFER_MAX_BYTES = 4 * 1_024 * 1_024;
export const ELEMENT_TREE_TRANSFER_MAX_PAGES = Math.ceil(
  ELEMENT_TREE_TRANSFER_MAX_BYTES / ELEMENT_TREE_PAGE_RAW_BYTES,
);

export const elementTreePageSchema = z.object({
  schemaVersion: z.literal(1),
  transferId: z.string().uuid(),
  encoding: z.literal("base64-json"),
  pageIndex: z.number().int().nonnegative(),
  pageCount: z.number().int().positive().max(ELEMENT_TREE_TRANSFER_MAX_PAGES),
  chunk: z
    .string()
    .min(1)
    .max(Math.ceil(ELEMENT_TREE_PAGE_RAW_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  chunkBytes: z.number().int().positive().max(ELEMENT_TREE_PAGE_RAW_BYTES),
  totalBytes: z.number().int().positive().max(ELEMENT_TREE_TRANSFER_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  nextCursor: z.string().max(128).optional(),
});

export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export type ReactNativeElementMetadata = z.infer<typeof reactNativeElementMetadataSchema>;
export type ReactNativeElementSnapshot = z.infer<typeof reactNativeElementSnapshotSchema>;
export type ElementSnapshot = z.infer<typeof elementSnapshotSchema>;
export type ReactNativeScreenContext = z.infer<typeof reactNativeScreenContextSchema>;
export type NativeIOSScreenContext = z.infer<typeof nativeIOSScreenContextSchema>;
export type AndroidScreenContext = z.infer<typeof androidScreenContextSchema>;
export type ScreenContext = z.infer<typeof screenContextSchema>;
export type ElementFallbackReason = z.infer<typeof elementFallbackReasonSchema>;
export type ElementFallbackDetail = z.infer<typeof elementFallbackDetailSchema>;
export type ElementTreeOutput = z.infer<typeof elementTreeOutputSchema>;
export type ElementTreePage = z.infer<typeof elementTreePageSchema>;
