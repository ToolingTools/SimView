import { z } from "zod";
import { accessibilityNodeSchema } from "./accessibility";
import { annotationSchema } from "./annotation";
import { deviceDescriptionSchema, probeStatusSchema, probeTargetSchema } from "./protocol";

export const sessionStateSchema = z.object({
  reviewId: z.string().uuid(),
  device: deviceDescriptionSchema.optional(),
  frameId: z.string().optional(),
  route: z.string().optional(),
  component: z
    .object({
      testID: z.string().optional(),
      label: z.string().optional(),
      source: z.string().optional(),
    })
    .optional(),
  annotations: z.array(annotationSchema),
  codec: z.enum(["h264", "mjpeg"]),
  connected: z.boolean(),
});

export const simulatorListSchema = z.object({ devices: z.array(deviceDescriptionSchema) });
export const deviceListSchema = simulatorListSchema;

export const semanticErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean(),
});
export type SemanticError = z.output<typeof semanticErrorSchema>;

export const previewPacketBatchSchema = z.object({
  reset: z.boolean(),
  configuration: z.string().optional(),
  packets: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      kind: z.number().int(),
      data: z.string(),
    }),
  ),
  nextSequence: z.number().int().nonnegative(),
});

const controllerNodeSchema: z.ZodType<ControllerNode> = z.lazy(() =>
  z.object({
    className: z.string(),
    title: z.string().optional(),
    relationship: z.string(),
    visible: z.boolean(),
    children: z.array(controllerNodeSchema).optional(),
  }),
);

interface ControllerNode {
  className: string;
  title?: string | undefined;
  relationship: string;
  visible: boolean;
  children?: ControllerNode[] | undefined;
}

export const probeContextSchema = z.object({
  schemaVersion: z.number().int().positive(),
  scenes: z
    .array(
      z.object({
        persistentIdentifier: z.string(),
        role: z.string(),
        activationState: z.string(),
        configurationName: z.string().optional(),
        delegateClass: z.string().optional(),
        windows: z
          .array(
            z.object({
              className: z.string(),
              key: z.boolean(),
              hidden: z.boolean(),
              visibleControllerPath: z.array(z.string()).optional(),
              controllerTree: controllerNodeSchema.optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export const uiContextSchema = z.object({
  status: probeStatusSchema,
  target: probeTargetSchema.optional(),
  context: probeContextSchema.optional(),
});

export const inspectPointOutputSchema = z.object({
  element: accessibilityNodeSchema,
  native: z
    .object({
      viewClass: z.string().optional(),
      controllerClass: z.string().optional(),
      controllerPath: z.array(z.string()).optional(),
      windowClass: z.string().optional(),
      sceneIdentifier: z.string().optional(),
    })
    .passthrough()
    .optional(),
  probe: probeStatusSchema.optional(),
});

export type SessionState = z.output<typeof sessionStateSchema>;
export type PreviewPacketBatch = z.output<typeof previewPacketBatchSchema>;
export type UiContext = z.output<typeof uiContextSchema>;
export type InspectPointOutput = z.output<typeof inspectPointOutputSchema>;
