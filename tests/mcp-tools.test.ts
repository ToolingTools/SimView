import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type AccessibilitySnapshot,
  deviceListSchema,
  type ElementTreeOutput,
  type ElementTreePage,
  elementTreePageSchema,
  parseDeviceDescription,
} from "@simview/contracts";
import { assembleElementTreePages } from "../packages/app/src/helpers";
import {
  createServer,
  deviceListPage,
  hasMcpUiCapability,
  isDesktopMcpAppHost,
} from "../packages/mcp/src/server";
import { type AccessibilityObservation, SimViewSession } from "../packages/mcp/src/session";

const appCalledTools = [
  "app_connect_device",
  "app_enable_ui_probe",
  "app_get_accessibility_tree",
  "app_get_element_tree",
  "app_get_element_tree_page",
  "app_get_ui_context",
  "app_inspect_point",
  "app_list_devices",
  "app_take_screenshot",
  "save_review_images",
  "app_tap_element",
  "delete_annotation",
  "device_input",
  "get_preview_packets",
  "simulator_input",
  "update_annotation",
];

const modelOnlyTools = [
  "add_annotation",
  "connect_device",
  "disable_ios_accessibility",
  "enable_ios_accessibility",
  "get_accessibility_tree",
  "get_simview_state",
  "get_ui_context",
  "enable_ui_probe",
  "inspect_point",
  "list_devices",
  "search_elements",
  "take_screenshot",
  "tap_element",
];

describe("MCP app tools", () => {
  test("directs disconnected control calls to connect_device", () => {
    const session = new SimViewSession();
    expect(() => session.requireClient()).toThrow(
      "No device is connected; call connect_device before using device controls",
    );
  });

  test("bounds device discovery and defaults to available devices", () => {
    const ready = iosDevice("00000000-0000-4000-8000-000000000001", "Ready iPhone");
    const shutdown = Array.from({ length: 40 }, (_, index) => ({
      ...iosDevice(
        `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
        `Shutdown iPhone ${index + 1}`,
      ),
      state: "shutdown" as const,
      available: false,
    }));

    expect(deviceListPage([ready, ...shutdown])).toMatchObject({
      devices: [ready],
      inventoryTotal: 41,
      total: 1,
      returned: 1,
      offset: 0,
      limit: 10,
      hasMore: false,
    });
    const firstPage = deviceListPage([ready, ...shutdown], {
      availableOnly: false,
      offset: 0,
      limit: 25,
    });
    expect(firstPage.returned).toBe(25);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = deviceListPage([ready, ...shutdown], {
      availableOnly: false,
      offset: 25,
      limit: 25,
    });
    expect(secondPage.returned).toBe(16);
    expect(secondPage.hasMore).toBe(false);
  });

  test("pages one stable device inventory snapshot and invalidates its cursors", async () => {
    let now = 1_000;
    let calls = 0;
    let inventory = Array.from({ length: 55 }, (_, index) =>
      iosDevice(`device-${String(index).padStart(3, "0")}`, `iPhone ${index}`),
    );
    const session = new SimViewSession();
    const server = createServer(session, {
      deviceProvider: async () => {
        calls += 1;
        return inventory;
      },
      deviceInventorySnapshotTTLMS: 30_000,
      now: () => now,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "device-pages", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const first = deviceListSchema.parse(
        (
          await client.callTool({
            name: "app_list_devices",
            arguments: { availableOnly: false, limit: 25 },
          })
        ).structuredContent,
      );
      inventory = [iosDevice("new-device", "New iPhone")];
      const devices = [...first.devices];
      let cursor = first.nextCursor;
      let lastCursor: string | undefined;
      while (cursor) {
        lastCursor = cursor;
        const page = deviceListSchema.parse(
          (
            await client.callTool({
              name: "app_list_devices",
              arguments: { cursor },
            })
          ).structuredContent,
        );
        devices.push(...page.devices);
        cursor = page.nextCursor;
      }
      expect(calls).toBe(1);
      expect(devices).toHaveLength(55);
      expect(new Set(devices.map((device) => device.id)).size).toBe(55);

      const reused = await client.callTool({
        name: "app_list_devices",
        arguments: { cursor: lastCursor },
      });
      expect(reused.isError).toBe(true);

      const fresh = deviceListSchema.parse(
        (
          await client.callTool({
            name: "app_list_devices",
            arguments: { availableOnly: false, limit: 25 },
          })
        ).structuredContent,
      );
      expect(calls).toBe(2);
      expect(fresh.devices.map((device) => device.id)).toEqual(["ios:new-device"]);

      inventory = Array.from({ length: 30 }, (_, index) =>
        iosDevice(`expiring-${index}`, `Expiring ${index}`),
      );
      const expiring = deviceListSchema.parse(
        (
          await client.callTool({
            name: "app_list_devices",
            arguments: { availableOnly: false, limit: 10 },
          })
        ).structuredContent,
      );
      const expiringCursor = expiring.nextCursor;
      if (!expiringCursor) throw new Error("Expected a continuation cursor");
      const changedOptions = await client.callTool({
        name: "app_list_devices",
        arguments: { cursor: expiringCursor, limit: 5 },
      });
      expect(changedOptions.isError).toBe(true);
      now += 30_001;
      const expired = await client.callTool({
        name: "app_list_devices",
        arguments: { cursor: expiringCursor },
      });
      expect(expired.isError).toBe(true);
      const malformed = await client.callTool({
        name: "app_list_devices",
        arguments: { cursor: "not-a-private-cursor" },
      });
      expect(malformed.isError).toBe(true);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("bounds active inventory snapshots and retained devices", async () => {
    const inventory = Array.from({ length: 300 }, (_, index) =>
      iosDevice(`bounded-${index}`, `Bounded ${index}`),
    );
    const session = new SimViewSession();
    const server = createServer(session, { deviceProvider: async () => inventory });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bounded-device-pages", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const cursors: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const page = deviceListSchema.parse(
          (
            await client.callTool({
              name: "app_list_devices",
              arguments: { availableOnly: false, limit: 25 },
            })
          ).structuredContent,
        );
        expect(page.snapshotTruncated).toBe(true);
        if (!page.nextCursor) throw new Error("Expected a bounded snapshot cursor");
        cursors.push(page.nextCursor);
      }
      const evicted = await client.callTool({
        name: "app_list_devices",
        arguments: { cursor: cursors[0] },
      });
      expect(evicted.isError).toBe(true);
      const retained = await client.callTool({
        name: "app_list_devices",
        arguments: { cursor: cursors[4] },
      });
      expect(retained.isError).not.toBe(true);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("recognizes the MCP App capability in modern and legacy capability locations", () => {
    expect(hasMcpUiCapability({ "io.modelcontextprotocol/ui": {} })).toBe(true);
    expect(hasMcpUiCapability({ extensions: { "io.modelcontextprotocol/ui": {} } })).toBe(true);
    expect(hasMcpUiCapability({ experimental: { "io.modelcontextprotocol/ui": {} } })).toBe(true);
    expect(hasMcpUiCapability({ extensions: {} })).toBe(false);
  });

  test("recognizes Claude Code sessions hosted by Claude Desktop", () => {
    expect(isDesktopMcpAppHost({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" })).toBe(true);
    expect(isDesktopMcpAppHost({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(false);
    expect(isDesktopMcpAppHost({})).toBe(false);
  });

  test("opens the browser only for hosts without the MCP App capability", async () => {
    const noAppSession = previewSession();
    const appSession = previewSession();
    const noApp = await callOpenSimView(noAppSession);
    const app = await callOpenSimView(appSession, {
      extensions: { "io.modelcontextprotocol/ui": {} },
    });

    expect(noAppSession.browserOpened).toBe(1);
    expect(noAppSession.relayStarted).toBe(1);
    expect((noApp.content as Array<{ text: string }>)[0]?.text).toContain("connected");
    expect(appSession.browserOpened).toBe(0);
    expect(appSession.relayStarted).toBe(0);
    expect((app.content as Array<{ text: string }>)[0]?.text).toContain("connected");
  });

  test("does not open the browser when a v1 host reads the app resource", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = previewSession();
    const server = createServer(session, { browserFallbackDelayMs: 25 });
    const client = new Client({ name: "simview-v1-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const uri = resourceUri(await client.listTools());
      await client.callTool({ name: "open_simview", arguments: {} });
      await client.readResource({ uri });
      await Bun.sleep(35);

      expect(session.browserOpened).toBe(0);
      expect(session.relayStarted).toBe(0);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("serves the settled accessibility resource and notifies only on semantic changes", async () => {
    const session = new SimViewSession();
    session.device = iosDevice("resource-device", "Resource Device");
    const snapshots = [
      resourceSnapshot("ax-1", "ax:first", "Continue"),
      resourceSnapshot("ax-2", "ax:second", "Continue"),
      resourceSnapshot("ax-3", "ax:third", "Done"),
    ];
    let captures = 0;
    session.client = {
      connected: true,
      close: async () => {},
      request: async (method: string) => {
        if (method !== "accessibility.observe") throw new Error(`Unexpected method ${method}`);
        const snapshot = snapshots[Math.min(captures, snapshots.length - 1)];
        if (!snapshot) throw new Error("Test snapshot sequence is empty");
        captures += 1;
        return {
          snapshot,
          revision: String(captures),
          eventChanged: captures > 1,
          stable: true,
          timedOut: false,
          strategy: "snapshot-diff",
          settledAt: snapshot.capturedAt,
        };
      },
    } as never;
    const server = createServer(session);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "accessibility-resource-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const notifications: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, ({ params }) => {
      notifications.push(params.uri);
    });
    try {
      const listed = await client.listResources();
      const resource = listed.resources.find((item) => item.uri.startsWith("simview://review/"));
      if (!resource) throw new Error("Accessibility resource was not registered");
      const first = await client.readResource({ uri: resource.uri });
      const second = await client.readResource({ uri: resource.uri });
      expect(captures).toBe(1);
      expect(JSON.parse((first.contents[0] as { text: string }).text)).toMatchObject({
        schemaVersion: 1,
        revision: "1",
        strategy: "snapshot-diff",
        snapshot: { snapshotId: "ax-1" },
      });
      expect((second.contents[0] as { text: string }).text).toBe(
        (first.contents[0] as { text: string }).text,
      );

      await client.subscribeResource({ uri: resource.uri });
      await session.accessibilityObserve({ maxWaitMs: 0 });
      await Bun.sleep(5);
      expect(notifications).toEqual([]);

      await session.accessibilityObserve({ maxWaitMs: 0 });
      await Bun.sleep(5);
      expect(notifications).toEqual([resource.uri]);
      const updated = await client.readResource({ uri: resource.uri });
      expect(JSON.parse((updated.contents[0] as { text: string }).text)).toMatchObject({
        revision: "3",
        snapshot: { snapshotId: "ax-3" },
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("does not pre-empt Claude Desktop with the browser fallback", async () => {
    const session = previewSession();
    const result = await callOpenSimView(session, {}, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });

    expect(session.browserOpened).toBe(0);
    expect(session.relayStarted).toBe(0);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("connected");
  });

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
      const tapElementTool = byName.get("tap_element");
      const performActionsTool = byName.get("perform_actions");
      expect(tapElementTool?.description).toContain("maximum 5000");
      expect(tapElementTool?.description).toContain("stable identifier");
      expect(tapElementTool?.description).toContain("Assertions such as amount/status");
      expect(performActionsTool?.description).toContain("maximum 5000");
      expect(JSON.stringify(tapElementTool?.inputSchema)).toContain(
        "Verification timeout in milliseconds: 100-5000 inclusive; maximum 5000.",
      );
      expect(JSON.stringify(tapElementTool?.inputSchema)).toContain(
        "It must match exactly one node",
      );
      expect(JSON.stringify(tapElementTool?.inputSchema)).toContain(
        "may legitimately match multiple nodes",
      );
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
    session.device = parseDeviceDescription({
      udid: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      name: "iPhone",
      state: "Booted",
      runtime: "iOS 26.0",
    });
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

    first.device = iosDevice("device-a", "A");
    second.device = iosDevice("device-a", "A");
    const annotation = first.addAnnotation({
      geometry: { kind: "point", x: 0.2, y: 0.4 },
      note: "First review only",
    });
    expect(second.state().annotations).toEqual([]);

    first.device = iosDevice("device-b", "B");
    expect(first.state().annotations).toEqual([]);
    first.device = iosDevice("device-a", "A");
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

  test("returns bounded semantic nodes in structured observations", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    const snapshot: AccessibilitySnapshot = {
      schemaVersion: 1,
      snapshotId: "ax-1",
      capturedAt: "2026-08-08T10:00:00.000Z",
      source: "core-simulator-ax",
      scope: "interactive",
      screen: { x: 0, y: 0, width: 402, height: 874 },
      root: {
        ref: "ax:root",
        children: [
          {
            ref: "ax:shop",
            role: "button",
            label: "Shop",
            enabled: true,
            actions: ["press"],
            frame: {
              points: { x: 20, y: 800, width: 80, height: 44 },
              normalized: { x: 0.05, y: 0.915, width: 0.2, height: 0.05 },
            },
          },
        ],
      },
      stats: { nodeCount: 3, truncated: false },
    };
    session.lastAccessibility = snapshot;
    session.warmObservation = async () => ({
      observationId: "frame-1",
      frameId: "frame-1",
      frameRevision: 1,
      changeRevision: 1,
      imageRevision: 0,
      capturedAt: "2026-08-08T10:00:00.000Z",
      settledAt: "2026-08-08T10:00:00.075Z",
      stable: true,
      ageMs: 75,
      width: 402,
      height: 874,
      byteLength: 0,
      imageIncluded: false,
      cacheHit: true,
    });
    const fiberSnapshot: ElementTreeOutput["snapshot"] = {
      ...snapshot,
      snapshotId: "rn-verbose",
      source: "react-native-fiber",
      root: {
        ref: "rn:root",
        children: [
          {
            ref: "rn:ghost",
            label: "OrderConfirmationScreen, tab, 6 of 6",
            role: "tab",
          },
        ],
      },
      stats: { nodeCount: 240, truncated: true, quality: "partial" },
      metro: {
        host: "127.0.0.1",
        port: 8081,
        targetId: "target-1",
        targetTitle: "Shop",
        renderer: "fabric",
      },
    };
    session.preparedElementSnapshot = async () => ({
      snapshot: fiberSnapshot,
      screenContext: {
        schemaVersion: 1,
        kind: "react-native",
        capturedAt: snapshot.capturedAt,
        frameId: "frame-1",
        renderer: "fabric",
        target: "Shop",
        route: "Invoices",
        screenComponent: "InvoicesScreen",
        confidence: "exact",
      },
    });
    const server = createServer(session);
    const client = new Client({ name: "simview-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "observe_screen", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        semantic: {
          status: "full",
          nodeCount: 2,
          nodes: [{ ref: "ax:root" }, { ref: "ax:shop", role: "button", label: "Shop" }],
        },
        vision: { included: false, reason: "semantic-mode", returnedBytes: 0 },
      });
      const nodes = (result.structuredContent as { semantic: { nodes: Array<unknown> } }).semantic
        .nodes;
      expect(nodes[0]).not.toHaveProperty("children");
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (item) => item.type === "text",
      )?.text;
      expect(text).toContain(
        "context=react-native-fiber renderer=fabric elements=core-simulator-ax",
      );
      expect(text).toContain("Shop");
      expect(text).not.toContain("OrderConfirmationScreen");
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("does not return a JPEG for semantic failure unless visual mode is explicit", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.warmObservation = async ({ visual }) => ({
      observationId: "frame-1",
      frameId: "android-frame-1",
      frameRevision: 1,
      changeRevision: 1,
      imageRevision: 1,
      capturedAt: "2026-08-08T10:00:00.000Z",
      settledAt: "2026-08-08T10:00:00.075Z",
      stable: true,
      ageMs: 75,
      width: 461,
      height: 1024,
      byteLength: visual ? 4 : 0,
      imageIncluded: visual,
      cacheHit: visual,
      imageReadyAt: "2026-08-08T10:00:00.075Z",
      image: visual ? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) : undefined,
    });
    session.elementSnapshot = async () => {
      throw new Error("UIAutomator timed out");
    };
    const server = createServer(session);
    const client = new Client({ name: "simview-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "observe_screen", arguments: {} });
      expect((result.content as Array<Record<string, unknown>>)[0]).toMatchObject({
        type: "text",
      });
      expect(result.structuredContent).toMatchObject({
        observationId: expect.any(String),
        frameId: "android-frame-1",
        semanticError: {
          code: "semantic_inspection_failed",
          message: "UIAutomator timed out",
          recoverable: true,
        },
        vision: {
          included: false,
          reason: "semantic-unavailable-vision-not-requested",
          returnedBytes: 0,
        },
      });
      const visual = await client.callTool({
        name: "observe_screen",
        arguments: { mode: "visual" },
      });
      expect((visual.content as Array<Record<string, unknown>>)[0]).toMatchObject({
        type: "image",
        mimeType: "image/jpeg",
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("resolves a query-only semantic tap without requiring a second selector", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("query-tap", "Query Tap");
    const element = {
      ref: "ax:continue",
      role: "button",
      label: "Continue",
      enabled: true,
      frame: {
        points: { x: 100, y: 200, width: 80, height: 40 },
        normalized: { x: 0.25, y: 0.25, width: 0.2, height: 0.05 },
      },
    };
    session.searchElements = async () =>
      ({
        snapshotId: "ax-1",
        query: {
          query: "continue",
          actionableOnly: true,
          visibleOnly: true,
          limit: 5,
        },
        matches: [{ element, score: 1, matchedFields: ["name"], exact: true }],
        count: 1,
        total: 1,
        truncated: false,
      }) as never;
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target: element,
        point: { x: 0.35, y: 0.275 },
      }) as never;
    let dispatched: unknown;
    session.dispatchInput = async (input) => {
      dispatched = input;
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "query-tap-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: { query: "continue", observe: "none" },
      });
      expect(result.structuredContent).toMatchObject({
        selector: { ref: "ax:continue" },
        point: { x: 0.35, y: 0.275 },
        receipt: { accepted: true },
      });
      expect(dispatched).toEqual({
        method: "input.tap",
        params: { x: 0.35, y: 0.275 },
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("returns a valid embedded semantic observation after an element tap", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("observed-tap", "Observed Tap");
    const element = {
      ref: "ax:continue",
      role: "button",
      label: "Continue",
      enabled: true,
      frame: {
        points: { x: 100, y: 200, width: 80, height: 40 },
        normalized: { x: 0.25, y: 0.25, width: 0.2, height: 0.05 },
      },
    };
    const snapshot: AccessibilitySnapshot = {
      schemaVersion: 1,
      snapshotId: "ax-observed",
      capturedAt: "2026-08-08T10:00:00.000Z",
      source: "core-simulator-ax",
      scope: "interactive",
      screen: { x: 0, y: 0, width: 402, height: 874 },
      root: { ref: "ax:root", children: [element] },
      stats: { nodeCount: 2, truncated: false },
    };
    session.lastAccessibility = snapshot;
    session.accessibilityObserve = async () =>
      ({
        snapshot,
        revision: "4",
        eventChanged: false,
        stable: false,
        timedOut: true,
        strategy: "ios-axp",
        settledAt: snapshot.capturedAt,
        fallbackUsed: true,
        captureCount: 2,
        changeSource: "snapshot-diff",
      }) as never;
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target: element,
        point: { x: 0.35, y: 0.275 },
      }) as never;
    session.findElements = async (selector) =>
      ({ snapshotId: snapshot.snapshotId, selector, matches: [element], count: 1 }) as never;
    session.warmObservation = async () => ({
      observationId: "warm-observed",
      frameId: "frame-observed",
      frameRevision: 2,
      changeRevision: 2,
      imageRevision: 0,
      capturedAt: "2026-08-08T10:00:00.000Z",
      settledAt: "2026-08-08T10:00:00.075Z",
      stable: true,
      ageMs: 75,
      width: 402,
      height: 874,
      byteLength: 0,
      imageIncluded: false,
      cacheHit: true,
    });
    session.preparedElementSnapshot = async () => ({
      snapshot,
      screenContext: {
        schemaVersion: 1,
        kind: "native-ios",
        platform: "ios",
        capturedAt: snapshot.capturedAt,
        frameId: "frame-observed",
        simulatorName: "Observed Tap",
        viewport: { x: 0, y: 0, width: 402, height: 874 },
        orientation: "portrait",
      },
    });
    session.dispatchInput = async () => ({ accepted: true });
    session.verifyNativeDestination = async () => ({
      status: "matched",
      verified: true,
      source: "core-simulator-ax",
      snapshotId: snapshot.snapshotId,
      revision: "5",
      settledAt: "2026-08-08T10:00:00.150Z",
      strategy: "ios-axp",
      eventChanged: true,
      timedOut: false,
      fallbackUsed: true,
      captureCount: 1,
      changeSource: "snapshot-diff",
      stable: true,
      checks: [{ kind: "identity", selector: { name: "Continue", exact: true }, count: 1 }],
    });
    const server = createServer(session);
    const client = new Client({ name: "observed-tap-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: {
          ref: element.ref,
          observe: "semantic",
          verifyDestination: { identity: { name: "Continue", exact: true } },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        receipt: { accepted: true },
        observation: {
          sourceRevisions: { accessibility: "5" },
          stability: { stable: true },
          semantic: { status: "full", nodeCount: 2 },
          vision: { included: false, returnedBytes: 0 },
          postAction: {
            accessibility: {
              stable: true,
              revision: "5",
              fallbackUsed: true,
              captureCount: 1,
              changeSource: "snapshot-diff",
            },
          },
        },
        destinationVerification: { status: "matched", verified: true, revision: "5" },
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("taps a clearly ranked semantic query winner", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("ranked-query", "Ranked Query");
    const target = {
      ref: "ax:branches",
      role: "AXTab",
      label: "Branches, tab, 2 of 5",
      enabled: true,
      actions: ["AXPress"],
      frame: {
        points: { x: 80, y: 800, width: 80, height: 44 },
        normalized: { x: 0.2, y: 0.91, width: 0.2, height: 0.05 },
      },
    };
    const weaker = { ...target, ref: "ax:change-branch", label: "Change branch" };
    session.searchElements = async () =>
      ({
        snapshotId: "ax-ranked",
        query: {
          query: "Branches tab",
          actionableOnly: true,
          visibleOnly: true,
          limit: 5,
        },
        matches: [
          { element: target, score: 0.92, matchedFields: ["name", "role"], exact: false },
          { element: weaker, score: 0.65, matchedFields: ["name"], exact: false },
        ],
        count: 2,
        total: 2,
        truncated: false,
      }) as never;
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target,
        point: { x: 0.30000000000000004, y: 0.935 },
      }) as never;
    let dispatched: unknown;
    session.dispatchInput = async (input) => {
      dispatched = input;
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "ranked-query-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: { query: "Branches tab", observe: "none" },
      });
      expect(result.structuredContent).toMatchObject({
        selector: { ref: target.ref },
        receipt: { accepted: true },
      });
      expect(dispatched).toEqual({
        method: "input.tap",
        params: { x: 0.30000000000000004, y: 0.935 },
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("keeps a generation-scoped ref resolvable from its source snapshot", async () => {
    const session = new SimViewSession();
    const source: AccessibilitySnapshot = {
      schemaVersion: 1,
      snapshotId: "ax-source",
      capturedAt: "2026-08-08T10:00:00.000Z",
      source: "core-simulator-ax",
      scope: "interactive",
      screen: { x: 0, y: 0, width: 402, height: 874 },
      root: { ref: "ax:root", children: [{ ref: "ax:generation:21", label: "Branches" }] },
      stats: { nodeCount: 2, truncated: false },
    };
    session.lastAccessibility = source;
    session.client = {
      connected: true,
      close: async () => {},
      request: async () => ({
        observationId: "warm-source",
        frameId: "frame-source",
        frameRevision: 1,
        changeRevision: 1,
        imageRevision: 0,
        capturedAt: source.capturedAt,
        settledAt: source.capturedAt,
        stable: true,
        ageMs: 0,
        width: 402,
        height: 874,
        byteLength: 0,
        imageIncluded: false,
        cacheHit: true,
      }),
    } as never;
    await session.warmObservation({ visual: false, maxWaitMs: 0 });
    let refreshes = 0;
    session.preparedElementSnapshot = async () => {
      refreshes += 1;
      const refreshed = {
        ...source,
        snapshotId: "ax-refreshed",
        root: { ref: "ax:root", children: [{ ref: "ax:generation:22", label: "Branches" }] },
      };
      session.lastAccessibility = refreshed;
      return {
        snapshot: refreshed,
        screenContext: {
          schemaVersion: 1,
          kind: "native-ios",
          platform: "ios",
          capturedAt: source.capturedAt,
          frameId: "frame-source",
          simulatorName: "Ref Source",
          viewport: { x: 0, y: 0, width: 402, height: 874 },
          orientation: "portrait",
        },
      };
    };

    expect(await session.findElements({ ref: "ax:generation:21", exact: true })).toMatchObject({
      snapshotId: "ax-source",
      count: 1,
    });
    expect(refreshes).toBe(0);
    await session.close();
  });

  test("uses a tappable semantic source for an action batch", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("batch-target", "Batch Target");
    session.lastAccessibility = {
      schemaVersion: 1,
      snapshotId: "ax-batch",
      capturedAt: "2026-08-08T10:00:00.000Z",
      source: "core-simulator-ax",
      scope: "interactive",
      screen: { x: 0, y: 0, width: 402, height: 874 },
      root: {
        ref: "ax:root",
        children: [{ ref: "ax:search", identifier: "branch-search", role: "AXButton" }],
      },
      stats: { nodeCount: 2, truncated: false },
    };
    session.lastElements = {
      schemaVersion: 1,
      snapshotId: "rn-batch",
      capturedAt: "2026-08-08T10:00:00.000Z",
      source: "react-native-fiber",
      scope: "interactive",
      screen: { x: 0, y: 0, width: 402, height: 874 },
      root: {
        ref: "rn:root",
        children: [
          {
            ref: "rn:search",
            identifier: "branch-search",
            role: "button",
            interactive: true,
            frame: {
              points: { x: 160, y: 780, width: 80, height: 44 },
              normalized: { x: 0.4, y: 0.89, width: 0.2, height: 0.05 },
            },
          },
        ],
      },
      stats: { nodeCount: 2, truncated: false },
      metro: {
        host: "127.0.0.1",
        port: 8081,
        targetId: "target-1",
        targetTitle: "Branches",
        renderer: "fabric",
      },
    };
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target: { ref: "ax:search", identifier: "branch-search", role: "AXButton" },
        point: { x: 0.5, y: 0.915 },
      }) as never;
    let dispatched: unknown;
    session.dispatchInput = async (input) => {
      dispatched = input;
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "batch-target-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "perform_actions",
        arguments: {
          actions: [{ type: "tap_element", identifier: "branch-search", exact: true }],
          observe: "none",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(dispatched).toEqual({
        method: "input.tap",
        params: { x: 0.5, y: 0.915 },
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("preflights action batches before observation or input", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("batch-preflight", "Batch Preflight");
    let observations = 0;
    let dispatches = 0;
    session.accessibilityObserve = async () => {
      observations += 1;
      throw new Error("preflight must not observe");
    };
    session.dispatchInput = async () => {
      dispatches += 1;
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "batch-preflight-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const duplicate = await client.callTool({
        name: "perform_actions",
        arguments: {
          actions: [
            { type: "tap_element", ref: "ax:generation:merchant" },
            { type: "tap_element", ref: "ax:generation:merchant" },
          ],
          observe: "semantic",
        },
      });
      expect(duplicate.isError).toBe(true);
      expect(duplicate.structuredContent).toMatchObject({
        completedActionCount: 0,
        dispatchedActionCount: 0,
        failedActionIndex: 1,
        receipts: [
          {
            accepted: false,
            safeToContinue: false,
            inputDispatched: false,
            code: "reused_generation_ref",
          },
        ],
      });

      const missingSelector = await client.callTool({
        name: "perform_actions",
        arguments: { actions: [{ type: "tap_element" }], observe: "semantic" },
      });
      expect(missingSelector.isError).toBe(true);
      expect(missingSelector.structuredContent).toMatchObject({
        completedActionCount: 0,
        dispatchedActionCount: 0,
        failedActionIndex: 0,
        receipts: [{ code: "invalid_action", inputDispatched: false }],
      });
      expect(observations).toBe(0);
      expect(dispatches).toBe(0);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("rejects control text and dispatches named key input", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("named-key", "Named Key");
    const dispatched: unknown[] = [];
    session.dispatchInput = async (input) => {
      dispatched.push(input);
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "named-key-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const controlText = await client.callTool({
        name: "type_text",
        arguments: { text: "\b\b" },
      });
      expect(controlText.isError).toBe(true);
      expect(controlText.structuredContent).toMatchObject({
        accepted: false,
        safeToContinue: false,
        inputDispatched: false,
        code: "special_key_requires_press_key",
      });
      const pressed = await client.callTool({
        name: "press_key",
        arguments: { key: "delete", modifiers: ["command"], repeat: 2 },
      });
      expect(pressed.isError).not.toBe(true);
      expect(dispatched).toEqual([
        {
          method: "input.key",
          params: { key: "delete", modifiers: ["command"], repeat: 2 },
        },
      ]);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("targets placeholder-only fields and verifies exact replacement text", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("replace-text", "Replace Text");
    let value = "0.00";
    const field = () => ({
      ref: "ax:amount",
      role: "AXTextField",
      ...(value ? { value } : {}),
      ...(value === "0.00" || value === "" ? { placeholder: "0.00" } : {}),
      enabled: true,
      actions: ["AXPress"],
      frame: {
        points: { x: 20, y: 200, width: 200, height: 44 },
        normalized: { x: 0.05, y: 0.23, width: 0.5, height: 0.05 },
      },
    });
    session.lastAccessibility = interactionSnapshot("replace-before", field() as never);
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target: field(),
        point: { x: 0.3, y: 0.25 },
      }) as never;
    let observations = 0;
    session.accessibilityObserve = async () => {
      observations += 1;
      return {
        snapshot: interactionSnapshot("replace-current", field() as never),
        revision: "2",
        eventChanged: true,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      } as never;
    };
    const dispatched: unknown[] = [];
    session.dispatchInput = async (input) => {
      dispatched.push(input);
      if (input.method === "input.key" && input.params.key === "delete") value = "";
      if (input.method === "input.typeText") value = input.params.text;
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "replace-text-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "replace_text",
        arguments: { placeholder: "0.00", text: "42.80" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        accepted: true,
        safeToContinue: true,
        inputDispatched: true,
        verification: { expectedValue: "42.80", actualValue: "42.80" },
      });
      expect(observations).toBe(1);
      expect(dispatched).toEqual([
        { method: "input.tap", params: { x: 0.3, y: 0.25 } },
        { method: "input.key", params: { key: "select-all" } },
        { method: "input.key", params: { key: "delete" } },
        { method: "input.typeText", params: { text: "42.80" } },
      ]);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("reuses the final verified text snapshot instead of waiting for another batch change", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("verified-text-batch", "Verified Text Batch");
    let value = "0.00";
    const field = () => ({
      ref: `ax:amount:${value}`,
      role: "AXTextField",
      value,
      ...(value === "0.00" ? { placeholder: "0.00" } : {}),
      enabled: true,
      actions: ["AXPress"],
      frame: {
        points: { x: 20, y: 200, width: 200, height: 44 },
        normalized: { x: 0.05, y: 0.23, width: 0.5, height: 0.05 },
      },
    });
    const baseline = interactionSnapshot("verified-text-before", field() as never);
    session.lastAccessibility = baseline;
    let latestObservation: AccessibilityObservation = {
      snapshot: baseline,
      revision: "1",
      eventChanged: false,
      stable: true,
      timedOut: false,
      strategy: "snapshot-diff",
      settledAt: baseline.capturedAt,
      fallbackUsed: false,
      captureCount: 1,
      changeSource: "none",
    };
    Object.defineProperty(session, "accessibilityRevision", {
      get: () => latestObservation.revision,
    });
    Object.defineProperty(session, "latestAccessibilityObservation", {
      get: () => latestObservation,
    });
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target: field(),
        point: { x: 0.3, y: 0.25 },
      }) as never;
    let observations = 0;
    session.accessibilityObserve = async () => {
      observations += 1;
      const snapshot = interactionSnapshot("verified-text-after", field() as never);
      session.lastAccessibility = snapshot;
      latestObservation = {
        snapshot,
        revision: "2",
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy: "snapshot-diff",
        settledAt: snapshot.capturedAt,
        fallbackUsed: false,
        captureCount: 1,
        changeSource: "none",
      };
      return latestObservation as never;
    };
    session.preparedElementSnapshot = async () =>
      ({
        snapshot: session.lastAccessibility,
        screenContext: {
          schemaVersion: 1,
          kind: "native-ios",
          platform: "ios",
          capturedAt: session.lastAccessibility?.capturedAt,
          frameId: "verified-text-frame",
          simulatorName: "Verified Text Batch",
          viewport: { x: 0, y: 0, width: 402, height: 874 },
          orientation: "portrait",
        },
      }) as never;
    session.dispatchInput = async (input) => {
      if (input.method === "input.key" && input.params.key === "delete") value = "";
      if (input.method === "input.typeText") value = input.params.text;
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "verified-text-batch-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "perform_actions",
        arguments: {
          observe: "semantic",
          actions: [{ type: "replace_text", placeholder: "0.00", text: "42.80" }],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        completedActionCount: 1,
        dispatchedActionCount: 1,
        receipts: [
          {
            accepted: true,
            verification: { expectedValue: "42.80", actualValue: "42.80" },
          },
        ],
        observation: {
          sourceRevisions: { accessibility: "2" },
          stability: { stable: true },
          postAction: {
            accessibility: {
              event: "changed",
              semantic: "changed",
              strategy: "snapshot-diff",
              stable: true,
              forcedRetry: false,
              fallbackUsed: false,
              captureCount: 1,
              changeSource: "none",
            },
          },
        },
      });
      expect(observations).toBe(1);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("does not retry dispatched text when post-write target correlation is ambiguous", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("ambiguous-text", "Ambiguous Text");
    const target = {
      ref: "ax:notes-before",
      role: "AXTextField",
      placeholder: "What was this for?",
      value: "",
      enabled: true,
      frame: {
        points: { x: 32, y: 690, width: 338, height: 64 },
        normalized: { x: 0.08, y: 0.79, width: 0.84, height: 0.08 },
      },
    };
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target,
        point: { x: 0.5, y: 0.83 },
      }) as never;
    const postField = (ref: string, x: number) => ({
      ...target,
      ref,
      placeholder: undefined,
      value: "Dinner",
      frame: {
        points: { x: x * 402, y: 690, width: 220, height: 64 },
        normalized: { x, y: 0.79, width: 0.55, height: 0.08 },
      },
    });
    session.accessibilityObserve = async () =>
      ({
        snapshot: interactionSnapshot(
          "ambiguous-current",
          postField("ax:notes-left", 0.05) as never,
          postField("ax:notes-right", 0.45) as never,
        ),
        revision: "2",
        eventChanged: true,
        stable: true,
        timedOut: false,
        strategy: "snapshot-diff",
        settledAt: "2026-08-09T08:00:00.000Z",
      }) as never;
    const dispatched: unknown[] = [];
    session.dispatchInput = async (input) => {
      dispatched.push(input);
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "ambiguous-text-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "perform_actions",
        arguments: {
          observe: "none",
          actions: [{ type: "replace_text", placeholder: "What was this for?", text: "Dinner" }],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        actionCount: 1,
        completedActionCount: 0,
        dispatchedActionCount: 1,
        failedActionIndex: 0,
        receipts: [
          {
            accepted: false,
            safeToContinue: false,
            inputDispatched: true,
            code: "text_replacement_unconfirmed",
            retryable: false,
            retryInput: false,
            retryObservation: true,
          },
        ],
      });
      expect(dispatched).toHaveLength(4);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("hard-stops after one fresh observation cannot confirm post-action stability", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("unstable-post-action", "Unstable Post Action");
    const target = interactionNode("ax:continue", "Continue", 0.3, 0.4);
    let observations = 0;
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target,
        point: { x: 0.4, y: 0.425 },
      }) as never;
    session.accessibilityObserve = async () => {
      observations += 1;
      const baseline = observations === 1;
      return {
        snapshot: interactionSnapshot(baseline ? "before" : `after-${observations}`, target),
        revision: String(observations),
        eventChanged: !baseline,
        stable: baseline,
        timedOut: !baseline,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      } as never;
    };
    session.dispatchInput = async () => ({ accepted: true });
    const server = createServer(session);
    const client = new Client({ name: "unstable-post-action-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: { identifier: "invoice-card", observe: "semantic" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        accepted: false,
        safeToContinue: false,
        inputDispatched: true,
        code: "post_action_unconfirmed",
        retryable: true,
        interaction: { accepted: true },
        observation: {
          stability: { stable: false },
          postAction: { accessibility: { forcedRetry: true, stable: false } },
        },
      });
      expect(observations).toBe(3);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("re-resolves a generation-scoped ref and taps only the fresh native frame", async () => {
    const session = new SimViewSession();
    const oldTarget = interactionNode("ax:old", "Invoice #30363063", 0.1, 0.2);
    const freshTarget = interactionNode("ax:new", "Invoice #30363063", 0.55, 0.6);
    session.lastAccessibility = interactionSnapshot("ax-old", oldTarget);
    const observationRequests: Array<{ afterRevision: string | undefined }> = [];
    session.accessibilityObserve = async (request = {}) => {
      observationRequests.push({ afterRevision: request.afterRevision });
      if (request.afterRevision && !/^\d+$/u.test(request.afterRevision)) {
        throw new Error("Observation revision must be numeric");
      }
      return {
        snapshot: interactionSnapshot("ax-fresh", freshTarget),
        revision: "2",
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      } as never;
    };
    const inspected: Array<{ x: number; y: number }> = [];
    session.inspectPoint = async (x, y) => {
      inspected.push({ x, y });
      return freshTarget;
    };

    const resolution = await session.resolveNativeTap({ ref: oldTarget.ref, exact: true });

    expect(resolution).toMatchObject({
      accepted: true,
      code: "ready",
      discoverySnapshotId: "ax-old",
      interactionSnapshotId: "ax-fresh",
      fingerprint: { identifier: "invoice-card", name: "Invoice #30363063" },
      target: { ref: "ax:new" },
      point: { x: 0.65, y: 0.625 },
      hitTest: true,
    });
    expect(inspected).toEqual([{ x: 0.65, y: 0.625 }]);
    expect(observationRequests).toEqual([{ afterRevision: undefined }, { afterRevision: "2" }]);
  });

  test("re-resolves a native field identified only by its placeholder", async () => {
    const session = new SimViewSession();
    const field = {
      ref: "ax:merchant",
      role: "AXTextField",
      placeholder: "Merchant",
      enabled: true,
      actions: ["AXPress"],
      frame: {
        points: { x: 20, y: 200, width: 200, height: 44 },
        normalized: { x: 0.05, y: 0.23, width: 0.5, height: 0.05 },
      },
    };
    session.lastAccessibility = interactionSnapshot("placeholder-before", field as never);
    session.accessibilityObserve = async () =>
      ({
        snapshot: interactionSnapshot("placeholder-fresh", field as never),
        revision: "2",
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      }) as never;
    session.inspectPoint = async () => field;

    expect(await session.resolveNativeTap({ placeholder: "Merchant", exact: true })).toMatchObject({
      accepted: true,
      fingerprint: { placeholder: "Merchant", role: "AXTextField" },
      target: { ref: "ax:merchant" },
      hitTest: true,
    });
  });

  test("preserves indexed row identity when repeated invoices reorder during refresh", async () => {
    const session = new SimViewSession();
    const oldFirst = interactionNode("ax:old-a", "Invoice #30363063", 0.1, 0.2);
    const oldSecond = interactionNode("ax:old-b", "Invoice #30363506", 0.1, 0.3);
    const freshSecond = interactionNode("ax:new-b", "Invoice #30363506", 0.5, 0.4);
    const freshFirst = interactionNode("ax:new-a", "Invoice #30363063", 0.5, 0.5);
    session.lastAccessibility = interactionSnapshot("ax-before-reorder", oldFirst, oldSecond);
    session.accessibilityObserve = async () =>
      ({
        snapshot: interactionSnapshot("ax-after-reorder", freshSecond, freshFirst),
        revision: "7",
        eventChanged: true,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      }) as never;
    session.inspectPoint = async () => freshSecond;

    const resolution = await session.resolveNativeTap({
      identifier: "invoice-card",
      index: 1,
      exact: true,
    });
    expect(resolution).toMatchObject({
      accepted: true,
      discoverySnapshotId: "ax-before-reorder",
      interactionSnapshotId: "ax-after-reorder",
      fingerprint: { name: "Invoice #30363506" },
      target: { ref: "ax:new-b" },
    });
    expect(resolution.point?.x).toBeCloseTo(0.6);
    expect(resolution.point?.y).toBeCloseTo(0.425);
  });

  test("rejects a freshly offscreen target with scroll guidance before hit-testing", async () => {
    const session = new SimViewSession();
    const oldTarget = interactionNode("ax:old", "Invoice #30363063", 0.1, 0.2);
    const offscreenTarget = interactionNode("ax:new", "Invoice #30363063", 0.55, 1.1);
    session.lastAccessibility = interactionSnapshot("ax-old", oldTarget);
    session.accessibilityObserve = async () =>
      ({
        snapshot: interactionSnapshot("ax-scrolled", offscreenTarget),
        revision: "3",
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      }) as never;
    let inspected = 0;
    session.inspectPoint = async () => {
      inspected += 1;
      return offscreenTarget;
    };

    const resolution = await session.resolveNativeTap({ ref: oldTarget.ref, exact: true });

    expect(resolution).toMatchObject({
      accepted: false,
      code: "target_offscreen",
      retryable: true,
      rawFrame: offscreenTarget.frame,
      scrollRequired: true,
      suggestedScrollDirection: "up",
    });
    expect(inspected).toBe(0);
  });

  test("rejects a native target when the pre-tap hit-test identifies another invoice", async () => {
    const session = new SimViewSession();
    const target = interactionNode("ax:intended", "Invoice #30363063", 0.2, 0.3);
    const other = interactionNode("ax:other", "Invoice #30363506", 0.2, 0.3);
    session.lastAccessibility = interactionSnapshot("ax-old", {
      ...target,
      ref: "ax:old",
    });
    session.accessibilityObserve = async () =>
      ({
        snapshot: interactionSnapshot("ax-fresh", target),
        revision: "4",
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      }) as never;
    session.inspectPoint = async () => other;

    expect(await session.resolveNativeTap({ ref: "ax:old", exact: true })).toMatchObject({
      accepted: false,
      code: "hit_target_mismatch",
      hitTest: false,
      target: { ref: "ax:intended" },
    });
  });

  test("prefers a native query candidate over a higher-scoring Fiber candidate", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("native-query", "Native Query");
    const nativeTarget = interactionNode("ax:branches", "Branches", 0.2, 0.8);
    const fiberTarget = { ...nativeTarget, ref: "rn:branches" };
    session.searchElements = async () =>
      ({
        snapshotId: "ax-search",
        query: {
          query: "Branches",
          actionableOnly: true,
          visibleOnly: true,
          limit: 5,
        },
        matches: [
          {
            element: fiberTarget,
            score: 1,
            matchedFields: ["name"],
            exact: true,
            source: "react-native-fiber",
            snapshotId: "rn-search",
          },
          {
            element: nativeTarget,
            score: 0.8,
            matchedFields: ["name"],
            exact: true,
            source: "core-simulator-ax",
            snapshotId: "ax-search",
          },
        ],
        count: 2,
        total: 2,
        truncated: false,
        sourceTruncated: false,
        excludedExactMatchCount: 0,
        excludedCandidateCount: 0,
        excludedCandidates: [],
        sources: [],
      }) as never;
    let resolvedRef: string | undefined;
    session.resolveNativeTap = async (selector) => {
      resolvedRef = selector.ref;
      return {
        accepted: true,
        code: "ready",
        retryable: false,
        target: nativeTarget,
        point: { x: 0.3, y: 0.825 },
      } as never;
    };
    session.dispatchInput = async () => ({ accepted: true });
    const server = createServer(session);
    const client = new Client({ name: "native-query-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({
        name: "tap_element",
        arguments: { query: "Branches", observe: "none" },
      });
      expect(resolvedRef).toBe("ax:branches");
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("maps a Fiber-only testID to one fresh native node by unique accessible name", async () => {
    const session = new SimViewSession();
    const fiberTarget = {
      ...interactionNode("rn:invoice", "Invoice #30363063", 0.2, 0.3),
      identifier: "fiber-only-invoice",
      role: "button",
      interactive: true,
    };
    const { identifier: _nativeIdentifier, ...nativeTarget } = {
      ...interactionNode("ax:invoice", "Invoice #30363063", 0.4, 0.5),
      role: "AXButton",
    };
    session.lastAccessibility = {
      ...interactionSnapshot("ax-complete"),
      stats: { nodeCount: 1, truncated: false, quality: "complete" },
    };
    session.lastElements = {
      ...interactionSnapshot("rn-source", fiberTarget),
      source: "react-native-fiber",
      metro: {
        host: "127.0.0.1",
        port: 8081,
        targetId: "target-1",
        targetTitle: "Invoice",
        renderer: "fabric",
      },
    };
    session.accessibilityObserve = async () =>
      ({
        snapshot: {
          ...interactionSnapshot("ax-fresh"),
          root: { ref: "ax:root", children: [nativeTarget] },
        },
        revision: "6",
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      }) as never;
    session.inspectPoint = async () => nativeTarget;

    expect(await session.resolveNativeTap({ ref: "rn:invoice", exact: true })).toMatchObject({
      accepted: true,
      discoverySource: "react-native-fiber",
      discoverySnapshotId: "rn-source",
      interactionSource: "core-simulator-ax",
      interactionSnapshotId: "ax-fresh",
      target: { ref: "ax:invoice" },
      corroboratedBy: ["name", "role"],
      point: { x: 0.5, y: 0.525 },
    });
  });

  test("fails closed when Fiber name corroboration is ambiguous or absent", async () => {
    const ambiguousSession = new SimViewSession();
    const fiberTarget = {
      ...interactionNode("rn:invoice", "Invoice", 0.2, 0.3),
      identifier: "fiber-only-invoice",
    };
    const first = interactionNode("ax:first", "Invoice", 0.2, 0.3);
    const second = interactionNode("ax:second", "Invoice", 0.2, 0.4);
    delete (first as Partial<typeof first>).identifier;
    delete (second as Partial<typeof second>).identifier;
    ambiguousSession.lastElements = {
      ...interactionSnapshot("rn-source", fiberTarget),
      source: "react-native-fiber",
      metro: {
        host: "127.0.0.1",
        port: 8081,
        targetId: "target-1",
        targetTitle: "Invoice",
        renderer: "fabric",
      },
    };
    ambiguousSession.accessibilityObserve = async () =>
      ({
        snapshot: interactionSnapshot("ax-fresh", first, second),
        revision: "7",
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      }) as never;
    let inspected = 0;
    ambiguousSession.inspectPoint = async () => {
      inspected += 1;
      return first;
    };
    expect(
      await ambiguousSession.resolveNativeTap({ ref: "rn:invoice", exact: true }),
    ).toMatchObject({ accepted: false, code: "ambiguous_target" });
    expect(inspected).toBe(0);

    const nameLessSession = new SimViewSession();
    nameLessSession.lastElements = {
      ...ambiguousSession.lastElements,
      snapshotId: "rn-nameless",
      root: {
        ref: "rn:root",
        children: [
          {
            ref: "rn:nameless",
            identifier: "fiber-only-id",
            role: "button",
            interactive: true,
          },
        ],
      },
    };
    nameLessSession.accessibilityObserve = ambiguousSession.accessibilityObserve;
    expect(
      await nameLessSession.resolveNativeTap({ ref: "rn:nameless", exact: true }),
    ).toMatchObject({ accepted: false, code: "native_target_unconfirmed" });
  });

  test("reports exact semantic matches excluded because they are offscreen", async () => {
    const session = new SimViewSession();
    const offscreen = interactionNode("ax:pay", "Pay now", 0.2, 1.1);
    session.lastAccessibility = interactionSnapshot("ax-search", offscreen);

    const search = await session.searchElements({
      query: "Pay now",
      actionableOnly: true,
      visibleOnly: true,
      limit: 5,
    });

    expect(search).toMatchObject({
      count: 0,
      total: 0,
      excludedExactMatchCount: 1,
      excludedCandidateCount: 1,
      excludedCandidates: [
        {
          match: { element: { ref: "ax:pay" } },
          reasons: ["visibility"],
          scrollRequired: true,
          suggestedScrollDirection: "up",
        },
      ],
      sources: [
        {
          source: "core-simulator-ax",
          exactMatchCount: 1,
          excludedExactMatchCount: 1,
          excludedExactMatches: { visibility: 1 },
        },
      ],
    });
  });

  test("finds a multi-field overdue invoice under excluded candidates", async () => {
    const session = new SimViewSession();
    const offscreen = {
      ...interactionNode("ax:overdue", "Overdue · Unpaid", 0.2, 1.1),
      identifier: "invoice-card",
    };
    session.lastAccessibility = interactionSnapshot("ax-overdue", offscreen);

    const search = await session.searchElements({
      query: "overdue unpaid invoice",
      actionableOnly: true,
      visibleOnly: true,
      limit: 5,
    });

    expect(search).toMatchObject({
      count: 0,
      total: 0,
      excludedCandidateCount: 1,
      excludedCandidates: [
        {
          match: {
            element: { ref: "ax:overdue" },
          },
          reasons: ["visibility"],
          suggestedScrollDirection: "up",
        },
      ],
    });
    expect(search.excludedCandidates[0]?.match.matchedFields).toEqual(
      expect.arrayContaining(["identifier", "name"]),
    );

    const twoTokenSearch = await session.searchElements({
      query: "overdue invoice",
      actionableOnly: true,
      visibleOnly: true,
      limit: 5,
    });
    expect(twoTokenSearch).toMatchObject({
      count: 0,
      excludedCandidateCount: 1,
      excludedCandidates: [
        {
          match: { element: { ref: "ax:overdue" } },
          reasons: ["visibility"],
          suggestedScrollDirection: "up",
        },
      ],
    });
  });

  test("verifies destination identity and amount using separate native nodes", async () => {
    const session = new SimViewSession();
    const destination = interactionSnapshot(
      "ax-destination",
      interactionNode("ax:invoice", "Invoice #30363063", 0.1, 0.1),
      interactionNode("ax:amount", "£15.13", 0.1, 0.2),
    );
    session.accessibilityObserve = async () =>
      ({
        snapshot: destination,
        revision: "5",
        eventChanged: true,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.075Z",
      }) as never;

    expect(
      await session.verifyNativeDestination({
        identity: { name: "#30363063", exact: false },
        assertions: [{ name: "£15.13", exact: false }],
      }),
    ).toMatchObject({
      status: "matched",
      verified: true,
      checks: [
        { kind: "identity", count: 1 },
        { kind: "assertion", count: 1 },
      ],
    });
    expect(
      await session.verifyNativeDestination({
        identity: { name: "#30363063", exact: false },
        assertions: [{ name: "£99.99", exact: false }],
      }),
    ).toMatchObject({ status: "mismatch", verified: false, checks: [{ count: 1 }, { count: 0 }] });
    expect(
      await session.verifyNativeDestination({
        identity: { value: "£15.13", exact: true },
      }),
    ).toMatchObject({
      status: "mismatch",
      checks: [{ count: 0, suggestions: [{ name: "£15.13", exact: true }] }],
    });
    const composite = await session.verifyNativeDestination({
      identity: { value: "Invoice #30363063 £15.13", exact: false },
    });
    expect(composite.status).toBe("mismatch");
    expect(composite.checks[0]?.suggestions).toEqual(
      expect.arrayContaining([
        { name: "Invoice #30363063", exact: true },
        { name: "£15.13", exact: true },
      ]),
    );
    expect(
      await session.verifyNativeDestination({
        identity: { role: "button", exact: true },
      }),
    ).toMatchObject({
      status: "ambiguous",
      verified: false,
      checks: [{ kind: "identity", count: 2 }],
    });

    const repeatedAmount = interactionSnapshot(
      "ax-repeated-amount",
      interactionNode("ax:invoice", "Invoice #30363063", 0.1, 0.1),
      interactionNode("ax:total", "£15.13", 0.1, 0.2),
      interactionNode("ax:outstanding", "£15.13", 0.1, 0.3),
    );
    session.accessibilityObserve = async () =>
      ({
        snapshot: repeatedAmount,
        revision: "6",
        eventChanged: true,
        stable: true,
        timedOut: false,
        strategy: "ios-axp",
        settledAt: "2026-08-08T10:00:00.150Z",
      }) as never;
    expect(
      await session.verifyNativeDestination({
        identity: { name: "#30363063", exact: false },
        assertions: [{ name: "£15.13", exact: true }],
      }),
    ).toMatchObject({
      status: "matched",
      verified: true,
      checks: [
        { kind: "identity", count: 1 },
        { kind: "assertion", count: 2 },
      ],
    });
  });

  test("returns a hard-stop error after a dispatched standalone tap fails verification", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("verified-tap", "Verified Tap");
    const invoice = interactionNode("ax:invoice", "Invoice #30363063", 0.2, 0.3);
    session.lastAccessibility = interactionSnapshot("ax-before", invoice);
    mockAccessibilityObservation(session, session.lastAccessibility);
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        fingerprint: { identifier: "invoice-card", name: "Invoice #30363063" },
        interactionSnapshotId: "ax-fresh",
        target: invoice,
        point: { x: 0.3, y: 0.325 },
        hitTest: true,
      }) as never;
    session.dispatchInput = async () => ({ accepted: true });
    session.verifyNativeDestination = async () => ({
      status: "mismatch",
      verified: false,
      stable: true,
      snapshotId: "ax-wrong-destination",
      checks: [
        {
          kind: "identity",
          selector: { value: "£15.13", exact: true },
          count: 0,
          suggestions: [{ name: "£15.13", exact: true }],
        },
      ],
    });
    const server = createServer(session);
    const client = new Client({ name: "verified-tap-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: {
          ref: "ax:invoice",
          observe: "none",
          verifyDestination: { identity: { value: "£15.13", exact: true } },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        accepted: false,
        safeToContinue: false,
        code: "destination_mismatch",
        inputDispatched: true,
        retryable: false,
        interaction: {
          accepted: true,
          fingerprint: { name: "Invoice #30363063" },
          interactionSnapshotId: "ax-fresh",
          hitTest: true,
        },
        destinationVerification: {
          snapshotId: "ax-wrong-destination",
          checks: [{ suggestions: [{ name: "£15.13", exact: true }] }],
        },
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("hard-stops a standalone tap when destination verification is ambiguous", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("matched-tap", "Matched Tap");
    const invoice = interactionNode("ax:invoice", "Invoice #30363063", 0.2, 0.3);
    session.lastAccessibility = interactionSnapshot("ax-before", invoice);
    mockAccessibilityObservation(session, session.lastAccessibility);
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        interactionSnapshotId: "ax-fresh",
        target: invoice,
        point: { x: 0.3, y: 0.325 },
        hitTest: true,
      }) as never;
    session.dispatchInput = async () => ({ accepted: true });
    session.verifyNativeDestination = async () => ({
      status: "ambiguous",
      verified: false,
      stable: true,
      snapshotId: "ax-destination",
      checks: [
        {
          kind: "identity",
          selector: { name: "Invoice #30363063", exact: true },
          count: 2,
        },
      ],
    });
    const server = createServer(session);
    const client = new Client({ name: "matched-tap-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: {
          ref: "ax:invoice",
          observe: "none",
          verifyDestination: { identity: { name: "Invoice #30363063", exact: true } },
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toContain(
        "matched multiple native nodes",
      );
      expect(result.structuredContent).toMatchObject({
        accepted: false,
        safeToContinue: false,
        code: "destination_ambiguous",
        retryable: false,
        inputDispatched: true,
        interaction: { accepted: true, interactionSnapshotId: "ax-fresh" },
        destinationVerification: { status: "ambiguous", verified: false },
        verificationWarnings: [expect.stringContaining("distinctive identifier")],
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("treats unavailable destination verification as a retryable hard stop", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("unconfirmed-tap", "Unconfirmed Tap");
    const target = interactionNode("ax:invoice", "Invoice #30363063", 0.2, 0.3);
    session.lastAccessibility = interactionSnapshot("ax-before", target);
    mockAccessibilityObservation(session, session.lastAccessibility);
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target,
        point: { x: 0.3, y: 0.325 },
      }) as never;
    session.dispatchInput = async () => ({ accepted: true });
    session.verifyNativeDestination = async () => ({
      status: "unavailable",
      verified: false,
      stable: false,
      checks: [],
    });
    const server = createServer(session);
    const client = new Client({ name: "unconfirmed-tap-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: {
          ref: "ax:invoice",
          observe: "none",
          verifyDestination: { identity: { name: "Invoice #30363063", exact: true } },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        accepted: false,
        safeToContinue: false,
        code: "destination_unconfirmed",
        inputDispatched: true,
        retryable: true,
        interaction: { accepted: true },
      });
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
  });

  test("stops a batch before a consequential action when destination verification fails", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = new SimViewSession();
    session.device = iosDevice("verified-batch", "Verified Batch");
    const invoice = interactionNode("ax:invoice", "Invoice #30363063", 0.2, 0.3);
    session.lastAccessibility = interactionSnapshot("ax-before", invoice);
    mockAccessibilityObservation(session, session.lastAccessibility);
    session.resolveNativeTap = async () =>
      ({
        accepted: true,
        code: "ready",
        retryable: false,
        target: invoice,
        point: { x: 0.3, y: 0.325 },
      }) as never;
    session.verifyNativeDestination = async () => ({
      status: "mismatch",
      verified: false,
      stable: true,
      checks: [
        {
          kind: "assertion",
          selector: { name: "£15.13", exact: true },
          count: 0,
        },
      ],
    });
    let dispatches = 0;
    session.dispatchInput = async () => {
      dispatches += 1;
      return { accepted: true };
    };
    const server = createServer(session);
    const client = new Client({ name: "verified-batch-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "perform_actions",
        arguments: {
          observe: "none",
          actions: [
            {
              type: "tap_element",
              ref: "ax:invoice",
              verifyDestination: {
                identity: { name: "#30363063", exact: false },
                assertions: [{ name: "£15.13", exact: false }],
              },
            },
            { type: "tap_element", name: "Pay", exact: true },
          ],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        actionCount: 2,
        completedActionCount: 0,
        dispatchedActionCount: 1,
        failedActionIndex: 0,
        receipts: [
          {
            accepted: false,
            code: "destination_mismatch",
            inputDispatched: true,
            safeToContinue: false,
            interaction: { accepted: true },
            destinationVerification: { verified: false },
          },
        ],
      });
      expect(dispatches).toBe(1);
    } finally {
      await Promise.all([client.close(), server.close(), session.close()]);
    }
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
            role: "button",
            interactive: true,
            frame: {
              points: { x: 20, y: 700, width: 100, height: 44 },
              normalized: { x: 0.05, y: 0.75, width: 0.23, height: 0.05 },
            },
            kind: "component",
          },
          {
            ref: "rn:2",
            identifier: "shopping-history",
            label: "Shopping history",
            role: "button",
            interactive: true,
            frame: {
              points: { x: 140, y: 700, width: 160, height: 44 },
              normalized: { x: 0.33, y: 0.75, width: 0.37, height: 0.05 },
            },
          },
        ],
      },
      stats: { nodeCount: 3, truncated: false },
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
    expect(
      await session.searchElements({
        query: "shop",
        actionableOnly: true,
        visibleOnly: true,
        limit: 10,
      }),
    ).toMatchObject({
      count: 2,
      matches: [
        {
          element: { ref: "rn:1" },
          score: 0.92,
          matchedFields: ["identifier", "name"],
          exact: false,
        },
        { element: { ref: "rn:2" } },
      ],
    });
    session.lastAccessibility = {
      schemaVersion: 1,
      snapshotId: "ax-current",
      capturedAt: "2026-07-31T10:00:01.000Z",
      source: "core-simulator-ax",
      scope: "interactive",
      screen: { x: 0, y: 0, width: 430, height: 932 },
      root: {
        ref: "ax:root",
        children: [
          {
            ref: "ax:shop",
            role: "AXButton",
            label: "Shop, tab, 2 of 6",
            enabled: true,
            actions: ["AXPress"],
            frame: {
              points: { x: 20, y: 800, width: 80, height: 44 },
              normalized: { x: 0.05, y: 0.86, width: 0.19, height: 0.05 },
            },
          },
          {
            ref: "ax:category",
            role: "AXButton",
            label: "Landscaping",
            identifier: "shopnavigation-button-category-1362",
            enabled: true,
            actions: ["AXPress"],
            frame: {
              points: { x: 20, y: 700, width: 160, height: 44 },
              normalized: { x: 0.05, y: 0.75, width: 0.37, height: 0.05 },
            },
          },
        ],
      },
      stats: { nodeCount: 2, truncated: false },
    };
    const shopSearch = await session.searchElements({
      query: "Shop",
      actionableOnly: true,
      visibleOnly: true,
      limit: 10,
    });
    expect(shopSearch).toMatchObject({
      snapshotId: "ax-current",
      count: 4,
    });
    expect(shopSearch.matches.map((match) => match.element.ref).sort()).toEqual([
      "ax:category",
      "ax:shop",
      "rn:1",
      "rn:2",
    ]);
    expect(await session.findElements({ name: "Shop", exact: false })).toMatchObject({
      snapshotId: "ax-current",
      count: 1,
      matches: [{ ref: "ax:shop" }],
    });
    expect(await session.findElements({ name: "Shop", exact: true })).toMatchObject({
      snapshotId: "ax-current",
      count: 1,
      matches: [{ ref: "ax:shop" }],
    });
    expect(
      await session.resolveActionableElement({ role: "AXButton", exact: true, index: 1 }),
    ).toMatchObject({
      snapshotId: "ax-current",
      count: 1,
      matches: [{ ref: "ax:category" }],
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

function previewSession(): SimViewSession & { browserOpened: number; relayStarted: number } {
  const session = new SimViewSession() as SimViewSession & {
    browserOpened: number;
    relayStarted: number;
  };
  session.browserOpened = 0;
  session.relayStarted = 0;
  session.client = { connected: true, close: async () => {} } as never;
  session.device = iosDevice("preview-session", "Preview Session");
  session.open = async () => session.state();
  session.enablePreview = async () => {};
  session.startRelay = () => {
    session.relayStarted += 1;
  };
  session.openBrowser = () => {
    session.browserOpened += 1;
  };
  return session;
}

async function callOpenSimView(
  session: SimViewSession,
  capabilities: Record<string, unknown> = {},
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(session, { browserFallbackDelayMs: 0, environment });
  const client = new Client({ name: "simview-test", version: "1.0.0" }, { capabilities } as never);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "open_simview", arguments: {} });
    await Bun.sleep(5);
    return result;
  } finally {
    await Promise.all([client.close(), server.close(), session.close()]);
  }
}

function resourceUri(tools: Awaited<ReturnType<Client["listTools"]>>): string {
  const open = tools.tools.find((tool) => tool.name === "open_simview");
  const meta = open?._meta as { ui?: { resourceUri?: string } } | undefined;
  if (!meta?.ui?.resourceUri) throw new Error("open_simview has no resource URI");
  return meta.ui.resourceUri;
}

function iosDevice(udid: string, name: string) {
  return parseDeviceDescription({ udid, name, state: "Booted", runtime: "iOS" });
}

function resourceSnapshot(snapshotId: string, ref: string, label: string): AccessibilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    capturedAt: "2026-08-08T10:00:00.000Z",
    source: "core-simulator-ax",
    scope: "interactive",
    screen: { x: 0, y: 0, width: 402, height: 874 },
    root: {
      ref: "ax:root",
      children: [
        {
          ref,
          identifier: "continue-button",
          role: "button",
          label,
          enabled: true,
          frame: {
            points: { x: 20, y: 700, width: 120, height: 44 },
            normalized: { x: 0.05, y: 0.8, width: 0.3, height: 0.05 },
          },
        },
      ],
    },
    stats: { nodeCount: 2, truncated: false },
  };
}

function interactionNode(ref: string, label: string, x: number, y: number) {
  return {
    ref,
    identifier: "invoice-card",
    role: "button",
    label,
    enabled: true,
    actions: ["press"],
    frame: {
      points: { x: x * 402, y: y * 874, width: 80.4, height: 43.7 },
      normalized: { x, y, width: 0.2, height: 0.05 },
    },
  };
}

function interactionSnapshot(
  snapshotId: string,
  ...nodes: ReturnType<typeof interactionNode>[]
): AccessibilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    capturedAt: "2026-08-08T10:00:00.000Z",
    source: "core-simulator-ax",
    scope: "interactive",
    screen: { x: 0, y: 0, width: 402, height: 874 },
    root: { ref: "ax:root", children: nodes },
    stats: { nodeCount: nodes.length + 1, truncated: false, quality: "complete" },
  };
}

function mockAccessibilityObservation(
  session: SimViewSession,
  snapshot: AccessibilitySnapshot,
): void {
  session.accessibilityObserve = async () =>
    ({
      snapshot,
      revision: "1",
      eventChanged: false,
      stable: true,
      timedOut: false,
      strategy: "ios-axp",
      settledAt: snapshot.capturedAt,
    }) as never;
}
