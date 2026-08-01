import { z } from "zod";
import { normalizedRectSchema } from "./accessibility";

export const annotationGeometrySchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("point"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    }),
    z.object({
      kind: z.literal("rect"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    }),
  ])
  .superRefine((geometry, context) => {
    if (geometry.kind !== "rect") return;
    if (geometry.x + geometry.width > 1) {
      context.addIssue({
        code: "custom",
        message: "Rectangle extends beyond the right edge",
        path: ["width"],
      });
    }
    if (geometry.y + geometry.height > 1) {
      context.addIssue({
        code: "custom",
        message: "Rectangle extends beyond the bottom edge",
        path: ["height"],
      });
    }
  });

export const annotationContextSchema = z.object({
  capturedAt: z.string(),
  accessibility: z
    .object({
      snapshotId: z.string(),
      ref: z.string().optional(),
      role: z.string().optional(),
      roleDescription: z.string().optional(),
      title: z.string().optional(),
      label: z.string().optional(),
      identifier: z.string().optional(),
      value: z.string().optional(),
      actions: z.array(z.string()).optional(),
      frame: normalizedRectSchema.optional(),
      path: z.array(z.string()).optional(),
    })
    .optional(),
  native: z
    .object({
      viewClass: z.string().optional(),
      controllerClass: z.string().optional(),
      controllerPath: z.array(z.string()).optional(),
      windowClass: z.string().optional(),
      sceneIdentifier: z.string().optional(),
      matchConfidence: z.enum(["exact", "strong", "weak", "none"]).optional(),
    })
    .optional(),
  metro: z
    .object({
      route: z.string().optional(),
      component: z.string().optional(),
      componentPath: z.array(z.string()).optional(),
      hostComponent: z.string().optional(),
      testID: z.string().optional(),
      source: z.string().optional(),
      sourceLocation: z
        .object({
          file: z.string(),
          line: z.number().int().positive().optional(),
          column: z.number().int().positive().optional(),
        })
        .optional(),
      accessibilityLabel: z.string().optional(),
      role: z.string().optional(),
      text: z.string().optional(),
      frame: normalizedRectSchema.optional(),
    })
    .optional(),
});

export const annotationSchema = z.object({
  id: z.string().uuid(),
  frameId: z.string(),
  createdAt: z.string(),
  geometry: annotationGeometrySchema,
  note: z.string(),
  route: z.string().optional(),
  component: z
    .object({
      testID: z.string().optional(),
      label: z.string().optional(),
      source: z.string().optional(),
    })
    .optional(),
  context: annotationContextSchema.optional(),
});

export type AnnotationGeometry = z.infer<typeof annotationGeometrySchema>;
export type AnnotationContext = z.infer<typeof annotationContextSchema>;
export type Annotation = z.infer<typeof annotationSchema>;
