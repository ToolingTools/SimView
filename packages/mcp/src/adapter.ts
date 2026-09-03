import { readdir } from "node:fs/promises";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import {
  acquireMcpDaemon,
  mcpBuildIdentity,
  mcpDaemonStatuses,
  processSnapshot,
  selectProcessOwners,
  watchProcessOwners,
} from "@simview/client";
import {
  type McpConnectionContext,
  nativeEnvironmentKeys,
  SIMVIEW_VERSION,
} from "@simview/contracts";
import { resolveBinary } from "@simview/core";
import { resolveAppRoot } from "./app-assets";

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function adapterConfiguration(): Promise<{
  command: string[];
  identity: string;
  context: McpConnectionContext;
}> {
  const compiled = import.meta.path.startsWith("/$bunfs/");
  const root = resolve(import.meta.dir, "../../..");
  const context: McpConnectionContext = {
    nativeEnvironment: Object.fromEntries(
      nativeEnvironmentKeys.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
    cwd: process.cwd(),
    projectRoot: resolve(process.env.SIMVIEW_PROJECT_ROOT ?? process.cwd()),
    appRoot: resolve(resolveAppRoot()),
    coreBinary: resolve(resolveBinary()),
    backendMode: process.env.SIMVIEW_BACKEND_MODE === "ephemeral" ? "ephemeral" : "shared",
    claudeDesktop: process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop",
    resourceVersion: process.env.SIMVIEW_RESOURCE_VERSION ?? SIMVIEW_VERSION,
  };
  const files = compiled ? [process.execPath] : [join(root, "bun.lock")];
  if (!compiled) {
    for (const name of ["contracts", "client", "core", "cli", "mcp", "app"])
      files.push(...(await sourceFiles(join(root, "packages", name, "src"))));
  }
  files.push(context.coreBinary);
  for (const name of ["preview.html", "preview.js"]) {
    const path = join(context.appRoot, "dist", name);
    if (await Bun.file(path).exists()) files.push(path);
  }
  return {
    command: compiled
      ? [process.execPath, "mcp", "--daemon"]
      : [process.execPath, import.meta.path, "--daemon"],
    identity: await mcpBuildIdentity(files),
    context,
  };
}

export async function runAdapter(): Promise<void> {
  const controller = new AbortController();
  let socket: Socket | undefined;
  let unwatch = () => {};
  let finished = false;
  let resolveDone = () => {};
  const done = new Promise<void>((resolveDonePromise) => {
    resolveDone = resolveDonePromise;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    controller.abort();
    unwatch();
    process.stdin.unpipe(socket);
    process.stdin.pause();
    socket?.unpipe(process.stdout);
    socket?.destroy();
    resolveDone();
  };
  // Install these before filesystem work or process discovery: an unused server may get EOF immediately.
  for (const event of ["end", "close", "error"] as const) process.stdin.once(event, finish);
  process.stdout.once("error", finish);
  process.stdout.once("close", finish);
  for (const signal of ["SIGINT", "SIGTERM", "disconnect"] as const) process.once(signal, finish);
  // Reading one byte detects EOF without consuming/buffering an unbounded MCP stream during startup.
  process.stdin.read(0);
  try {
    const snapshot = await processSnapshot();
    const owners = selectProcessOwners(snapshot, process.ppid);
    if (!owners.length) {
      finish();
      return;
    }
    if (finished) return;
    unwatch = watchProcessOwners(owners, finish);
    const configuration = await adapterConfiguration();
    if (finished) return;
    socket = await acquireMcpDaemon({ ...configuration, owners, signal: controller.signal });
    if (finished) {
      socket.destroy();
      return;
    }
    socket.once("error", finish);
    socket.once("close", finish);
    socket.once("end", finish);
    socket.pipe(process.stdout, { end: false });
    process.stdin.pipe(socket);
    await done;
  } catch (error) {
    if (!finished) throw error;
  } finally {
    finish();
    for (const event of ["end", "close", "error"] as const) process.stdin.off(event, finish);
    process.stdout.off("error", finish);
    process.stdout.off("close", finish);
    for (const signal of ["SIGINT", "SIGTERM", "disconnect"] as const) process.off(signal, finish);
  }
}

export async function runMcp(args: string[] = []): Promise<void> {
  if (args.length === 1 && args[0] === "--daemon") {
    const { runMcpDaemon } = await import("./daemon");
    await runMcpDaemon();
  } else if (args[0] === "status" && args.slice(1).every((arg) => arg === "--json")) {
    const daemons = await mcpDaemonStatuses();
    console.log(
      JSON.stringify(
        { daemons, count: daemons.length },
        null,
        args.includes("--json") ? undefined : 2,
      ),
    );
  } else if (args.length === 0) {
    await runAdapter();
  } else {
    throw new Error("Usage: simview mcp [status [--json]]");
  }
}

if (import.meta.main) {
  try {
    await runMcp(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MCP adapter failed");
    process.exitCode = 1;
  }
}
