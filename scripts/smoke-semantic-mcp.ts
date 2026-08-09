#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../packages/mcp/src/server";

const arguments_ = process.argv.slice(2);
const binary = arguments_
  .find((argument) => argument.startsWith("--binary="))
  ?.slice("--binary=".length);
const binaryPath = binary ? resolve(binary) : undefined;
const query = arguments_.find((argument) => !argument.startsWith("--"));
const shouldTap = arguments_.includes("--tap");
const shouldPinch = arguments_.includes("--pinch");
const startupOnly = arguments_.includes("--startup-only");
const isolated = arguments_.includes("--isolated");
const client = new Client({ name: "simview-semantic-smoke", version: "1.0.0" });
let server: ReturnType<typeof createServer> | undefined;
let isolatedCwd: string | undefined;
type SmokeToolResult = {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
};
const timings: Record<string, number[]> = {};

try {
  if (binaryPath) {
    isolatedCwd = isolated ? await mkdtemp(join(tmpdir(), "simview-plugin-smoke-")) : undefined;
    await client.connect(
      new StdioClientTransport({
        command: binaryPath,
        args: ["mcp"],
        stderr: "inherit",
        ...(isolatedCwd ? { cwd: isolatedCwd } : {}),
      }),
    );
  } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createServer();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }
  const availableTools = await client.listTools();
  const toolNames = availableTools.tools.map((tool) => tool.name);
  if (!toolNames.includes("search_elements")) {
    throw new Error("Installed MCP server does not expose search_elements");
  }

  if (startupOnly) {
    console.log(
      JSON.stringify({
        transport: binaryPath
          ? { kind: "stdio", binary: binaryPath, isolatedCwd }
          : { kind: "in-memory" },
        toolCount: toolNames.length,
        startupOnly: true,
      }),
    );
  } else {
    const listed = await successfulCall("list_devices", {});
    const devices = structured<{ devices?: Array<{ id: string; name: string }> }>(listed).devices;
    const device = devices?.[0];
    if (!device) throw new Error("No available device was returned by list_devices");

    await successfulCall("connect_device", { deviceId: device.id });
    if (shouldPinch) {
      await successfulCall("perform_gesture", {
        tracks: [
          {
            pointerId: 0,
            waypoints: [
              { x: 0.3, y: 0.5, timestampMs: 0 },
              { x: 0.48, y: 0.5, timestampMs: 200 },
            ],
          },
          {
            pointerId: 1,
            waypoints: [
              { x: 0.7, y: 0.5, timestampMs: 0 },
              { x: 0.52, y: 0.5, timestampMs: 200 },
            ],
          },
        ],
      });
    }
    const observed = await successfulCall("observe_screen", { mode: "semantic" });
    assertNoImages(observed, "observe_screen");
    const observation = structured<{
      observationId?: string;
      semantic?: {
        status?: string;
        nodeCount?: number;
        nodes?: Array<{ ref: string; label?: string }>;
      };
      vision?: { included?: boolean; returnedBytes?: number };
    }>(observed);
    const nodes = observation.semantic?.nodes;
    if (!nodes?.length || observation.semantic?.nodeCount === 0) {
      throw new Error("Semantic observation returned no structured nodes");
    }
    if (observation.vision?.included || observation.vision?.returnedBytes !== 0) {
      throw new Error("Semantic observation unexpectedly returned visual content");
    }

    let searchSummary: Record<string, unknown> | undefined;
    if (query) {
      const searched = await successfulCall("search_elements", {
        query,
        actionableOnly: true,
        visibleOnly: true,
        limit: 10,
      });
      assertNoImages(searched, "search_elements");
      const search = structured<{
        count?: number;
        total?: number;
        matches?: Array<{ element: { ref: string; label?: string }; score: number }>;
      }>(searched);
      searchSummary = {
        query,
        count: search.count,
        total: search.total,
        matches: search.matches,
      };
      const first = search.matches?.[0];
      if (shouldTap) {
        if (!first)
          throw new Error(`No actionable semantic element matched ${JSON.stringify(query)}`);
        await successfulCall("tap_element", { ref: first.element.ref });
        const afterTap = await successfulCall("observe_screen", { mode: "semantic" });
        assertNoImages(afterTap, "post-tap observe_screen");
      }
    }

    console.log(
      JSON.stringify(
        {
          transport: binaryPath ? { kind: "stdio", binary: binaryPath } : { kind: "in-memory" },
          toolCount: toolNames.length,
          device,
          observation: {
            observationId: observation.observationId,
            status: observation.semantic?.status,
            nodeCount: observation.semantic?.nodeCount,
            returnedNodes: nodes.length,
            sample: nodes.slice(0, 12),
            vision: observation.vision,
          },
          search: searchSummary,
          tapped: shouldTap,
          pinched: shouldPinch,
          toolTimingsMs: timings,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await client.close();
  await server?.close();
  if (isolatedCwd) await rm(isolatedCwd, { recursive: true, force: true });
}

async function successfulCall(
  name: string,
  args: Record<string, unknown>,
): Promise<SmokeToolResult> {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const samples = timings[name] ?? [];
  samples.push(Math.round((performance.now() - started) * 10) / 10);
  timings[name] = samples;
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result as SmokeToolResult;
}

function structured<T>(result: { structuredContent?: unknown }): T {
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error("Tool result has no structured content");
  }
  return result.structuredContent as T;
}

function assertNoImages(result: { content?: unknown }, label: string): void {
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.some((item) => item && typeof item === "object" && item.type === "image")) {
    throw new Error(`${label} unexpectedly returned image content`);
  }
}
