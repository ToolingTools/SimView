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
import { SimViewSession } from "../packages/mcp/src/session";

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
    session.preparedElementSnapshot = async () => ({
      snapshot,
      screenContext: {
        schemaVersion: 1,
        kind: "uikit",
        platform: "ios",
        capturedAt: snapshot.capturedAt,
        frameId: "frame-1",
        simulatorName: "iPhone 17 Pro",
        viewport: { x: 0, y: 0, width: 402, height: 874 },
        orientation: "portrait",
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
    session.resolveActionableElement = async (selector) =>
      ({ snapshotId: "ax-1", selector, matches: [element], count: 1 }) as never;
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
        kind: "uikit",
        platform: "ios",
        capturedAt: snapshot.capturedAt,
        frameId: "frame-observed",
        simulatorName: "Observed Tap",
        viewport: { x: 0, y: 0, width: 402, height: 874 },
        orientation: "portrait",
      },
    });
    session.dispatchInput = async () => ({ accepted: true });
    const server = createServer(session);
    const client = new Client({ name: "observed-tap-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "tap_element",
        arguments: { ref: element.ref, observe: "semantic" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        receipt: { accepted: true },
        observation: {
          frameId: "frame-observed",
          semantic: { status: "full", nodeCount: 2 },
          vision: { included: false, returnedBytes: 0 },
        },
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
    session.resolveActionableElement = async (selector) =>
      ({ snapshotId: "ax-ranked", selector, matches: [target], count: 1 }) as never;
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
          kind: "uikit",
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
    expect(
      await session.searchElements({
        query: "Shop",
        actionableOnly: true,
        visibleOnly: true,
        limit: 10,
      }),
    ).toMatchObject({
      snapshotId: "ax-current",
      count: 2,
      matches: [
        { element: { ref: "ax:shop" }, score: 0.92, exact: false },
        { element: { ref: "ax:category" }, score: 0.874, exact: false },
      ],
    });
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
