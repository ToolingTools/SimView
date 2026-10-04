import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { processSnapshot, readHandshake, startupLock } from "@simview/client";
import {
  mcpConnectionContextSchema,
  type PreviewServerOptions,
  type PreviewServerStatus,
  previewServerOptionsSchema,
  previewServerStatusSchema,
  SIMVIEW_VERSION,
} from "@simview/contracts";
import { z } from "zod";
import { adapterConfiguration } from "../../mcp/src/adapter";
import { SimViewSession } from "../../mcp/src/session";
import {
  ensurePreviewRegistry,
  type PreviewRecord,
  previewPaths,
  previewRecordAlive,
  publishPreviewRecord,
  readPreviewRecord,
  removePreviewRecord,
  requestPreviewServer,
} from "./serve-registry";

const startupSchema = z.object({
  build: z.string().regex(/^[a-f0-9]{20}$/),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  options: previewServerOptionsSchema,
  context: mcpConnectionContextSchema,
});
type Startup = z.output<typeof startupSchema>;
const helloSchema = z.object({
  action: z.enum(["connect", "status", "stop"]),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

async function liveRecord(name: string): Promise<PreviewRecord | undefined> {
  const record = await readPreviewRecord(name);
  if (!record || (await previewRecordAlive(record))) return record;
  // A stale record never authorizes a signal to a possibly reused PID.
  await removePreviewRecord(record);
  return undefined;
}
async function configuration(options: PreviewServerOptions): Promise<Startup> {
  const { identity, context } = await adapterConfiguration();
  return { build: identity, context, token: randomBytes(32).toString("hex"), options };
}

export async function startPreviewDaemon(options: PreviewServerOptions) {
  await ensurePreviewRegistry(options.name);
  const paths = previewPaths(options.name);
  const release = await startupLock(paths.identity, new AbortController().signal, paths.lock);
  let child: Bun.Subprocess | undefined;
  let ready = false;
  try {
    const startup = await configuration(options);
    const existing = await liveRecord(options.name);
    if (existing) {
      if (existing.build !== startup.build)
        throw new Error(
          "The preview server runs a different build. Stop it before starting this build.",
        );
      if (JSON.stringify(existing.options) !== JSON.stringify(options))
        throw new Error("Stop the preview server before changing its network, host, or port.");
      return await requestPreviewServer(existing, "connect");
    }
    const compiled = import.meta.path.startsWith("/$bunfs/");
    const command = compiled
      ? [process.execPath, "serve", "--daemon"]
      : [process.execPath, new URL("./index.ts", import.meta.url).pathname, "serve", "--daemon"];
    child = Bun.spawn(command, {
      stdin: new TextEncoder().encode(JSON.stringify(startup)),
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const record = await readPreviewRecord(options.name);
      if (record) {
        try {
          const result = await requestPreviewServer(record, "connect");
          ready = true;
          return result;
        } catch {
          /* Publication precedes control socket binding. */
        }
      }
      if (child.exitCode !== null)
        throw new Error(
          "The preview server exited during startup. Check the selected address and port.",
        );
      await Bun.sleep(25);
    }
    throw new Error("Preview server startup timed out");
  } finally {
    if (child && !ready && child.exitCode === null) {
      // This is our unreleased startup child, not a PID read from a registry.
      child.kill();
      await Promise.race([child.exited, Bun.sleep(2_000)]);
      if (child.exitCode === null) {
        child.kill(9);
        await child.exited;
      }
    }
    await release();
  }
}

export async function previewDaemonCommand(name: string, action: "status" | "connect" | "stop") {
  await ensurePreviewRegistry(name);
  const paths = previewPaths(name);
  const release = await startupLock(paths.identity, new AbortController().signal, paths.lock);
  try {
    const record = await liveRecord(name);
    if (!record) {
      if (action === "connect")
        throw new Error("The preview server is not running. Use serve start first.");
      return previewServerStatusSchema.parse({ active: false, name });
    }
    const response = await requestPreviewServer(record, action);
    if (action === "stop") {
      const deadline = Date.now() + 7_000;
      while (await readPreviewRecord(name)) {
        if (Date.now() >= deadline) throw new Error("Preview server shutdown timed out");
        await Bun.sleep(25);
      }
    }
    return response;
  } finally {
    await release();
  }
}

/** Foreground mode is suitable for a user LaunchAgent; it never prints secret URLs. */
export async function runPreviewForeground(options: PreviewServerOptions): Promise<void> {
  await ensurePreviewRegistry(options.name);
  const paths = previewPaths(options.name);
  const release = await startupLock(paths.identity, new AbortController().signal, paths.lock);
  try {
    if (await liveRecord(options.name))
      throw new Error("The named preview server is already running");
    await runPreviewDaemon(await configuration(options), release);
  } finally {
    await release();
  }
}

export async function runPreviewDaemonFromStdin(): Promise<void> {
  try {
    await runPreviewDaemon(startupSchema.parse(await Bun.stdin.json()));
  } catch {
    throw new Error(
      "Preview daemon failed; check its configuration and private registry permissions",
    );
  }
}

async function runPreviewDaemon(startup: Startup, onReady?: () => Promise<void>): Promise<void> {
  const { options } = startup;
  await ensurePreviewRegistry(options.name);
  const startedAt = (await processSnapshot([process.pid])).get(process.pid)?.startedAt;
  if (!startedAt) throw new Error("Unable to identify the preview server");
  const record: PreviewRecord = {
    pid: process.pid,
    startedAt,
    build: startup.build,
    token: startup.token,
    options,
  };
  const paths = previewPaths(options.name);
  const session = new SimViewSession(startup.context, { onDiagnostic: () => {} });
  const sockets = new Set<Socket>();
  let published = false;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let connection: ReturnType<SimViewSession["startPreviewServer"]>;
  const status = (): PreviewServerStatus => ({
    active: true,
    name: options.name,
    network: options.network,
    host: connection.host,
    port: connection.port,
    pid: process.pid,
    version: SIMVIEW_VERSION,
    connected: session.state().connected,
    ...(session.device ? { deviceId: session.device.id } : {}),
  });
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      const deadline = setTimeout(() => process.exit(1), 5_000);
      server.close();
      for (const socket of sockets) socket.destroy();
      try {
        await session.close();
      } finally {
        if (published) await removePreviewRecord(record);
        clearTimeout(deadline);
        resolveDone();
      }
    })();
    return shutdownPromise;
  };
  const server = createServer((socket) => {
    if (closing || sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    void (async () => {
      const hello = helloSchema.parse(await readHandshake(socket));
      if (closing || !timingSafeEqual(Buffer.from(hello.token), Buffer.from(record.token)))
        throw new Error("Invalid preview authentication");
      if (hello.action === "stop") {
        socket.end(`${JSON.stringify({ active: false, name: options.name })}\n`, () => {
          void shutdown();
        });
      } else
        socket.end(
          `${JSON.stringify(hello.action === "connect" ? { ...status(), url: connection.url, notice: connection.notice } : status())}\n`,
        );
    })().catch(() => socket.destroy());
  });
  const signal = () => {
    void shutdown();
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  server.on("error", signal);
  try {
    connection = session.startPreviewServer(options);
    await publishPreviewRecord(record);
    published = true;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(paths.socket, 0o600);
    await onReady?.();
    await done;
  } finally {
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    await shutdown();
  }
}
