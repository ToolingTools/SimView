import { mock } from "bun:test";
import { PassThrough } from "node:stream";

type Scenario = "handoff" | "owner-loss";

const scenario = (process.argv[2] ?? "handoff") as Scenario;
let snapshotCalls = 0;
let watcherStarts = 0;
let watcherStops = 0;
let watcherTicks = 0;
let ticksAtStop = 0;
let watcherStopsAtForwarding = 0;
let ticksAtForwarding = 0;
let forwarded = false;
let destroyed = false;
let acquireStarted = false;
let ownerExit: ((reason: "owner_exited") => void) | undefined;

const owners = [{ pid: 42, startedAt: "owner", kind: "agent" as const }];

mock.module("@simview/client", () => ({
  acquireMcpDaemon: async () => {
    acquireStarted = true;
    if (scenario === "owner-loss") {
      setTimeout(() => ownerExit?.("owner_exited"), 5);
      await Bun.sleep(30);
    } else {
      await Bun.sleep(30);
    }
    const socket = new PassThrough();
    const originalPipe = socket.pipe.bind(socket);
    socket.pipe = ((destination: NodeJS.WritableStream, options?: { end?: boolean }) => {
      forwarded = true;
      watcherStopsAtForwarding = watcherStops;
      ticksAtForwarding = watcherTicks;
      return originalPipe(destination, options);
    }) as typeof socket.pipe;
    const originalDestroy = socket.destroy.bind(socket);
    socket.destroy = ((error?: Error) => {
      destroyed = true;
      return originalDestroy(error);
    }) as typeof socket.destroy;
    if (scenario === "handoff") setTimeout(() => socket.destroy(), 20);
    return socket;
  },
  mcpBuildIdentity: async () => "0123456789abcdef0123",
  mcpDaemonStatuses: async () => [],
  processSnapshot: async () => {
    snapshotCalls += 1;
    return new Map([[42, { pid: 42, ppid: 1, startedAt: "owner", executable: "host" }]]);
  },
  selectProcessOwners: () => owners,
  watchProcessOwners: (_owners: typeof owners, onExit: (reason: "owner_exited") => void) => {
    watcherStarts += 1;
    ownerExit = onExit;
    const timer = setInterval(() => {
      watcherTicks += 1;
    }, 5);
    return () => {
      watcherStops += 1;
      ticksAtStop = watcherTicks;
      clearInterval(timer);
      ownerExit = undefined;
    };
  },
}));

mock.module("@simview/contracts", () => ({
  nativeEnvironmentKeys: [],
  SIMVIEW_VERSION: "test",
}));

mock.module("@simview/core", () => ({ resolveBinary: () => "/tmp/simview-core" }));

const { runAdapter } = await import("../../packages/mcp/src/adapter");

try {
  await runAdapter();
  // Give the watcher enough time to reveal an accidental post-handoff poll.
  await Bun.sleep(40);
  console.log(
    JSON.stringify({
      scenario,
      snapshotCalls,
      watcherStarts,
      watcherStops,
      watcherTicks,
      ticksAtStop,
      watcherStopsAtForwarding,
      ticksAtForwarding,
      acquireStarted,
      forwarded,
      destroyed,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
