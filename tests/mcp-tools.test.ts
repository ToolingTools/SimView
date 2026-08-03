import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type ElementTreeOutput,
  type ElementTreePage,
  elementTreePageSchema,
} from "@simview/contracts";
import { assembleElementTreePages } from "../packages/app/src/helpers";
import { createServer } from "../packages/mcp/src/server";
import { SimViewSession } from "../packages/mcp/src/session";

const appCalledTools = [
  "app_connect_simulator",
  "app_enable_ui_probe",
  "app_get_accessibility_tree",
  "app_get_element_tree",
  "app_get_element_tree_page",
  "app_get_ui_context",
  "app_inspect_point",
  "app_list_simulators",
  "app_take_screenshot",
  "save_review_images",
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
    const session = new SimViewSession();
    const server = createServer(session);
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
      expect(
        (
          resource.contents[0]?._meta as {
            ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } };
          }
        )?.ui?.csp,
      ).toEqual({
        connectDomains: [],
        resourceDomains: [],
      });
      expect(
        (resource.contents[0]?._meta as { "openai/widgetMinFrameHeight"?: number })?.[
          "openai/widgetMinFrameHeight"
        ],
      ).toBe(600);

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
          geometry: { kind: "rect", x: 0.2, y: 0.3, width: 0.4, height: 0.25 },
          note: "Works",
        },
      });
      const annotation = added.structuredContent as {
        id: string;
        note: string;
        frameId: string;
      };
      annotationId = annotation.id;
      expect(annotation).toMatchObject({
        note: "Works",
        frameId: "42",
        geometry: { kind: "rect", x: 0.2, y: 0.3, width: 0.4, height: 0.25 },
      });

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
      await session.close();
    }
  });

  test("pages one exact Fiber capture into host-safe bridge responses", async () => {
    const session = new SimViewSession();
    session.device = {
      udid: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      name: "iPhone",
      state: "Booted",
      runtime: "iOS 26.0",
    };
    const children = Array.from({ length: 653 }, (_, index) => ({
      ref: `rn:${index}`,
      kind: "host" as const,
      label: `Element ${index} — 日本語 👋 ${"x".repeat(80)}`,
      ...(index === 0 ? { children: [] } : {}),
    }));
    const output: ElementTreeOutput = {
      snapshot: {
        schemaVersion: 1,
        snapshotId: "fiber-654",
        capturedAt: "2026-07-31T10:00:00.000Z",
        source: "react-native-fiber",
        scope: "full",
        screen: { x: 0, y: 0, width: 430, height: 932 },
        root: { ref: "rn:root", kind: "component", children },
        stats: { nodeCount: 654, truncated: false },
        metro: {
          host: "127.0.0.1",
          port: 8081,
          targetId: "target-1",
          targetTitle: "Shop",
          renderer: "fabric",
        },
      },
      screenContext: {
        schemaVersion: 1,
        kind: "react-native",
        capturedAt: "2026-07-31T10:00:00.000Z",
        frameId: "frame-1",
        renderer: "fabric",
        target: "Shop",
        route: "ShopMenuRoot",
        screenComponent: "ShopMenuScreen",
        confidence: "exact",
      },
    };
    let captures = 0;
    session.elementSnapshot = async () => {
      captures += 1;
      return output;
    };
    const server = createServer(session);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "paged-elements", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const pages: ElementTreePage[] = [];
      let result = await client.callTool({
        name: "app_get_element_tree_page",
        arguments: { action: "start", source: "elements", scope: "full", maxNodes: 1_200 },
      });
      while (true) {
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(80 * 1_024);
        const page = elementTreePageSchema.parse(result.structuredContent);
        pages.push(page);
        if (!page.nextCursor) break;
        if (page.pageIndex === 0) {
          const retry = await client.callTool({
            name: "app_get_element_tree_page",
            arguments: { action: "continue", cursor: page.nextCursor },
          });
          result = retry;
          continue;
        }
        result = await client.callTool({
          name: "app_get_element_tree_page",
          arguments: { action: "continue", cursor: page.nextCursor },
        });
      }

      expect(captures).toBe(1);
      expect(pages.length).toBeGreaterThan(1);
      expect(await assembleElementTreePages(pages)).toEqual(output);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
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

  test("stores review images in a private temporary directory and removes them on close", async () => {
    const session = new SimViewSession();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==";
    const annotationId = "e7787f9d-cfd8-4f52-b136-f16d02d30d30";
    const saved = await session.saveReviewImages({
      screenshot: png,
      annotations: [{ id: annotationId, screenshot: png }],
    });

    expect(saved.directory).toStartWith(`${tmpdir()}/simview-review-`);
    expect((await stat(saved.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(saved.screenshotPath)).mode & 0o777).toBe(0o600);
    expect(saved.annotations[0]).toMatchObject({ id: annotationId });
    expect(await Bun.file(saved.annotations[0]?.screenshotPath ?? "").exists()).toBe(true);

    await session.close();
    expect(await Bun.file(saved.screenshotPath).exists()).toBe(false);
  });

  test("reuses React Native elements for selectors and reports the focused screen in state", async () => {
    const session = new SimViewSession();
    session.lastElements = {
      schemaVersion: 1,
      snapshotId: "fiber-1",
      capturedAt: "2026-07-31T10:00:00.000Z",
      source: "react-native-fiber",
      scope: "interactive",
      screen: { x: 0, y: 0, width: 430, height: 932 },
      root: {
        ref: "rn:root",
        children: [
          {
            ref: "rn:1",
            identifier: "shop-menu-screen",
            label: "Shop menu",
            kind: "component",
          },
        ],
      },
      stats: { nodeCount: 2, truncated: false },
      metro: {
        host: "127.0.0.1",
        port: 8081,
        targetId: "target-1",
        targetTitle: "Shop",
        renderer: "fabric",
      },
    };
    session.lastScreenContext = {
      schemaVersion: 1,
      kind: "react-native",
      capturedAt: "2026-07-31T10:00:00.000Z",
      frameId: "frame-1",
      renderer: "fabric",
      target: "Shop",
      route: "ShopMenuRoot",
      screenComponent: "ShopMenuScreen",
      testID: "shop-menu-screen",
      sourceLocation: { file: "src/ShopMenuScreen.tsx", line: 10 },
      confidence: "exact",
    };

    expect(
      await session.findElements({ identifier: "shop-menu-screen", exact: true }),
    ).toMatchObject({
      snapshotId: "fiber-1",
      count: 1,
      matches: [{ ref: "rn:1" }],
    });
    expect(session.state()).toMatchObject({
      route: "ShopMenuRoot",
      component: {
        label: "ShopMenuScreen",
        testID: "shop-menu-screen",
        source: "src/ShopMenuScreen.tsx",
      },
    });
  });
});

function resourceUri(tools: Awaited<ReturnType<Client["listTools"]>>): string {
  const open = tools.tools.find((tool) => tool.name === "open_simview");
  const meta = open?._meta as { ui?: { resourceUri?: string } } | undefined;
  if (!meta?.ui?.resourceUri) throw new Error("open_simview has no resource URI");
  return meta.ui.resourceUri;
}
