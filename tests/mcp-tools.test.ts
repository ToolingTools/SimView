import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../packages/mcp/src/server";
import { SimViewSession } from "../packages/mcp/src/session";

const appCalledTools = [
  "app_connect_simulator",
  "app_enable_ui_probe",
  "app_get_accessibility_tree",
  "app_get_ui_context",
  "app_inspect_point",
  "app_list_simulators",
  "app_take_screenshot",
  "app_tap_element",
  "delete_annotation",
  "get_preview_packets",
  "simulator_input",
  "update_annotation",
];

const modelOnlyTools = [
  "add_annotation",
  "connect_simulator",
  "get_accessibility_tree",
  "get_simview_state",
  "get_ui_context",
  "enable_ui_probe",
  "inspect_point",
  "list_simulators",
  "take_screenshot",
  "tap_element",
];

describe("MCP app tools", () => {
  test("authorizes app calls and persists annotation mutations", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: "simview-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    let annotationId: string | undefined;
    try {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      expect(listed.tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
      const linkedTools = listed.tools.filter((tool) => {
        const meta = tool._meta as
          | {
              ui?: { resourceUri?: string };
              "ui/resourceUri"?: string;
              "openai/outputTemplate"?: string;
            }
          | undefined;
        return Boolean(
          meta?.ui?.resourceUri ?? meta?.["ui/resourceUri"] ?? meta?.["openai/outputTemplate"],
        );
      });
      expect(linkedTools.map((tool) => tool.name).sort()).toEqual(
        ["open_simview", ...appCalledTools].sort(),
      );

      const openMeta = byName.get("open_simview")?._meta as
        | {
            ui?: { resourceUri?: string; visibility?: string[] };
            "ui/resourceUri"?: string;
            "openai/outputTemplate"?: string;
          }
        | undefined;
      expect(openMeta?.ui?.resourceUri).toMatch(
        /^ui:\/\/simview\/.+\/reviews\/[0-9a-f-]{36}\/preview\.html$/,
      );
      expect(openMeta?.["ui/resourceUri"]).toBe(openMeta?.ui?.resourceUri);
      expect(openMeta?.["openai/outputTemplate"]).toBe(openMeta?.ui?.resourceUri);
      expect(openMeta?.ui?.visibility).toEqual(["model"]);

      const resource = await client.readResource({ uri: openMeta?.ui?.resourceUri ?? "" });
      expect(resource.contents).toHaveLength(1);
      expect(resource.contents[0]?.uri).toBe(openMeta?.ui?.resourceUri);
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");

      for (const name of appCalledTools) {
        const meta = byName.get(name)?._meta as
          | {
              ui?: { resourceUri?: string; visibility?: string[] };
              "ui/resourceUri"?: string;
              "openai/outputTemplate"?: string;
              "openai/widgetAccessible"?: boolean;
            }
          | undefined;
        expect(meta?.ui?.visibility).toContain("app");
        expect(meta?.["openai/widgetAccessible"]).toBe(true);
        expect(meta?.ui?.resourceUri).toBe(openMeta?.ui?.resourceUri);
        expect(meta?.["ui/resourceUri"]).toBe(openMeta?.ui?.resourceUri);
        expect(meta?.["openai/outputTemplate"]).toBeUndefined();
      }

      for (const name of modelOnlyTools) {
        const meta = byName.get(name)?._meta as
          | {
              ui?: { resourceUri?: string; visibility?: string[] };
              "ui/resourceUri"?: string;
              "openai/outputTemplate"?: string;
            }
          | undefined;
        expect(meta?.ui?.visibility).toEqual(["model"]);
        expect(meta?.ui?.resourceUri).toBeUndefined();
        expect(meta?.["ui/resourceUri"]).toBeUndefined();
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
      expect(
        (
          stateAfterAdd.structuredContent as {
            annotations: Array<{ id: string }>;
          }
        ).annotations.some((item) => item.id === annotation.id),
      ).toBe(true);

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
        await client
          .callTool({
            name: "delete_annotation",
            arguments: { id: annotationId },
          })
          .catch(() => {});
      }
      await client.close();
      await server.close();
    }
  });

  test("isolates review resources and per-device annotations", async () => {
    const first = new SimViewSession();
    const second = new SimViewSession();
    expect(first.reviewId).not.toBe(second.reviewId);

    first.device = { udid: "device-a", name: "A", state: "Booted", runtime: "iOS" };
    second.device = { udid: "device-a", name: "A", state: "Booted", runtime: "iOS" };
    const annotation = first.addAnnotation({
      geometry: { kind: "point", x: 0.2, y: 0.4 },
      note: "First review only",
    });
    expect(second.state().annotations).toEqual([]);

    first.device = { udid: "device-b", name: "B", state: "Booted", runtime: "iOS" };
    expect(first.state().annotations).toEqual([]);
    first.device = { udid: "device-a", name: "A", state: "Booted", runtime: "iOS" };
    expect(first.state().annotations.map((item) => item.id)).toEqual([annotation.id]);

    const firstServer = createServer(first);
    const secondServer = createServer(second);
    const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
    const firstClient = new Client({ name: "first-review", version: "1.0.0" });
    const secondClient = new Client({ name: "second-review", version: "1.0.0" });
    await Promise.all([
      firstServer.connect(firstServerTransport),
      firstClient.connect(firstClientTransport),
      secondServer.connect(secondServerTransport),
      secondClient.connect(secondClientTransport),
    ]);
    try {
      const firstUri = resourceUri(await firstClient.listTools());
      const secondUri = resourceUri(await secondClient.listTools());
      expect(firstUri).toContain(first.reviewId);
      expect(secondUri).toContain(second.reviewId);
      expect(firstUri).not.toBe(secondUri);

      const currentResource = await secondClient.readResource({ uri: secondUri });
      expect(currentResource.contents[0]?.uri).toBe(secondUri);

      const resourceFromPreviousBridge = await secondClient.readResource({ uri: firstUri });
      expect(resourceFromPreviousBridge.contents[0]?.uri).toBe(firstUri);
    } finally {
      await Promise.all([
        firstClient.close(),
        secondClient.close(),
        firstServer.close(),
        secondServer.close(),
        first.close(),
        second.close(),
      ]);
    }
  });
});

function resourceUri(tools: Awaited<ReturnType<Client["listTools"]>>): string {
  const open = tools.tools.find((tool) => tool.name === "open_simview");
  const meta = open?._meta as { ui?: { resourceUri?: string } } | undefined;
  if (!meta?.ui?.resourceUri) throw new Error("open_simview has no resource URI");
  return meta.ui.resourceUri;
}
