import { timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer as createSocketServer, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  ensureMcpRegistry,
  MCP_SHUTDOWN_TIMEOUT_MS,
  MCP_STARTUP_TIMEOUT_MS,
  type McpDaemonRecord,
  mcpDaemonPaths,
  ownersAlive,
  processSnapshot,
  publishMcpRecord,
  readHandshake,
  removeMcpRecord,
  watchProcessOwners,
} from "@simview/client";
import {
  type McpDaemonStatus,
  mcpDaemonHelloSchema,
  type ProcessOwner,
  SIMVIEW_VERSION,
} from "@simview/contracts";
import { z } from "zod";
import { type DiagnosticReason, daemonDiagnostic } from "./diagnostics";
import { createServer } from "./server";
import { SimViewSession } from "./session";

export async function runMcpDaemon(): Promise<void> {
  const startup = z
    .object({
      identity: z.string().regex(/^[a-f0-9]{20}$/),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(await Bun.stdin.json());
  await ensureMcpRegistry();
  const startedAt = (await processSnapshot([process.pid])).get(process.pid)?.startedAt;
  if (!startedAt) throw new Error("Unable to identify the MCP daemon");
  const record: McpDaemonRecord = {
    ...startup,
    pid: process.pid,
    startedAt,
    version: SIMVIEW_VERSION,
  };
  const paths = mcpDaemonPaths(record.identity);
  const diagnostic = (reason: DiagnosticReason, error?: unknown) =>
    daemonDiagnostic(`${paths.record}.diagnostics.log`, reason, error);
  const sockets = new Set<Socket>();
  const connections = new Map<Socket, { owners: ProcessOwner[]; close: () => Promise<void> }>();
  const closing = new Set<Promise<void>>();
  let draining = false;
  let served = false;
  const status = (): McpDaemonStatus => ({
    pid: process.pid,
    identity: record.identity,
    version: SIMVIEW_VERSION,
    connections: connections.size,
    owners: new Set(
      [...connections.values()].flatMap(({ owners }) =>
        owners.map(({ pid, startedAt }) => `${pid}:${startedAt}`),
      ),
    ).size,
  });
  const shutdown = (reason: DiagnosticReason, error?: unknown) => {
    if (draining) return;
    draining = true;
    diagnostic(reason, error);
    clearTimeout(startupTimeout);
    server.close();
    const deadline = setTimeout(() => {
      diagnostic("shutdown_timeout");
      process.exit(1);
    }, MCP_SHUTDOWN_TIMEOUT_MS);
    for (const socket of sockets) socket.destroy();
    void (async () => {
      await Promise.allSettled([...connections.values()].map((entry) => entry.close()));
      await Promise.allSettled([...closing]);
      await removeMcpRecord(record);
      clearTimeout(deadline);
      process.exit(0);
    })();
  };
  const server = createSocketServer((socket) => {
    if (draining || sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", (error) => {
      diagnostic("socket_error", error);
      socket.destroy();
    });
    socket.once("close", () => sockets.delete(socket));
    void (async () => {
      const hello = mcpDaemonHelloSchema.parse(await readHandshake(socket));
      if (
        draining ||
        hello.identity !== record.identity ||
        !timingSafeEqual(Buffer.from(hello.token), Buffer.from(record.token))
      )
        throw new Error("Invalid MCP daemon authentication");
      if (hello.kind === "status") {
        socket.end(`${JSON.stringify(status())}\n`);
        return;
      }
      if (
        !Object.values({
          cwd: hello.context.cwd,
          projectRoot: hello.context.projectRoot,
          appRoot: hello.context.appRoot,
          coreBinary: hello.context.coreBinary,
        }).every(isAbsolute)
      )
        throw new Error("MCP context paths must be absolute");
      if (
        !ownersAlive(hello.owners, await processSnapshot(hello.owners.map(({ pid }) => pid))) ||
        socket.destroyed ||
        draining
      )
        throw new Error("MCP owner is no longer connected");
      const session = new SimViewSession(hello.context, { onDiagnostic: diagnostic });
      let handle: ReturnType<typeof serveStdio> | undefined;
      let closePromise: Promise<void> | undefined;
      let unwatch = () => {};
      const close = (reason: DiagnosticReason = "socket_close", error?: unknown): Promise<void> => {
        if (closePromise) return closePromise;
        diagnostic(reason, error);
        unwatch();
        connections.delete(socket);
        socket.destroy();
        closePromise = Promise.resolve().then(async () => {
          await Promise.allSettled([session.close(), handle?.close()]);
        });
        closing.add(closePromise);
        void closePromise.finally(() => closing.delete(closePromise as Promise<void>));
        if (served && connections.size === 0) shutdown("last_connection_closed");
        return closePromise;
      };
      connections.set(socket, { owners: hello.owners, close });
      served = true;
      clearTimeout(startupTimeout);
      socket.once("close", () => void close());
      socket.once("end", () => void close("socket_end"));
      unwatch = watchProcessOwners(hello.owners, (reason) => void close(reason), {
        onDiagnostic: diagnostic,
      });
      socket.write(`${JSON.stringify(status())}\n`);
      handle = serveStdio(
        () => {
          const mcp = createServer(session, {
            environment: {
              CLAUDE_CODE_ENTRYPOINT: hello.context.claudeDesktop ? "claude-desktop" : undefined,
            },
            deviceProvider: (signal) => session.devices(signal),
          });
          const originalClose = mcp.server.onclose;
          mcp.server.onclose = () => {
            originalClose?.();
            void close("protocol_close");
          };
          return mcp;
        },
        {
          transport: new StdioServerTransport(socket, socket),
          onerror: (error) => void close("protocol_error", error),
        },
      );
      socket.resume();
    })().catch((error) => {
      diagnostic("handshake_rejected", error);
      socket.destroy();
    });
  });
  const startupTimeout = setTimeout(() => shutdown("startup_timeout"), MCP_STARTUP_TIMEOUT_MS);
  process.once("SIGINT", () => shutdown("sigint"));
  process.once("SIGTERM", () => shutdown("sigterm"));
  server.on("error", (error) => shutdown("server_error", error));
  // Publish identity before binding so a crash cannot leave an unowned socket.
  await publishMcpRecord(record);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(paths.socket, 0o600);
}
