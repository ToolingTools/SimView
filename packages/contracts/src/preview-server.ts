import { z } from "zod";

export const previewServerNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const previewServerOptionsSchema = z.object({
  name: previewServerNameSchema.default("default"),
  network: z.enum(["loopback", "lan", "tailscale"]).default("loopback"),
  host: z.ipv4().optional(),
  port: z.number().int().min(0).max(65535).default(0),
});
export type PreviewServerOptions = z.output<typeof previewServerOptionsSchema>;
export const previewServerStatusSchema = z.discriminatedUnion("active", [
  z.object({ active: z.literal(false), name: previewServerNameSchema }),
  z.object({
    active: z.literal(true),
    name: previewServerNameSchema,
    network: z.enum(["loopback", "lan", "tailscale"]),
    host: z.ipv4(),
    port: z.number().int().min(1).max(65535),
    pid: z.number().int().positive(),
    version: z.string(),
    connected: z.boolean(),
    deviceId: z.string().optional(),
  }),
]);
export type PreviewServerStatus = z.output<typeof previewServerStatusSchema>;
export const previewServerConnectionSchema = previewServerStatusSchema.options[1].extend({
  url: z.url(),
  notice: z.string(),
});
export type PreviewServerConnection = z.output<typeof previewServerConnectionSchema>;
