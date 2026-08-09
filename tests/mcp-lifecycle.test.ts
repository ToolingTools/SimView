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
