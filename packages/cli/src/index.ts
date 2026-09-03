#!/usr/bin/env bun

export { filterDeviceList, formatElementTree } from "./output";

// Keep the stdio adapter independent of the device/MCP implementation graph.
export async function run(argv = process.argv): Promise<void> {
  if (argv[2] === "mcp") {
    const { runMcp } = await import("../../mcp/src/adapter");
    await runMcp(argv.slice(3));
  } else {
    const { run: runCommand } = await import("./commands");
    await runCommand(argv);
  }
}

export function formatEntrypointError(argv: string[], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return argv[2] === "mcp" ? message : JSON.stringify({ error: message });
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(formatEntrypointError(process.argv, error));
    process.exitCode = 1;
  }
}
