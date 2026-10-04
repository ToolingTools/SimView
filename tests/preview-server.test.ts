import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { SimViewClient } from "@simview/client";
import {
  parseDeviceDescription,
  previewServerConnectionSchema,
  previewServerOptionsSchema,
} from "@simview/contracts";
import { previewDaemonCommand } from "../packages/cli/src/serve";
import {
  previewPaths,
  publishPreviewRecord,
  readPreviewRecord,
  requestPreviewServer,
} from "../packages/cli/src/serve-registry";
import { SimViewSession } from "../packages/mcp/src/session";

const names = new Set<string>();
afterEach(async () => {
  await Promise.allSettled([...names].map((name) => previewDaemonCommand(name, "stop")));
  names.clear();
});
function name() {
  const value = `test-${randomUUID()}`;
  names.add(value);
  return value;
}
async function cli(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, resolve("packages/cli/src/index.ts"), "serve", ...args],
    {
      env: { ...process.env, SIMVIEW_CORE_BINARY: resolve("tests/fixtures/fake-simview-core.ts") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Preview CLI failed: ${stderr}`);
  return JSON.parse(stdout) as unknown;
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("Preview lifecycle did not settle");
}

test("detached servers are idle, authenticated, reused concurrently, private, and revocable", async () => {
  const serverName = name();
  const starts = await Promise.all([
    cli(["start", "--name", serverName, "--json"]),
    cli(["start", "--name", serverName, "--json"]),
  ]);
  const connection = previewServerConnectionSchema.parse(starts[0]);
  const second = previewServerConnectionSchema.parse(starts[1]);
  expect(connection.connected).toBe(false);
  expect(connection.pid).toBe(second.pid);
  expect(connection.url === second.url).toBe(true);
  const url = new URL(connection.url);
  const token = url.hash.slice(7);
  const headers = { authorization: `Bearer ${token}` };
  expect((await fetch(`${url.origin}/state`)).status).toBe(401);
  expect((await fetch(`${url.origin}/devices`)).status).toBe(401);
  expect(
    (await fetch(`${url.origin}/state`, { headers: { ...headers, origin: "http://evil.example" } }))
      .status,
  ).toBe(403);
  const state = await fetch(`${url.origin}/state`, { headers }).then((response) => response.json());
  expect(state.connected).toBe(false);
  expect(state.device).toBeUndefined();
  // The fixture refuses device discovery/start, proving startup/state do not acquire a backend.
  expect((await fetch(`${url.origin}/devices`, { headers })).status).toBe(500);
  const status = JSON.stringify(await cli(["status", "--name", serverName, "--json"]));
  expect(status.includes(token)).toBe(false);
  expect(status.includes("url")).toBe(false);
  const paths = previewPaths(serverName);
  expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
  expect((await lstat(paths.record)).mode & 0o777).toBe(0o600);
  expect((await lstat(paths.socket)).mode & 0o777).toBe(0o600);
  const record = await readPreviewRecord(serverName);
  if (!record) throw new Error("Missing preview record");
  await expect(
    requestPreviewServer({ ...record, token: "0".repeat(64) }, "stop"),
  ).rejects.toThrow();
  expect((await previewDaemonCommand(serverName, "status")).active).toBe(true);
  const socket = new WebSocket(`${url.origin.replace(/^http/, "ws")}/stream?codec=mjpeg`);
  await new Promise<void>((resolveOpen, reject) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "authenticate", token }));
      resolveOpen();
    };
    socket.onerror = () => reject(new Error("Idle websocket failed"));
  });
  await Bun.sleep(100);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  socket.close();
  await cli(["stop", "--name", serverName, "--json"]);
  expect(await readPreviewRecord(serverName)).toBeUndefined();
  const fresh = previewServerConnectionSchema.parse(
    await cli(["start", "--name", serverName, "--port", String(connection.port), "--json"]),
  );
  expect(fresh.url === connection.url).toBe(false);
  expect((await fetch(`${url.origin}/state`, { headers })).status).toBe(401);
}, 20_000);

test("foreground service logs contain no capability and survive an idle viewer", async () => {
  const serverName = name();
  const child = Bun.spawn(
    [process.execPath, resolve("packages/cli/src/index.ts"), "serve", "run", "--name", serverName],
    {
      env: { ...process.env, SIMVIEW_CORE_BINARY: resolve("tests/fixtures/fake-simview-core.ts") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    await eventually(async () => (await previewDaemonCommand(serverName, "status")).active);
    const connection = previewServerConnectionSchema.parse(
      await cli(["connect", "--name", serverName, "--json"]),
    );
    expect(connection.connected).toBe(false);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await readPreviewRecord(serverName)).toBeUndefined();
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}, 15_000);

test("a reused PID record is removed without signalling the unrelated process", async () => {
  const serverName = name();
  await previewDaemonCommand(serverName, "status");
  await publishPreviewRecord({
    pid: process.pid,
    startedAt: "a different process start",
    build: "a".repeat(20),
    token: "b".repeat(64),
    options: previewServerOptionsSchema.parse({ name: serverName }),
  });
  expect(await previewDaemonCommand(serverName, "stop")).toEqual({
    active: false,
    name: serverName,
  });
  expect(await readPreviewRecord(serverName)).toBeUndefined();
});

test("unsafe registry files and invalid CLI options fail closed", async () => {
  const serverName = name();
  const connection = previewServerConnectionSchema.parse(
    await cli(["start", "--name", serverName, "--json"]),
  );
  const paths = previewPaths(serverName);
  await chmod(paths.record, 0o644);
  try {
    await expect(readPreviewRecord(serverName)).rejects.toThrow("permissions");
  } finally {
    await chmod(paths.record, 0o600);
  }
  expect(connection.connected).toBe(false);
  for (const args of [
    ["start", "--lan", "--tailscale"],
    ["start", "--port", "65536"],
    ["start", "--tailscale-host", "100.100.103.97"],
    ["status", "--tailscale"],
    ["start", "--name", "../escape"],
  ])
    await expect(cli(args)).rejects.toThrow();
}, 15_000);

test("idle relays attach only explicitly selected ready devices and recover the same device", async () => {
  const session = new SimViewSession(undefined, { onDiagnostic: () => {} });
  const device = parseDeviceDescription({
    udid: "IDLE-TEST",
    name: "Idle test",
    state: "Booted",
    runtime: "iOS",
  });
  const events: string[] = [];
  let disconnected = () => {};
  let connected = true;
  const acquire = spyOn(SimViewClient, "acquire").mockImplementation(
    async () =>
      ({
        get connected() {
          return connected;
        },
        on: () => () => {},
        onDisconnect: (handler: () => void) => {
          disconnected = handler;
          return () => {};
        },
        request: async (method: string, params: { enabled?: boolean }) => {
          events.push(method);
          if (method === "capture.start") return { device };
          if (method === "device.describe") return device;
          if (method === "capture.preview") {
            expect(params.enabled).toBe(false);
            return {};
          }
          throw new Error("Unavailable in fixture");
        },
        close: async () => {},
      }) as unknown as SimViewClient,
  );
  const discovery = spyOn(session, "devices").mockResolvedValue([device]);
  try {
    const connection = session.startPreviewServer({ network: "loopback" });
    expect(acquire).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(() => session.startLanSharing()).toThrow("connect_device");
    const url = new URL(connection.url);
    const headers = {
      authorization: `Bearer ${url.hash.slice(7)}`,
      "content-type": "application/json",
    };
    expect(
      (
        await fetch(`${url.origin}/device`, {
          method: "POST",
          body: JSON.stringify({ deviceId: "ios:IDLE-TEST" }),
        })
      ).status,
    ).toBe(401);
    // No viewer exists: attachment must never enable video demand.
    const request = async () =>
      fetch(`${url.origin}/device`, {
        method: "POST",
        headers,
        body: JSON.stringify({ deviceId: "ios:IDLE-TEST" }),
      });
    expect((await request()).status).toBe(200);
    expect(acquire).toHaveBeenCalledTimes(1);
    connected = false;
    disconnected();
    expect(
      (await fetch(`${url.origin}/state`, { headers }).then((response) => response.json()))
        .connected,
    ).toBe(false);
    connected = true;
    expect((await request()).status).toBe(200);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event === "capture.start")).toHaveLength(2);
  } finally {
    await session.close();
    discovery.mockRestore();
    acquire.mockRestore();
  }
});
