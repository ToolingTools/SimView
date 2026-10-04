import { z } from "zod";
import { annotationContextSchema, annotationGeometrySchema } from "./annotation";
import { methodSchemas } from "./protocol";

export const relayAuthenticationSchema = z.object({
  type: z.literal("authenticate"),
  token: z.string().min(32),
});

export const relayInputSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("input.touch"), params: methodSchemas["input.touch"].params }),
  z.object({ method: z.literal("input.tap"), params: methodSchemas["input.tap"].params }),
  z.object({
    method: z.literal("input.longPress"),
    params: methodSchemas["input.longPress"].params,
  }),
  z.object({ method: z.literal("input.swipe"), params: methodSchemas["input.swipe"].params }),
  z.object({ method: z.literal("input.gesture"), params: methodSchemas["input.gesture"].params }),
  z.object({ method: z.literal("input.typeText"), params: methodSchemas["input.typeText"].params }),
  z.object({ method: z.literal("input.key"), params: methodSchemas["input.key"].params }),
  z.object({ method: z.literal("input.button"), params: methodSchemas["input.button"].params }),
]);

export const annotationMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    frameId: z.string().optional(),
    geometry: annotationGeometrySchema,
    note: z.string().trim().min(1),
    context: annotationContextSchema.optional(),
  }),
  z
    .object({
      action: z.literal("update"),
      id: z.string().uuid(),
      geometry: annotationGeometrySchema.optional(),
      note: z.string().trim().min(1).optional(),
    })
    .refine((value) => value.geometry !== undefined || value.note !== undefined, {
      message: "An annotation update requires geometry or note",
    }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
]);

export const LAN_SHARING_NOTICE =
  "Anyone with this link can control the device. HTTP traffic is unencrypted; share only on a trusted LAN.";

export const TAILSCALE_SHARING_NOTICE =
  "Anyone with this link and tailnet access can control the device. Tailscale encrypts the connection; keep the link private.";

export const lanSharingInputSchema = z.object({
  network: z.enum(["lan", "tailscale"]).optional(),
  host: z.ipv4().optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

export const lanSharingStatusSchema = z.discriminatedUnion("active", [
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    network: z.enum(["lan", "tailscale"]).optional(),
    host: z.ipv4(),
    port: z.number().int().min(1).max(65535),
    transport: z.literal("http"),
    codec: z.literal("mjpeg"),
    access: z.literal("interactive"),
  }),
]);

export const lanSharingStartedSchema = z.object({
  active: z.literal(true),
  network: z.enum(["lan", "tailscale"]).optional(),
  host: z.ipv4(),
  port: z.number().int().min(1).max(65535),
  transport: z.literal("http"),
  codec: z.literal("mjpeg"),
  access: z.literal("interactive"),
  url: z.url(),
  notice: z.string(),
});

export type LanSharingInput = z.infer<typeof lanSharingInputSchema>;
export type LanSharingStatus = z.infer<typeof lanSharingStatusSchema>;
export type LanSharingStarted = z.infer<typeof lanSharingStartedSchema>;
