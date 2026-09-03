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

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
