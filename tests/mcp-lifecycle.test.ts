import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("MCP process lifecycle", () => {
  test("exits promptly when its stdio client closes stdin", async () => {
    const child = Bun.spawn([process.execPath, "packages/mcp/src/index.ts"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.end();
    // Include cold source-module startup while retaining the five-second shutdown bound.
    const exitCode = await Promise.race([child.exited, Bun.sleep(5_000).then(() => undefined)]);
    if (exitCode === undefined) child.kill();
    expect(exitCode).toBe(0);
    const diagnostic = JSON.parse((await new Response(child.stderr).text()).trim());
    expect(diagnostic.component).toBe("adapter");
    expect(["stdin_end", "stdin_close"]).toContain(diagnostic.reason);
  }, 7_000);

  test("shuts down cleanly on termination signals", async () => {
    const child = Bun.spawn([process.execPath, "packages/mcp/src/index.ts"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const deadline = setTimeout(() => child.kill(9), 8_000);
    try {
      // Test shutdown after the server is ready, independently of cold startup.
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "signal-test", version: "1" } } })}\n`,
      );
      expect((await reader.read()).done).toBe(false);
      child.kill("SIGTERM");
      const exitCode = await Promise.race([child.exited, Bun.sleep(2_000).then(() => undefined)]);
      expect(exitCode).toBe(0);
    } finally {
      clearTimeout(deadline);
      reader.releaseLock();
      if (child.exitCode === null) child.kill(9);
      await child.exited;
    }
  }, 10_000);
});

test("disconnects when the host closes its output pipe", async () => {
  const child = Bun.spawn([process.execPath, "packages/cli/src/index.ts", "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pipe-test", version: "1" } } })}\n`,
    );
    const initial = await reader.read();
    expect(initial.done).toBe(false);
    await reader.cancel();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    const exit = await Promise.race([child.exited, Bun.sleep(3_000).then(() => undefined)]);
    expect(exit).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill(9);
    await child.exited;
  }
}, 10_000);

const fixture = resolve("tests/fixtures/adapter-lifecycle.ts");
const bun = process.execPath;

async function runFixture(scenario: "handoff" | "owner-loss") {
  const child = Bun.spawn([bun, fixture, scenario], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      SIMVIEW_PROJECT_ROOT: resolve("."),
    },
  });
  const result = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const timeout = setTimeout(() => child.kill(9), 5_000);
  try {
    const [stdout, stderr, exitCode] = await result;
    if (exitCode !== 0) throw new Error(`Fixture failed (${exitCode}): ${stderr}`);
    return JSON.parse(stdout.trim()) as {
      scenario: string;
      snapshotCalls: number;
      watcherStarts: number;
      watcherStops: number;
      watcherTicks: number;
      ticksAtStop: number;
      watcherStopsAtForwarding: number;
      ticksAtForwarding: number;
      acquireStarted: boolean;
      forwarded: boolean;
      destroyed: boolean;
    };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill(9);
    await child.exited;
  }
}

describe("MCP adapter lifecycle", () => {
  test("stops its startup owner polling after daemon handoff", async () => {
    const result = await runFixture("handoff");
    expect(result).toMatchObject({
      scenario: "handoff",
      snapshotCalls: 1,
      watcherStarts: 1,
      watcherStops: 1,
      watcherStopsAtForwarding: 1,
      acquireStarted: true,
      forwarded: true,
      destroyed: true,
    });
    // The synthetic watcher runs every 5ms while acquisition is pending. The
    // socket stays open after handoff. The old implementation only stopped
    // this watcher when the socket later closed, so it would record zero
    // stops and additional ticks at forwarding.
    expect(result.watcherTicks).toBeGreaterThan(0);
    expect(result.watcherStopsAtForwarding).toBe(1);
    expect(result.ticksAtForwarding).toBe(result.watcherTicks);
    expect(result.watcherTicks).toBe(result.ticksAtStop);
  });

  test("does not forward a socket when an owner exits during acquisition", async () => {
    const result = await runFixture("owner-loss");
    expect(result).toMatchObject({
      scenario: "owner-loss",
      snapshotCalls: 1,
      watcherStarts: 1,
      watcherStops: 1,
      acquireStarted: true,
      forwarded: false,
      destroyed: true,
    });
  });
});
