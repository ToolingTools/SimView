import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  MCP_DAEMON_PROTOCOL_VERSION,
  type McpConnectionContext,
  type McpDaemonHello,
  type McpDaemonStatus,
  mcpDaemonStatusSchema,
  type ProcessOwner,
  SIMVIEW_VERSION,
} from "@simview/contracts";
import { z } from "zod";
import { processSnapshot } from "./process-owner";
import { userTemporaryDirectory } from "./runtime-directory";

export const MCP_STARTUP_TIMEOUT_MS = 10_000;
export const MCP_HANDSHAKE_LIMIT = 16 * 1024;
export const MCP_SHUTDOWN_TIMEOUT_MS = 5_000;

export const mcpDaemonRecordSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  identity: z.string().regex(/^[a-f0-9]{20}$/),
  version: z.string(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export type McpDaemonRecord = z.output<typeof mcpDaemonRecordSchema>;

export function mcpRegistryRoot(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("MCP daemons require a numeric user ID");
  return join(userTemporaryDirectory(), "sv-mcp", String(uid));
}

export function mcpDaemonPaths(identity: string) {
  if (!/^[a-f0-9]{20}$/.test(identity)) throw new Error("Invalid MCP daemon identity");
  const root = mcpRegistryRoot();
  return {
    record: join(root, `${identity}.json`),
    socket: join(root, `${identity}.sock`),
    lock: join(root, `${identity}.lock`),
  };
}

export async function assertPrivatePath(
  path: string,
  kind: "directory" | "file" | "socket",
): Promise<void> {
  const stat = await lstat(path);
  let valid: boolean;
  switch (kind) {
    case "directory":
      valid = stat.isDirectory();
      break;
    case "file":
      valid = stat.isFile();
      break;
    case "socket":
      valid = stat.isSocket();
      break;
  }
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  if (
    !valid ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== expectedMode
  ) {
    throw new Error("Unsafe MCP daemon filesystem permissions or ownership");
  }
}

export async function ensureMcpRegistry(): Promise<void> {
  for (const path of [join(userTemporaryDirectory(), "sv-mcp"), mcpRegistryRoot()]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertPrivatePath(path, "directory");
  }
}

export async function readMcpRecord(identity: string): Promise<McpDaemonRecord | undefined> {
  const path = mcpDaemonPaths(identity).record;
  try {
    await assertPrivatePath(path, "file");
    const result = mcpDaemonRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!result.success || result.data.identity !== identity)
      throw new Error("Invalid MCP daemon record");
    return result.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // JSON parser diagnostics can quote registry contents, including the token.
    if (error instanceof SyntaxError) throw new Error("Invalid MCP daemon record");
    throw error;
  }
}

export async function mcpRecordAlive(record: McpDaemonRecord): Promise<boolean> {
  return (await processSnapshot([record.pid])).get(record.pid)?.startedAt === record.startedAt;
}

export async function publishMcpRecord(record: McpDaemonRecord): Promise<void> {
  const path = mcpDaemonPaths(record.identity).record;
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  try {
    // link() publishes atomically without replacing a live daemon's record.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function removeMcpRecord(record: McpDaemonRecord): Promise<void> {
  const current = await readMcpRecord(record.identity);
  if (current?.pid !== record.pid || current.token !== record.token) return;
  const paths = mcpDaemonPaths(record.identity);
  await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await unlink(paths.record).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** Reads the private preamble only. Remaining bytes belong to MCP and stay on the socket. */
export function readHandshake(socket: Socket, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error, value?: unknown) => {
      socket.pause();
      clearTimeout(timeout);
      socket.off("data", data);
      socket.off("error", failed);
      socket.off("close", closed);
      socket.off("end", closed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(value);
    };
    const failed = () => finish(new Error("MCP daemon handshake failed"));
    const closed = () => finish(new Error("MCP daemon disconnected during handshake"));
    const aborted = () => finish(new Error("MCP daemon connection cancelled"));
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if ((end < 0 ? buffer.length : end) > MCP_HANDSHAKE_LIMIT) {
        failed();
        return;
      }
      if (end < 0) return;
      try {
        const value: unknown = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        const rest = buffer.subarray(end + 1);
        socket.pause();
        if (rest.length) socket.unshift(rest);
        finish(undefined, value);
      } catch {
        failed();
      }
    };
    const timeout = setTimeout(failed, 2_000);
    socket.on("data", data);
    socket.once("error", failed);
    socket.once("close", closed);
    socket.once("end", closed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else socket.resume();
  });
}

export async function connectMcpDaemon(
  record: McpDaemonRecord,
  hello: McpDaemonHello,
  signal?: AbortSignal,
): Promise<{ socket: Socket; status: McpDaemonStatus }> {
  const path = mcpDaemonPaths(record.identity).socket;
  await assertPrivatePath(path, "socket");
  const socket = createConnection({ path });
  // The handshake listener owns errors while connecting; callers own them after it resolves.
  const response = readHandshake(socket, signal);
  socket.write(`${JSON.stringify(hello)}\n`);
  try {
    const status = mcpDaemonStatusSchema.parse(await response);
    if (status.pid !== record.pid || status.identity !== record.identity)
      throw new Error("MCP daemon identity mismatch");
    return { socket, status };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function startupLock(identity: string, signal: AbortSignal): Promise<() => Promise<void>> {
  const path = mcpDaemonPaths(identity).lock;
  const startedAt = (await processSnapshot([process.pid])).get(process.pid)?.startedAt;
  if (!startedAt) throw new Error("Unable to identify the MCP launcher");
  const contents = JSON.stringify({
    pid: process.pid,
    startedAt,
    claim: randomBytes(16).toString("hex"),
  });
  const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(contents);
      } finally {
        await file.close();
      }
      return async () => {
        if ((await readFile(path, "utf8").catch(() => "")) === contents)
          await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let text: string;
      try {
        await assertPrivatePath(path, "file");
        text = await readFile(path, "utf8");
      } catch (lockError) {
        // Another launcher can release the lock between open, lstat and read.
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockError;
      }
      try {
        const owner = z
          .object({ pid: z.number().int().positive(), startedAt: z.string() })
          .parse(JSON.parse(text));
        if (
          (await processSnapshot([owner.pid])).get(owner.pid)?.startedAt !== owner.startedAt &&
          (await readFile(path, "utf8")) === text
        ) {
          await unlink(path).catch(() => {});
        }
      } catch {
        /* A starter may still be writing its lock. */
      }
      await Bun.sleep(25);
    }
  }
  throw new Error(signal.aborted ? "MCP connection cancelled" : "MCP daemon startup timed out");
}

export async function acquireMcpDaemon(options: {
  command: string[];
  identity: string;
  context: McpConnectionContext;
  owners: ProcessOwner[];
  signal: AbortSignal;
}): Promise<Socket> {
  await ensureMcpRegistry();
  const release = await startupLock(options.identity, options.signal);
  const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
  let child: Bun.Subprocess | undefined;
  let attached = false;
  try {
    while (!options.signal.aborted && Date.now() < deadline) {
      let record = await readMcpRecord(options.identity);
      if (record && !(await mcpRecordAlive(record))) {
        await removeMcpRecord(record);
        record = undefined;
      }
      if (!record && !child) {
        const token = randomBytes(32).toString("hex");
        child = Bun.spawn(options.command, {
          stdin: new TextEncoder().encode(JSON.stringify({ identity: options.identity, token })),
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        });
        child.unref();
      }
      if (record) {
        try {
          const connection = await connectMcpDaemon(
            record,
            {
              kind: "attach",
              token: record.token,
              identity: record.identity,
              protocolVersion: MCP_DAEMON_PROTOCOL_VERSION,
              context: options.context,
              owners: options.owners,
            },
            options.signal,
          );
          attached = true;
          return connection.socket;
        } catch {
          /* A draining daemon can still have a live PID. Wait for its record to disappear. */
        }
      }
      if (child && child.exitCode !== null) throw new Error("The MCP daemon exited during startup");
      await Bun.sleep(25);
    }
    throw new Error(
      options.signal.aborted
        ? "MCP connection cancelled"
        : "Unable to start or attach to the MCP daemon",
    );
  } finally {
    // Other starters cannot join until this lock is released. Reap an abandoned
    // startup now rather than leaving a detached child for its startup timeout.
    if (child && !attached && child.exitCode === null) {
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

export async function mcpDaemonStatuses(): Promise<McpDaemonStatus[]> {
  const root = mcpRegistryRoot();
  try {
    await assertPrivatePath(join(userTemporaryDirectory(), "sv-mcp"), "directory");
    await assertPrivatePath(root, "directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: McpDaemonStatus[] = [];
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9]{20}\.json$/.test(name)) continue;
    const record = await readMcpRecord(name.slice(0, -5));
    if (!record || !(await mcpRecordAlive(record))) continue;
    try {
      const { socket, status } = await connectMcpDaemon(record, {
        kind: "status",
        protocolVersion: MCP_DAEMON_PROTOCOL_VERSION,
        token: record.token,
        identity: record.identity,
      });
      socket.destroy();
      result.push(status);
    } catch {
      /* A service may be draining while status is sampled. */
    }
  }
  return result;
}

export async function mcpBuildIdentity(files: string[]): Promise<string> {
  const hash = createHash("sha256").update(`${SIMVIEW_VERSION}\0${MCP_DAEMON_PROTOCOL_VERSION}\0`);
  for (const path of files) {
    const bytes = await readFile(path);
    hash.update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex").slice(0, 20);
}
