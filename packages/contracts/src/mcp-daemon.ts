import { z } from "zod";

export const MCP_DAEMON_PROTOCOL_VERSION = 1;
export const processOwnerSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  kind: z.enum(["agent", "application"]),
});
export type ProcessOwner = z.output<typeof processOwnerSchema>;

export const nativeEnvironmentKeys = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "PATH",
  "LANG",
  "DEVELOPER_DIR",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "SIMVIEW_ADB_PATH",
  "SIMVIEW_ANDROID_AGENT_PATH",
  "SIMVIEW_PROBE_DYLIB",
  "SIMVIEW_XCTEST_PROVIDER_XCTESTRUN",
  "SIMVIEW_BOUNDED_ANDROID_OBSERVATION_DECODER",
] as const;
export const nativeEnvironmentSchema = z.partialRecord(z.enum(nativeEnvironmentKeys), z.string());

export const mcpConnectionContextSchema = z.object({
  nativeEnvironment: nativeEnvironmentSchema,
  cwd: z.string().min(1),
  projectRoot: z.string().min(1),
  appRoot: z.string().min(1),
  coreBinary: z.string().min(1),
  backendMode: z.enum(["shared", "ephemeral"]),
  claudeDesktop: z.boolean(),
  resourceVersion: z.string().min(1),
});
export type McpConnectionContext = z.output<typeof mcpConnectionContextSchema>;

export const mcpDaemonHelloSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attach"),
    protocolVersion: z.literal(MCP_DAEMON_PROTOCOL_VERSION),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    identity: z.string().regex(/^[a-f0-9]{20}$/),
    owners: z.array(processOwnerSchema).min(1).max(32),
    context: mcpConnectionContextSchema,
  }),
  z.object({
    kind: z.literal("status"),
    protocolVersion: z.literal(MCP_DAEMON_PROTOCOL_VERSION),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    identity: z.string().regex(/^[a-f0-9]{20}$/),
  }),
]);
export type McpDaemonHello = z.output<typeof mcpDaemonHelloSchema>;

export const mcpDaemonStatusSchema = z.object({
  pid: z.number().int().positive(),
  identity: z.string().regex(/^[a-f0-9]{20}$/),
  version: z.string(),
  connections: z.number().int().nonnegative(),
  owners: z.number().int().nonnegative(),
});
export type McpDaemonStatus = z.output<typeof mcpDaemonStatusSchema>;
