import { z } from "zod";
import {
  accessibilityNodeSchema,
  accessibilitySelectorSchema,
  accessibilitySnapshotSchema,
} from "./accessibility";
import { jsonObjectSchema, jsonValueSchema } from "./json";
import { PROTOCOL_VERSION } from "./version";

export const codecSchema = z.enum(["h264", "mjpeg"]);
export type Codec = z.infer<typeof codecSchema>;

export const orientationSchema = z.enum([
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
]);
export type Orientation = z.infer<typeof orientationSchema>;

export const normalizedPointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

export const deviceDescriptionSchema = z
  .object({
    udid: z.string(),
    name: z.string(),
    state: z.string(),
    runtime: z.string(),
    pointWidth: z.number().finite().positive().optional(),
    pointHeight: z.number().finite().positive().optional(),
    pixelWidth: z.number().int().positive().optional(),
    pixelHeight: z.number().int().positive().optional(),
  })
  .passthrough();
export type DeviceDescription = z.infer<typeof deviceDescriptionSchema>;

const emptyParamsSchema = z.object({}).strict();
const selectedDeviceParamsSchema = z.object({ udid: z.string().optional() });
const acceptedResultSchema = z.object({ accepted: z.literal(true) }).passthrough();

const findResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string(),
    selector: accessibilitySelectorSchema,
    matches: z.array(accessibilityNodeSchema),
    count: z.number().int().nonnegative(),
  })
  .passthrough();

const waitResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["visible", "hidden"]),
    satisfied: z.literal(true),
    count: z.number().int().nonnegative(),
    snapshotId: z.string(),
    matches: z.array(accessibilityNodeSchema),
  })
  .passthrough();

export const probeStatusSchema = z
  .object({
    bundled: z.boolean(),
    connected: z.boolean(),
    bundleId: z.string().optional(),
    pid: z.number().int().positive().optional(),
  })
  .passthrough();
export type ProbeStatus = z.output<typeof probeStatusSchema>;

export const probeTargetSchema = z
  .object({
    bundleId: z.string().optional(),
    source: z.enum(["probe", "simctl"]),
    error: z.string().optional(),
  })
  .passthrough();
export type ProbeTarget = z.output<typeof probeTargetSchema>;

export const daemonHealthSchema = z.object({
  status: z.literal("ok"),
  pid: z.number().int().positive(),
  instanceId: z.string().nullable(),
  configuredUdid: z.string().nullable(),
  device: deviceDescriptionSchema.nullable(),
  captureActive: z.boolean(),
  captureState: z.enum(["active", "idle"]),
  idleDeadline: z.string().datetime().nullable(),
  capabilities: jsonObjectSchema,
  clients: z.number().int().nonnegative(),
  clientsByCodec: z.object({
    h264: z.number().int().nonnegative(),
    mjpeg: z.number().int().nonnegative(),
  }),
  metrics: jsonObjectSchema,
});
export type DaemonHealth = z.output<typeof daemonHealthSchema>;

export const methodSchemas = {
  hello: {
    params: z.object({
      token: z.string().min(32),
      codecs: z.array(codecSchema).min(1),
      maxWidth: z.number().int().positive().optional(),
      maxHeight: z.number().int().positive().optional(),
      maxFrameRate: z.number().int().min(1).max(120).optional(),
    }),
    result: z.object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      codec: codecSchema,
      maxFrameRate: z.number().int().positive(),
      server: z.string(),
      capabilities: z.object({
        capture: z.boolean(),
        input: z.boolean(),
        accessibility: z.boolean(),
        probe: z.boolean(),
      }),
    }),
  },
  "devices.list": { params: emptyParamsSchema, result: z.array(deviceDescriptionSchema) },
  "device.describe": { params: selectedDeviceParamsSchema, result: deviceDescriptionSchema },
  "capture.start": {
    params: selectedDeviceParamsSchema,
    result: z.object({
      device: deviceDescriptionSchema,
      codec: codecSchema,
      frameRate: z.number().int().positive(),
    }),
  },
  "capture.stop": { params: emptyParamsSchema, result: z.object({ stopped: z.literal(true) }) },
  "capture.keyframe": { params: emptyParamsSchema, result: acceptedResultSchema },
  "capture.screenshot": {
    params: emptyParamsSchema,
    result: z.object({
      frameId: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      byteLength: z.number().int().nonnegative(),
    }),
  },
  "input.touch": {
    params: normalizedPointSchema.extend({
      contactId: z.number().int().nonnegative(),
      phase: z.enum(["down", "move", "up"]),
      pressure: z.number().finite().min(0).max(1).optional(),
      timestamp: z.number().finite().nonnegative().optional(),
    }),
    result: acceptedResultSchema,
  },
  "input.tap": {
    params: normalizedPointSchema.extend({ durationMs: z.number().finite().positive().optional() }),
    result: acceptedResultSchema,
  },
  "input.longPress": {
    params: normalizedPointSchema.extend({ durationMs: z.number().finite().positive().optional() }),
    result: acceptedResultSchema,
  },
  "input.swipe": {
    params: z.object({
      from: normalizedPointSchema,
      to: normalizedPointSchema,
      durationMs: z.number().finite().positive(),
    }),
    result: acceptedResultSchema,
  },
  "input.typeText": {
    params: z.object({ text: z.string() }),
    result: acceptedResultSchema.extend({ inputMethod: z.string() }),
  },
  "input.key": {
    params: z.object({
      usage: z.number().int().nonnegative(),
      phase: z.enum(["down", "up"]),
    }),
    result: acceptedResultSchema,
  },
  "input.button": {
    params: z.object({
      button: z.enum(["home", "lock", "volume-up", "volume-down", "action"]),
    }),
    result: acceptedResultSchema,
  },
  "device.orientation.set": {
    params: z.object({ orientation: orientationSchema }),
    result: acceptedResultSchema,
  },
  "accessibility.snapshot": {
    params: selectedDeviceParamsSchema.extend({
      scope: z.enum(["interactive", "visible", "full"]).optional(),
      maxNodes: z.number().int().min(1).max(5_000).optional(),
    }),
    result: accessibilitySnapshotSchema,
  },
  "accessibility.elementAtPoint": {
    params: selectedDeviceParamsSchema.extend(normalizedPointSchema.shape),
    result: accessibilityNodeSchema,
  },
  "accessibility.find": {
    params: selectedDeviceParamsSchema.extend({
      selector: accessibilitySelectorSchema,
      scope: z.enum(["interactive", "visible", "full"]).optional(),
    }),
    result: findResultSchema,
  },
  "accessibility.wait": {
    params: selectedDeviceParamsSchema.extend({
      selector: accessibilitySelectorSchema,
      state: z.enum(["visible", "hidden"]),
      timeoutMs: z.number().int().min(1).max(30_000),
    }),
    result: waitResultSchema,
  },
  "probe.status": { params: emptyParamsSchema, result: probeStatusSchema },
  "probe.target": { params: selectedDeviceParamsSchema, result: probeTargetSchema },
  "probe.enable": {
    params: selectedDeviceParamsSchema.extend({ bundleId: z.string().min(3) }),
    result: jsonObjectSchema,
  },
  "probe.disable": { params: selectedDeviceParamsSchema, result: jsonObjectSchema },
  "probe.context": { params: emptyParamsSchema, result: jsonObjectSchema },
  "probe.inspectPoint": { params: normalizedPointSchema, result: jsonObjectSchema },
  "probe.findViews": {
    params: z.object({
      filters: z
        .object({
          point: normalizedPointSchema.optional(),
          visibleOnly: z.boolean().optional(),
          className: z.string().optional(),
        })
        .optional(),
      maxNodes: z.number().int().positive().max(5_000).optional(),
    }),
    result: jsonObjectSchema,
  },
  "probe.fullHierarchy": {
    params: z.object({
      maxDepth: z.number().int().positive().max(100).optional(),
      maxNodes: z.number().int().positive().max(5_000).optional(),
    }),
    result: jsonObjectSchema,
  },
  "health.get": { params: emptyParamsSchema, result: daemonHealthSchema },
  "server.shutdown": {
    params: emptyParamsSchema,
    result: z.object({ shuttingDown: z.literal(true) }),
  },
} as const;

export type SimViewMethodMap = typeof methodSchemas;
export type Method = keyof SimViewMethodMap;
export type ParamsFor<M extends Method> = z.input<SimViewMethodMap[M]["params"]>;
export type ResultFor<M extends Method> = z.output<SimViewMethodMap[M]["result"]>;

export const protocolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: jsonValueSchema.optional(),
  recoverable: z.boolean(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;

export const protocolResponseSchema = z
  .object({
    id: z.string(),
    result: jsonValueSchema.optional(),
    error: protocolErrorSchema.optional(),
  })
  .refine((response) => response.result !== undefined || response.error !== undefined, {
    message: "A protocol response requires a result or error",
  });

export interface ProtocolRequest<M extends Method = Method> {
  id: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  method: M;
  params: ParamsFor<M>;
}

export type ProtocolResponse = z.infer<typeof protocolResponseSchema>;

export function parseMethodParams<M extends Method>(method: M, value: unknown): ParamsFor<M> {
  return methodSchemas[method].params.parse(value) as ParamsFor<M>;
}

export function parseMethodResult<M extends Method>(method: M, value: unknown): ResultFor<M> {
  return methodSchemas[method].result.parse(value) as ResultFor<M>;
}
