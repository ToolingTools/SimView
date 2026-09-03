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
  });

  test("shuts down cleanly on termination signals", async () => {
    const child = Bun.spawn([process.execPath, "packages/mcp/src/index.ts"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Cold Bun transpilation can exceed 250 ms on a loaded release builder.
    // Give the entrypoint time to install its signal handlers before testing shutdown.
    await Bun.sleep(750);
    child.kill("SIGTERM");
    const exitCode = await Promise.race([child.exited, Bun.sleep(2_000).then(() => undefined)]);
    if (exitCode === undefined) child.kill(9);
    expect(exitCode).toBe(0);
  });
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
