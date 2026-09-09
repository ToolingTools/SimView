import { describe, expect, test } from "bun:test";

describe("MCP process lifecycle", () => {
  test("exits promptly when its stdio client closes stdin", async () => {
    const child = Bun.spawn([process.execPath, "packages/mcp/src/index.ts"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.end();
    const exitCode = await Promise.race([child.exited, Bun.sleep(2_000).then(() => undefined)]);
    if (exitCode === undefined) child.kill();
    expect(exitCode).toBe(0);
    const diagnostic = JSON.parse((await new Response(child.stderr).text()).trim());
    expect(diagnostic.component).toBe("adapter");
    expect(["stdin_end", "stdin_close"]).toContain(diagnostic.reason);
  });

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
