import { mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ownerPID = 2_000_001;
const ownerStartedAt = "held-launcher";
const snapshotPIDs: number[][] = [];
let retries = 0;
let spawnAttempts = 0;

mock.module(resolve("packages/client/src/process-owner.ts"), () => ({
  processSnapshot: async (pids?: number[]) => {
    snapshotPIDs.push(pids ? [...pids] : []);
    const requested = pids ?? [];
    return new Map(
      requested.map((pid) => [
        pid,
        {
          pid,
          ppid: 1,
          startedAt: pid === ownerPID ? ownerStartedAt : "launcher",
          executable: "test-launcher",
        },
      ]),
    );
  },
}));

const originalNow = Date.now;
const originalSleep = Bun.sleep;
const originalSpawn = Bun.spawn;
const fixedNow = 1_000_000;
Date.now = () => fixedNow;
(Bun as unknown as { sleep: (milliseconds: number) => Promise<void> }).sleep = async () => {
  retries += 1;
  if (retries >= 10) controller.abort();
};
(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((..._args: unknown[]) => {
  spawnAttempts += 1;
  throw new Error("MCP daemon must not launch while another startup lock is held");
}) as unknown as typeof Bun.spawn;

const controller = new AbortController();
const identity = randomBytes(10).toString("hex");

try {
  const { acquireMcpDaemon, ensureMcpRegistry, mcpDaemonPaths } = await import(
    "../../packages/client/src/mcp-daemon"
  );
  await ensureMcpRegistry();
  const paths = mcpDaemonPaths(identity);
  await writeFile(paths.lock, JSON.stringify({ pid: ownerPID, startedAt: ownerStartedAt }), {
    mode: 0o600,
    flag: "wx",
  });

  let error: unknown;
  try {
    await acquireMcpDaemon({
      command: ["must-not-launch"],
      identity,
      context: {
        nativeEnvironment: {},
        cwd: "/tmp",
        projectRoot: "/tmp",
        appRoot: "/tmp",
        coreBinary: "/tmp/simview-core",
        backendMode: "shared",
        claudeDesktop: false,
        resourceVersion: "test",
      },
      owners: [{ pid: ownerPID, startedAt: ownerStartedAt, kind: "agent" }],
      signal: controller.signal,
    });
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || !error.message.includes("MCP connection cancelled"))
    throw error ?? new Error("Expected startup lock acquisition to reject");

  console.log(
    JSON.stringify({
      retries,
      spawnAttempts,
      startupSnapshotCalls: snapshotPIDs.filter(([pid]) => pid === process.pid).length,
      ownerSnapshotCalls: snapshotPIDs.filter(([pid]) => pid === ownerPID).length,
      snapshotCalls: snapshotPIDs.length,
    }),
  );
} finally {
  Date.now = originalNow;
  (Bun as unknown as { sleep: typeof Bun.sleep }).sleep = originalSleep;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
  const { mcpDaemonPaths } = await import("../../packages/client/src/mcp-daemon");
  await unlink(mcpDaemonPaths(identity).lock).catch(() => {});
}
