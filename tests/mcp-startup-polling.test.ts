import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("throttles owner inspection while retrying a held MCP startup lock", async () => {
  const child = Bun.spawn([process.execPath, resolve("tests/fixtures/mcp-startup-polling.ts")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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
    expect(JSON.parse(stdout.trim())).toEqual({
      retries: 10,
      spawnAttempts: 0,
      startupSnapshotCalls: 1,
      ownerSnapshotCalls: 1,
      snapshotCalls: 2,
    });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill(9);
    await child.exited;
  }
});
