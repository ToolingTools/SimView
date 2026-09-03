import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_DAEMON_PROTOCOL_VERSION, sessionStateSchema } from "@simview/contracts";
import {
  acquireMcpDaemon,
  connectMcpDaemon,
  ensureMcpRegistry,
  mcpBuildIdentity,
  mcpDaemonPaths,
  mcpDaemonStatuses,
  publishMcpRecord,
  readMcpRecord,
} from "../packages/client/src/mcp-daemon";
import {
  ownersAlive,
  parseProcessSnapshot,
  processSnapshot,
  selectProcessOwners,
} from "../packages/client/src/process-owner";
import { adapterConfiguration } from "../packages/mcp/src/adapter";

async function openClient(resourceVersion: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("packages/cli/src/index.ts"), "mcp"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      SIMVIEW_RESOURCE_VERSION: resourceVersion,
      TMPDIR: resourceVersion === "second-host" ? "/private/tmp" : (process.env.TMPDIR ?? "/tmp"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "daemon-test", version: "1" });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    await transport.close();
    throw error;
  }
}

async function eventually(check: () => Promise<boolean>, timeout = 7_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("Lifecycle condition did not settle before its deadline");
}

describe("MCP owner identity", () => {
  test("tracks the GUI ancestor even when an agent worker survives, and rejects reused PIDs", () => {
    const snapshot = parseProcessSnapshot(
      [
        "10 1 Thu Sep 3 09:00:00 2026 /Applications/Cursor.app/Contents/MacOS/Cursor",
        "20 10 Thu Sep 3 09:00:01 2026 cursor-agent",
        "30 20 Thu Sep 3 09:00:02 2026 simview",
      ].join("\n"),
    );
    const owners = selectProcessOwners(snapshot, 20);
    expect(owners.map(({ pid }) => pid)).toEqual([20, 10]);
    expect(ownersAlive(owners, snapshot)).toBe(true);
    snapshot.delete(10);
    expect(ownersAlive(owners, snapshot)).toBe(false);
    snapshot.set(10, { pid: 10, ppid: 1, startedAt: "new process", executable: "unrelated" });
    expect(ownersAlive(owners, snapshot)).toBe(false);
  });
});

describe("shared MCP service", () => {
  test("shares a daemon while isolating MCP IDs, resource versions and review state", async () => {
    const configuration = await adapterConfiguration();
    const [first, second] = await Promise.all([
      openClient("first-host"),
      openClient("second-host"),
    ]);
    try {
      const service = (await mcpDaemonStatuses()).find(
        ({ identity }) => identity === configuration.identity,
      );
      expect(service?.connections).toBe(2);
      const [one, two] = await Promise.all([
        first.client.listResources(),
        second.client.listResources(),
      ]);
      expect(one.resources[0]?.uri).toContain("/first-host/");
      expect(two.resources[0]?.uri).toContain("/second-host/");
      expect(one.resources[0]?.uri).not.toBe(two.resources[0]?.uri);
      const [templatesOne, templatesTwo] = await Promise.all([
        first.client.listResourceTemplates(),
        second.client.listResourceTemplates(),
      ]);
      expect(templatesOne.resourceTemplates[0]?.uriTemplate).toContain("/first-host/");
      expect(templatesTwo.resourceTemplates[0]?.uriTemplate).toContain("/second-host/");
      expect(templatesOne.resourceTemplates[0]?.uriTemplate).not.toBe(
        templatesTwo.resourceTemplates[0]?.uriTemplate,
      );
      const [stateOne, stateTwo] = await Promise.all([
        first.client.callTool({ name: "get_simview_state", arguments: {} }),
        second.client.callTool({ name: "get_simview_state", arguments: {} }),
      ]);
      expect(sessionStateSchema.parse(stateOne.structuredContent).reviewId).not.toBe(
        sessionStateSchema.parse(stateTwo.structuredContent).reviewId,
      );
      await first.client.close();
      await eventually(
        async () =>
          (await mcpDaemonStatuses()).find(({ identity }) => identity === configuration.identity)
            ?.connections === 1,
      );
      expect(
        (await second.client.listTools()).tools.some(({ name }) => name === "app_open_browser"),
      ).toBe(true);
      const record = await readMcpRecord(configuration.identity);
      expect(record).toBeDefined();
      expect(JSON.stringify(service)).not.toContain(record?.token ?? "unexpected");
    } finally {
      await Promise.allSettled([first.client.close(), second.client.close()]);
    }
    await eventually(async () => (await readMcpRecord(configuration.identity)) === undefined);
  }, 25_000);

  test("rejects malformed authentication without ending another review", async () => {
    const configuration = await adapterConfiguration();
    const { client } = await openClient("auth-host");
    try {
      const record = await readMcpRecord(configuration.identity);
      if (!record) throw new Error("Missing service record");
      await expect(
        connectMcpDaemon(record, {
          kind: "status",
          protocolVersion: MCP_DAEMON_PROTOCOL_VERSION,
          identity: record.identity,
          token: randomBytes(32).toString("hex"),
        }),
      ).rejects.toThrow();
      const socket = createConnection(mcpDaemonPaths(record.identity).socket);
      socket.on("error", () => {});
      const closed = new Promise<void>((resolveClosed) =>
        socket.once("close", () => resolveClosed()),
      );
      socket.write("x".repeat(20_000));
      await closed;
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
    await eventually(async () => (await readMcpRecord(configuration.identity)) === undefined);
  }, 20_000);

  test("releases a review when its owner exits even with the forwarding socket still open", async () => {
    const configuration = await adapterConfiguration();
    const { client } = await openClient("owner-host");
    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let socket: Awaited<ReturnType<typeof connectMcpDaemon>>["socket"] | undefined;
    try {
      const record = await readMcpRecord(configuration.identity);
      const identity = (await processSnapshot([owner.pid])).get(owner.pid);
      if (!record || !identity) throw new Error("Missing test process identity");
      socket = (
        await connectMcpDaemon(record, {
          kind: "attach",
          protocolVersion: MCP_DAEMON_PROTOCOL_VERSION,
          token: record.token,
          identity: record.identity,
          context: configuration.context,
          owners: [{ pid: owner.pid, startedAt: identity.startedAt, kind: "application" }],
        })
      ).socket;
      socket.on("error", () => {});
      socket.resume();
      const closed = new Promise<void>((resolveClosed) =>
        socket?.once("close", () => resolveClosed()),
      );
      owner.kill(9);
      await owner.exited;
      await Promise.race([
        closed,
        Bun.sleep(4_000).then(() => {
          throw new Error("Owner loss did not close the socket");
        }),
      ]);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      socket?.destroy();
      if (owner.exitCode === null) owner.kill(9);
      await owner.exited;
      await client.close();
    }
    await eventually(async () => (await readMcpRecord(configuration.identity)) === undefined);
  }, 20_000);
});

describe("MCP startup and shutdown coordination", () => {
  test("serializes concurrent launchers across repeated final-disconnect restarts", async () => {
    const configuration = await adapterConfiguration();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) => openClient(`contender-${cycle}-${index}`)),
      );
      const clients = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.client] : [],
      );
      try {
        expect(results.filter((result) => result.status === "rejected")).toEqual([]);
        const services = (await mcpDaemonStatuses()).filter(
          ({ identity }) => identity === configuration.identity,
        );
        expect(services).toHaveLength(1);
        expect(services[0]?.connections).toBe(8);
        await Promise.all(clients.map((client) => client.listTools()));
      } finally {
        await Promise.allSettled(clients.map((client) => client.close()));
      }
      await eventually(async () => (await readMcpRecord(configuration.identity)) === undefined);
    }
  }, 30_000);

  test("recovers stale records and keeps incompatible build identities separate", async () => {
    const configuration = await adapterConfiguration();
    const own = (await processSnapshot([process.pid])).get(process.pid);
    if (!own) throw new Error("Missing test owner");
    const owners = [{ pid: process.pid, startedAt: own.startedAt, kind: "agent" as const }];
    const identities = [randomBytes(10).toString("hex"), randomBytes(10).toString("hex")] as const;
    await ensureMcpRegistry();
    await publishMcpRecord({
      pid: process.pid,
      startedAt: "a different birth time",
      identity: identities[0],
      version: "0.0.0",
      token: randomBytes(32).toString("hex"),
    });
    await writeFile(
      mcpDaemonPaths(identities[0]).lock,
      JSON.stringify({ pid: process.pid, startedAt: "stale" }),
      { mode: 0o600 },
    );
    const sockets = await Promise.all(
      identities.map((identity) =>
        acquireMcpDaemon({
          ...configuration,
          identity,
          owners,
          signal: new AbortController().signal,
        }),
      ),
    );
    try {
      const records = await Promise.all(identities.map(readMcpRecord));
      expect(records[0]?.pid).not.toBe(records[1]?.pid);
      expect(await mcpBuildIdentity([resolve("package.json")])).toBe(
        await mcpBuildIdentity([resolve("./package.json")]),
      );
    } finally {
      for (const socket of sockets) socket.destroy();
    }
    await eventually(async () =>
      (await Promise.all(identities.map(readMcpRecord))).every((record) => !record),
    );
  }, 20_000);

  test("bounds cleanup even when a session close never resolves", async () => {
    const configuration = await adapterConfiguration();
    const own = (await processSnapshot([process.pid])).get(process.pid);
    if (!own) throw new Error("Missing test owner");
    const identity = randomBytes(10).toString("hex");
    const command = [
      process.execPath,
      "-e",
      `import { SimViewSession } from ${JSON.stringify(resolve("packages/mcp/src/session.ts"))}; import { runMcpDaemon } from ${JSON.stringify(resolve("packages/mcp/src/daemon.ts"))}; SimViewSession.prototype.close = () => new Promise(() => {}); await runMcpDaemon();`,
    ];
    const socket = await acquireMcpDaemon({
      ...configuration,
      command,
      identity,
      owners: [{ pid: process.pid, startedAt: own.startedAt, kind: "agent" }],
      signal: new AbortController().signal,
    });
    const record = await readMcpRecord(identity);
    if (!record) throw new Error("Missing daemon");
    const start = Date.now();
    socket.destroy();
    await eventually(async () => !(await processSnapshot([record.pid])).has(record.pid), 6_000);
    expect(Date.now() - start).toBeLessThan(6_000);
    // The next adapter must recover the record left by forced cleanup.
    const next = await acquireMcpDaemon({
      ...configuration,
      identity,
      owners: [{ pid: process.pid, startedAt: own.startedAt, kind: "agent" }],
      signal: new AbortController().signal,
    });
    next.destroy();
    await eventually(async () => !(await readMcpRecord(identity)));
  }, 20_000);
});

test("cancels a detached startup before releasing the launcher lock", async () => {
  const configuration = await adapterConfiguration();
  const own = (await processSnapshot([process.pid])).get(process.pid);
  if (!own) throw new Error("Missing test owner");
  const identity = randomBytes(10).toString("hex");
  await ensureMcpRegistry();
  const marker = `${mcpDaemonPaths(identity).record}.test-pid`;
  const controller = new AbortController();
  const command = [
    process.execPath,
    "-e",
    `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
  ];
  const result = acquireMcpDaemon({
    ...configuration,
    command,
    identity,
    owners: [{ pid: process.pid, startedAt: own.startedAt, kind: "agent" }],
    signal: controller.signal,
  }).catch((error: unknown) => error);
  try {
    await eventually(async () => Bun.file(marker).exists());
    const childPID = Number(await Bun.file(marker).text());
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect((await processSnapshot([childPID])).has(childPID)).toBe(false);
    expect(await Bun.file(mcpDaemonPaths(identity).lock).exists()).toBe(false);
  } finally {
    controller.abort();
    await result;
    await Bun.file(marker).delete();
  }
}, 15_000);

test("does not quote credentials from a malformed registry record", async () => {
  await ensureMcpRegistry();
  const identity = randomBytes(10).toString("hex");
  const path = mcpDaemonPaths(identity).record;
  const secret = randomBytes(32).toString("hex");
  await writeFile(path, `{"token": "${secret}"} invalid`, { mode: 0o600 });
  try {
    const failure = await readMcpRecord(identity).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
  } finally {
    await Bun.file(path).delete();
  }
});

test("does not replace a live MCP daemon record during duplicate publication", async () => {
  await ensureMcpRegistry();
  const identity = randomBytes(10).toString("hex");
  const first = {
    pid: process.pid,
    startedAt: "first",
    identity,
    version: "0.4.1",
    token: randomBytes(32).toString("hex"),
  };
  const duplicate = {
    ...first,
    startedAt: "duplicate",
    token: randomBytes(32).toString("hex"),
  };
  try {
    await publishMcpRecord(first);
    await expect(publishMcpRecord(duplicate)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readMcpRecord(identity)).toEqual(first);
  } finally {
    await Bun.file(mcpDaemonPaths(identity).record).delete();
  }
});
