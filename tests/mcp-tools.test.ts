import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../packages/mcp/src/server";

const appCalledTools = [
  "connect_simulator",
  "get_preview_packets",
  "list_simulators",
  "simulator_input",
  "inspect_point",
  "update_annotation",
  "add_annotation",
  "delete_annotation",
  "take_screenshot",
  "get_accessibility_tree",
  "get_simview_state",
  "get_ui_context",
  "enable_ui_probe",
  "tap_element",
];

describe("MCP app tools", () => {
  test("authorizes app calls and persists annotation mutations", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: "simview-test", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    let annotationId: string | undefined;
    try {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map(tool => [tool.name, tool]));
      const linkedTools = listed.tools.filter(tool => {
        const meta = tool._meta as {
          ui?: { resourceUri?: string };
          "ui/resourceUri"?: string;
          "openai/outputTemplate"?: string;
        } | undefined;
        return Boolean(
          meta?.ui?.resourceUri
          ?? meta?.["ui/resourceUri"]
          ?? meta?.["openai/outputTemplate"],
        );
      });
      expect(linkedTools.map(tool => tool.name).sort()).toEqual(
        ["open_simview", ...appCalledTools].sort(),
      );

      const openMeta = byName.get("open_simview")?._meta as {
        ui?: { resourceUri?: string; visibility?: string[] };
        "ui/resourceUri"?: string;
        "openai/outputTemplate"?: string;
      } | undefined;
      expect(openMeta?.ui?.resourceUri).toMatch(/^ui:\/\/simview\/.+\/preview\.html$/);
      expect(openMeta?.["ui/resourceUri"]).toBe(openMeta?.ui?.resourceUri);
      expect(openMeta?.["openai/outputTemplate"]).toBe(openMeta?.ui?.resourceUri);
      expect(openMeta?.ui?.visibility).toEqual(["model"]);

      for (const name of appCalledTools) {
        const meta = byName.get(name)?._meta as {
          ui?: { resourceUri?: string; visibility?: string[] };
          "ui/resourceUri"?: string;
          "openai/outputTemplate"?: string;
          "openai/widgetAccessible"?: boolean;
        } | undefined;
        expect(meta?.ui?.visibility).toContain("app");
        expect(meta?.["openai/widgetAccessible"]).toBe(true);
        expect(meta?.ui?.resourceUri).toBe(openMeta?.ui?.resourceUri);
        expect(meta?.["ui/resourceUri"]).toBe(openMeta?.ui?.resourceUri);
        expect(meta?.["openai/outputTemplate"]).toBeUndefined();
      }

      const added = await client.callTool({
        name: "add_annotation",
        arguments: {
          frameId: "42",
          geometry: { kind: "point", x: 0.25, y: 0.75 },
          note: "Works",
        },
      });
      const annotation = added.structuredContent as {
        id: string;
        note: string;
        frameId: string;
      };
      annotationId = annotation.id;
      expect(annotation).toMatchObject({ note: "Works", frameId: "42" });

      const stateAfterAdd = await client.callTool({
        name: "get_simview_state",
        arguments: {},
      });
      expect((stateAfterAdd.structuredContent as {
        annotations: Array<{ id: string }>;
      }).annotations.some(item => item.id === annotation.id)).toBe(true);

      const updated = await client.callTool({
        name: "update_annotation",
        arguments: { id: annotation.id, note: "Updated" },
      });
      expect(updated.structuredContent).toMatchObject({
        id: annotation.id,
        note: "Updated",
      });

      const deleted = await client.callTool({
        name: "delete_annotation",
        arguments: { id: annotation.id },
      });
      expect(deleted.structuredContent).toEqual({
        deleted: true,
        id: annotation.id,
      });
      annotationId = undefined;
    } finally {
      if (annotationId) {
        await client.callTool({
          name: "delete_annotation",
          arguments: { id: annotationId },
        }).catch(() => {});
      }
      await client.close();
      await server.close();
    }
  });
});
