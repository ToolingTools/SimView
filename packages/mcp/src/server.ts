import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { compactAccessibilityTree } from "@simview/client";
import {
  accessibilityNodeSchema,
  accessibilitySelectorSchema,
  accessibilitySnapshotSchema,
  annotationContextSchema,
  annotationGeometrySchema,
  annotationSchema,
  deviceListSchema,
  devicePreparationSchema,
  ELEMENT_TREE_PAGE_RAW_BYTES,
  ELEMENT_TREE_TRANSFER_MAX_BYTES,
  type ElementTreeOutput,
  type ElementTreePage,
  elementSnapshotSchema,
  elementTreeOutputSchema,
  elementTreePageSchema,
  inspectPointOutputSchema,
  installedAppListSchema,
  jsonObjectSchema,
  jsonValueSchema,
  normalizedPointSchema,
  previewPacketBatchSchema,
  relayInputSchema,
  type SessionState,
  SIMVIEW_VERSION,
  saveReviewImagesInputSchema,
  saveReviewImagesOutputSchema,
  screenContextSchema,
  semanticErrorSchema,
  sessionStateSchema,
  simulatorListSchema,
  uiContextSchema,
} from "@simview/contracts";
import { z } from "zod";
import { resolveAppRoot } from "./app-assets";
import { inlineAppModule } from "./app-html";
import { SimViewSession } from "./session";

const VERSION = process.env.SIMVIEW_RESOURCE_VERSION ?? SIMVIEW_VERSION;
const ELEMENT_TREE_TRANSFER_TTL_MS = 30_000;

function resourceMetadata(reviewId: string) {
  const resourceUri = `ui://simview/${VERSION}/reviews/${reviewId}/preview.html`;
  return {
    resourceUri,
    openPreview: {
      ui: { resourceUri, visibility: ["model"] as const },
      "openai/outputTemplate": resourceUri,
      "openai/widgetAccessible": true,
    },
    modelOnly: {
      ui: { visibility: ["model"] as const },
    },
    appOnly: {
      ui: { resourceUri, visibility: ["app"] as const },
      "ui/resourceUri": resourceUri,
      "openai/widgetAccessible": true,
    },
  };
}

type ResourceMetadata = ReturnType<typeof resourceMetadata>;
type ElementTreePageCache = {
  transferId: string;
  deviceId: string | undefined;
  connectionGeneration: number;
  expiresAt: number;
  bytes: Buffer;
  sha256: string;
  cursors: string[];
};

const fallbackMessages = {
  "metro-target-unavailable": "No matching React Native Metro target was found.",
  "metro-fiber-unavailable": "The matching React Native target exposed no Fiber root.",
  "metro-inspection-failed": "React Native inspection failed; retrying can reconnect Hermes.",
} as const;

function compactElementTree(result: ElementTreeOutput): string {
  const context = result.screenContext;
  const summary =
    context.kind === "react-native"
      ? [
          `source=react-native-fiber renderer=${context.renderer}`,
          context.navigationPath?.length
            ? `screen=${context.navigationPath.join(" > ")}`
            : context.route
              ? `screen=${context.route}`
              : undefined,
          context.screenComponent ? `component=${context.screenComponent}` : undefined,
        ]
          .filter(Boolean)
          .join(" ")
      : `source=${result.snapshot.source}${result.fallback ? ` fallback=${result.fallback.reason}` : ""}`;
  const fallback = result.fallback ? fallbackMessages[result.fallback.reason] : undefined;
  return [summary, fallback, compactAccessibilityTree(result.snapshot)].filter(Boolean).join("\n");
}

function elementTreePage(cache: ElementTreePageCache, pageIndex: number): ElementTreePage {
  const pageCount = Math.ceil(cache.bytes.byteLength / ELEMENT_TREE_PAGE_RAW_BYTES);
  if (pageIndex < 0 || pageIndex >= pageCount) {
    throw new Error("Element tree page cursor is invalid or expired");
  }
  const start = pageIndex * ELEMENT_TREE_PAGE_RAW_BYTES;
  const chunk = cache.bytes.subarray(start, start + ELEMENT_TREE_PAGE_RAW_BYTES);
  return {
    schemaVersion: 1 as const,
    transferId: cache.transferId,
    encoding: "base64-json",
    pageIndex,
    pageCount,
    chunk: chunk.toString("base64"),
    chunkBytes: chunk.byteLength,
    totalBytes: cache.bytes.byteLength,
    sha256: cache.sha256,
    ...(pageIndex + 1 < pageCount ? { nextCursor: cache.cursors[pageIndex + 1] } : {}),
  };
}

const acceptedOutputSchema = z.object({ accepted: z.literal(true) }).passthrough();
const genericObjectOutputSchema = z.object({}).catchall(jsonValueSchema);
const findElementsOutputSchema = z.object({
  snapshotId: z.string(),
  selector: accessibilitySelectorSchema,
  matches: z.array(accessibilityNodeSchema),
  count: z.number().int().nonnegative(),
});
const waitOutputSchema = z.object({
  durationMs: z.number().nonnegative(),
  schemaVersion: z.literal(1),
  state: z.enum(["visible", "hidden"]),
  satisfied: z.literal(true),
  count: z.number().int().nonnegative(),
  snapshotId: z.string(),
  matches: z.array(accessibilityNodeSchema),
});
const screenshotOutputSchema = z.object({
  frameId: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const observeOutputSchema = z.object({
  frameId: z.string(),
  frameCapturedAt: z.string(),
  snapshot: accessibilitySnapshotSchema.optional(),
  elements: elementSnapshotSchema.optional(),
  screenContext: screenContextSchema.optional(),
  accessibilityCapturedAt: z.string().optional(),
  elementsCapturedAt: z.string().optional(),
  captureDeltaMs: z.number().nonnegative().optional(),
  fallback: elementTreeOutputSchema.shape.fallback.optional(),
  semanticError: semanticErrorSchema.optional(),
});

export function createServer(session = new SimViewSession()): McpServer {
  const server = new McpServer({ name: "simview", version: VERSION });
  const metadata = resourceMetadata(session.reviewId);
  const connectDevice = async (deviceId?: string, appBundleId?: string) => {
    const state = await session.open(deviceId, {
      ...(appBundleId ? { appBundleId } : {}),
    });
    return toolResult(`SimView is connected to ${state.device?.name}.`, state);
  };
  const listDevices = async () => {
    const devices = await import("@simview/client").then(({ SimViewClient }) =>
      SimViewClient.listDevices(),
    );
    return toolResult("Local devices.", { devices });
  };
  const listSimulators = async () => {
    const devices = await import("@simview/client").then(({ SimViewClient }) =>
      SimViewClient.listDevices(),
    );
    return toolResult("Local simulator and emulator devices.", {
      devices: devices.filter((device) => device.kind !== "physical"),
    });
  };
  const takeScreenshot = async () => {
    const screenshot = await session.screenshot();
    return {
      content: [
        {
          type: "image" as const,
          data: Buffer.from(screenshot.bytes).toString("base64"),
          mimeType: "image/png" as const,
        },
        {
          type: "text" as const,
          text: `Captured frame ${screenshot.frameId} at ${screenshot.width}×${screenshot.height}.`,
        },
      ],
      structuredContent: {
        frameId: screenshot.frameId,
        width: screenshot.width,
        height: screenshot.height,
      },
    };
  };

  registerAppTool(
    server,
    "open_simview",
    {
      title: "Open SimView",
      description:
        "Open the interactive preview for an already-connected device session. " +
        "Call connect_device first and continue only when it succeeds.",
      inputSchema: {
        deviceId: z.string().min(1).optional(),
        udid: z.string().min(1).optional(),
        appBundleId: z.string().min(1).optional(),
      },
      outputSchema: sessionStateSchema,
      _meta: metadata.openPreview,
    },
    ({ deviceId, udid, appBundleId }) => connectDevice(deviceId ?? udid, appBundleId),
  );

  server.registerTool(
    "connect_device",
    {
      title: "Connect device",
      description: "Start or select a device session without opening the interactive preview.",
      inputSchema: {
        deviceId: z.string().min(1).optional(),
        appBundleId: z.string().min(1).optional(),
      },
      outputSchema: sessionStateSchema,
      _meta: metadata.modelOnly,
    },
    ({ deviceId, appBundleId }) => connectDevice(deviceId, appBundleId),
  );

  server.registerTool(
    "app_connect_device",
    {
      title: "Switch device",
      description: "Switch the device used by the open SimView preview.",
      inputSchema: {
        deviceId: z.string().min(1).optional(),
        appBundleId: z.string().min(1).optional(),
      },
      outputSchema: sessionStateSchema,
      _meta: metadata.appOnly,
    },
    ({ deviceId, appBundleId }) => connectDevice(deviceId, appBundleId),
  );

  server.registerTool(
    "connect_simulator",
    {
      title: "Connect simulator",
      description: "Start or select a simulator session without opening the interactive preview.",
      inputSchema: { udid: z.string().min(1).optional() },
      outputSchema: sessionStateSchema,
      _meta: metadata.modelOnly,
    },
    ({ udid }) => connectDevice(udid),
  );

  server.registerTool(
    "app_connect_simulator",
    {
      title: "Switch simulator",
      description: "Switch the Simulator used by the open SimView preview.",
      inputSchema: { udid: z.string().min(1).optional() },
      outputSchema: sessionStateSchema,
      _meta: metadata.appOnly,
    },
    ({ udid }) => connectDevice(udid),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "List local iOS Simulators, physical iOS devices, and Android devices.",
      inputSchema: {},
      outputSchema: deviceListSchema,
      _meta: metadata.modelOnly,
    },
    listDevices,
  );

  server.registerTool(
    "app_list_devices",
    {
      title: "List devices",
      description: "List devices available to the open SimView preview.",
      inputSchema: {},
      outputSchema: deviceListSchema,
      _meta: metadata.appOnly,
    },
    listDevices,
  );

  server.registerTool(
    "list_simulators",
    {
      title: "List simulators",
      description: "Compatibility tool listing local iOS Simulators and Android emulators.",
      inputSchema: {},
      outputSchema: simulatorListSchema,
      _meta: metadata.modelOnly,
    },
    listSimulators,
  );

  server.registerTool(
    "app_list_simulators",
    {
      title: "List simulators",
      description: "Compatibility tool listing iOS Simulators and Android emulators.",
      inputSchema: {},
      outputSchema: simulatorListSchema,
      _meta: metadata.appOnly,
    },
    listSimulators,
  );

  server.registerTool(
    "prepare_device",
    {
      title: "Prepare physical iOS device",
      description:
        "Build, sign, install, and verify SimView's owned XCTest runner for a physical iOS device.",
      inputSchema: {
        deviceId: z.string().min(1),
        team: z.string().min(1).optional(),
      },
      outputSchema: devicePreparationSchema,
      _meta: metadata.modelOnly,
    },
    async ({ deviceId, team }) => {
      const result = await session.prepareDevice(deviceId, team);
      return toolResult(
        result.ready
          ? "Physical iOS device is ready."
          : (result.message ?? "Physical iOS device requires preparation."),
        result,
      );
    },
  );

  const listApps = async (deviceId?: string) => {
    const result = await session.installedApps(deviceId);
    return toolResult(`Installed apps on ${result.deviceId}.`, result);
  };
  server.registerTool(
    "list_apps",
    {
      title: "List installed apps",
      description: "List launchable apps available for SimView to target on a physical iOS device.",
      inputSchema: { deviceId: z.string().min(1).optional() },
      outputSchema: installedAppListSchema,
      _meta: metadata.modelOnly,
    },
    ({ deviceId }) => listApps(deviceId),
  );
  server.registerTool(
    "app_list_apps",
    {
      title: "List installed apps",
      description: "List target apps for the selected physical iOS device.",
      inputSchema: {},
      outputSchema: installedAppListSchema,
      _meta: metadata.appOnly,
    },
    () => listApps(),
  );

  const selectApp = async (appBundleId: string) => {
    const state = await session.selectApp(appBundleId);
    return toolResult(`SimView now targets ${appBundleId}.`, state);
  };
  server.registerTool(
    "select_app",
    {
      title: "Select target app",
      description: "Select the app controlled and inspected on the connected physical iOS device.",
      inputSchema: { appBundleId: z.string().min(1) },
      outputSchema: sessionStateSchema,
      _meta: metadata.modelOnly,
    },
    ({ appBundleId }) => selectApp(appBundleId),
  );
  server.registerTool(
    "app_select_app",
    {
      title: "Select target app",
      description: "Switch the app targeted by the open physical iOS preview.",
      inputSchema: { appBundleId: z.string().min(1) },
      outputSchema: sessionStateSchema,
      _meta: metadata.appOnly,
    },
    ({ appBundleId }) => selectApp(appBundleId),
  );

  registerInputTools(server, session);
  registerAppBridgeTools(server, session, metadata);
  registerAccessibilityTools(server, session, metadata);
  registerAnnotationTools(server, session, metadata);

  server.registerTool(
    "take_screenshot",
    {
      title: "Take screenshot",
      description:
        "Observe the selected device as a PNG. Use its pixel positions to choose normalized coordinates for tap, swipe, or long_press, then observe again.",
      inputSchema: {},
      outputSchema: screenshotOutputSchema,
      _meta: metadata.modelOnly,
    },
    takeScreenshot,
  );

  server.registerTool(
    "app_take_screenshot",
    {
      title: "Capture preview screenshot",
      description: "Capture a screenshot from the open SimView preview.",
      inputSchema: {},
      outputSchema: screenshotOutputSchema,
      _meta: metadata.appOnly,
    },
    takeScreenshot,
  );

  server.registerTool(
    "get_simview_state",
    {
      title: "Get SimView state",
      description: "Get the current device, stream, frame, route context, and annotation count.",
      inputSchema: {},
      outputSchema: sessionStateSchema,
      _meta: metadata.modelOnly,
    },
    async () => toolResult("Current SimView state.", session.state()),
  );

  server.registerTool(
    "set_orientation",
    {
      title: "Set orientation",
      description: "Rotate the selected device when its capabilities allow orientation changes.",
      inputSchema: {
        orientation: z.enum([
          "portrait",
          "portrait-upside-down",
          "landscape-left",
          "landscape-right",
        ]),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ orientation }) => {
      session.requireCapability("orientation", "Orientation changes");
      const result = session.requireClient().request("device.orientation.set", { orientation });
      return result.then((value) => toolResult("Device orientation accepted.", value));
    },
  );

  const readPreviewResource = async (uri = new URL(metadata.resourceUri)) => {
    const html = await appHtml(session.state());
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            "openai/widgetMinFrameHeight": 600,
            "openai/widgetPrefersBorder": false,
          },
        },
      ],
    };
  };

  registerAppResource(
    server,
    "SimView preview",
    metadata.resourceUri,
    {
      description: "Interactive local iOS or Android device preview and review surface.",
    },
    readPreviewResource,
  );

  server.registerResource(
    "SimView review preview",
    new ResourceTemplate(`ui://simview/${VERSION}/reviews/{reviewId}/preview.html`, {
      list: undefined,
    }),
    {
      description: "Interactive local iOS or Android device preview and review surface.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri, variables) => {
      z.string().uuid().parse(variables.reviewId);
      return readPreviewResource(uri);
    },
  );

  return server;
}

function registerAccessibilityTools(
  server: McpServer,
  session: SimViewSession,
  metadata: ResourceMetadata,
): void {
  const selectorSchema = {
    ref: z.string().optional(),
    identifier: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    exact: z.boolean().default(true),
    index: z.number().int().min(0).optional(),
  };
  const getAccessibilityTree = async (
    scope: "interactive" | "visible" | "full",
    maxNodes: number,
  ) => {
    const snapshot = await session.accessibilitySnapshot(scope, maxNodes);
    return toolResult(compactAccessibilityTree(snapshot), snapshot);
  };
  const getElementTree = async (scope: "interactive" | "visible" | "full", maxNodes: number) => {
    const result = await session.elementSnapshot(scope, maxNodes);
    return toolResult(compactElementTree(result), result);
  };
  let pageCache: ElementTreePageCache | undefined;
  server.registerTool(
    "app_get_element_tree_page",
    {
      title: "Get preview element tree page",
      description:
        "Read one bounded page of the React Native Fiber or accessibility hierarchy for the open SimView preview.",
      inputSchema: {
        action: z.enum(["start", "continue"]),
        source: z.enum(["elements", "accessibility"]).optional(),
        scope: z.enum(["interactive", "visible", "full"]).optional(),
        maxNodes: z.number().int().min(1).max(5_000).optional(),
        cursor: z.string().max(128).optional(),
      },
      outputSchema: elementTreePageSchema,
      _meta: metadata.appOnly,
    },
    async ({ action, source, scope, maxNodes, cursor }) => {
      let pageIndex = 0;
      if (action === "continue") {
        if (!cursor || source || scope || maxNodes !== undefined) {
          throw new Error("Continuing an element tree transfer requires only its cursor");
        }
        if (
          !pageCache ||
          Date.now() >= pageCache.expiresAt ||
          pageCache.deviceId !== session.device?.id ||
          pageCache.connectionGeneration !== session.connectionGeneration
        ) {
          pageCache = undefined;
          throw new Error("Element tree page cursor is invalid or expired");
        }
        pageIndex = pageCache.cursors.indexOf(cursor);
        if (pageIndex <= 0) throw new Error("Element tree page cursor is invalid or expired");
      } else {
        if (cursor) throw new Error("Starting an element tree transfer does not accept a cursor");
        const captureScope = scope ?? "full";
        const nodeLimit = maxNodes ?? 1_200;
        const result =
          source === "accessibility"
            ? await session.accessibilityElementSnapshot(captureScope, nodeLimit)
            : await session.elementSnapshot(captureScope, nodeLimit);
        const validated = elementTreeOutputSchema.parse(result);
        const bytes = Buffer.from(JSON.stringify(validated), "utf8");
        if (bytes.byteLength > ELEMENT_TREE_TRANSFER_MAX_BYTES) {
          throw new Error(
            `Element tree is ${bytes.byteLength} bytes; the preview limit is ${ELEMENT_TREE_TRANSFER_MAX_BYTES}`,
          );
        }
        const pageCount = Math.ceil(bytes.byteLength / ELEMENT_TREE_PAGE_RAW_BYTES);
        pageCache = {
          transferId: randomUUID(),
          deviceId: session.device?.id,
          connectionGeneration: session.connectionGeneration,
          expiresAt: Date.now() + ELEMENT_TREE_TRANSFER_TTL_MS,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          cursors: Array.from({ length: pageCount }, () => randomBytes(32).toString("base64url")),
        };
      }
      if (!pageCache) throw new Error("Element tree page cache is unavailable");
      const page = elementTreePage(pageCache, pageIndex);
      return toolResult(
        `Element tree transfer page ${page.pageIndex + 1} of ${page.pageCount}.`,
        page,
      );
    },
  );
  const tapElement = async (selector: unknown) => {
    const parsedSelector = accessibilitySelectorSchema.parse(selector);
    const result = await session.findElements(parsedSelector);
    const index = parsedSelector.index ?? 0;
    if (result.count !== 1 && parsedSelector.index === undefined) {
      throw new Error(
        `Selector matched ${result.count} elements; refine the selector or pass index`,
      );
    }
    const match = result.matches[index];
    const frame = match?.frame?.normalized;
    if (!match) throw new Error("The selected element does not exist");
    if (match.enabled === false) throw new Error("The selected element is disabled");
    if (!frame || frame.width <= 0 || frame.height <= 0) {
      throw new Error("The selected element has no visible frame");
    }
    const point = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    if (!session.device?.capabilities.input.touch) {
      throw new Error("Tap is not supported by the selected device");
    }
    const receipt = await session.requireClient().request("input.tap", point);
    return toolResult("Physical element tap accepted; observe the screen to verify the outcome.", {
      selector: parsedSelector,
      element: match,
      point,
      receipt,
    });
  };
  const inspectPoint = async (x: number, y: number) => {
    const accessibility = await session.inspectPoint(x, y);
    const status = session.device?.capabilities.uikitProbe
      ? await session.probeStatus()
      : undefined;
    const native = status?.connected ? await session.probeInspectPoint(x, y) : undefined;
    return toolResult("Element context at the requested point.", {
      element: accessibility,
      native,
      probe: status,
    });
  };
  const getUiContext = async () => {
    session.requireCapability("uikitProbe", "UIKit probe");
    const status = await session.probeStatus();
    const target = status.connected ? undefined : await session.probeTarget();
    const context = status.connected ? await session.probeContext() : undefined;
    return toolResult(
      status.connected
        ? "UIKit probe context."
        : "UIKit probe is not enabled; accessibility remains available.",
      { status, context, target },
    );
  };
  const enableUiProbe = async (bundleId: string) =>
    toolResult(
      "The target app relaunched and connected to the UIKit probe.",
      await session.enableProbe(bundleId),
    );

  server.registerTool(
    "observe_screen",
    {
      title: "Observe screen",
      description:
        "Capture the selected device as a PNG and return semantic context when available. The screenshot is still returned when semantic inspection fails.",
      inputSchema: {},
      outputSchema: observeOutputSchema,
    },
    async () => {
      const frameStarted = new Date();
      const screenshot = await session.screenshot();
      const frameCapturedAt = new Date();
      try {
        const result = await session.elementSnapshot("interactive");
        const snapshot = session.lastAccessibility;
        if (!snapshot) throw new Error("Semantic fallback was not captured");
        const accessibilityCapturedAt = new Date(snapshot.capturedAt);
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(screenshot.bytes).toString("base64"),
              mimeType: "image/png",
            },
            { type: "text" as const, text: compactElementTree(result) },
          ],
          structuredContent: {
            frameId: screenshot.frameId,
            frameCapturedAt: frameCapturedAt.toISOString(),
            snapshot,
            elements: result.snapshot,
            screenContext: result.screenContext,
            accessibilityCapturedAt: snapshot.capturedAt,
            elementsCapturedAt: result.snapshot.capturedAt,
            captureDeltaMs: Math.max(0, accessibilityCapturedAt.getTime() - frameStarted.getTime()),
            fallback: result.fallback,
          },
        };
      } catch (error) {
        const semanticError = {
          code: "semantic_inspection_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        };
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(screenshot.bytes).toString("base64"),
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text: `Semantic inspection unavailable: ${semanticError.message}`,
            },
          ],
          structuredContent: {
            frameId: screenshot.frameId,
            frameCapturedAt: frameCapturedAt.toISOString(),
            semanticError,
          },
        };
      }
    },
  );

  server.registerTool(
    "get_element_tree",
    {
      title: "Get element tree",
      description:
        "Read the React Native visual Fiber tree when a matching Metro target is available, otherwise return the native device accessibility tree.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: elementTreeOutputSchema,
      _meta: metadata.modelOnly,
    },
    ({ scope, maxNodes }) => getElementTree(scope, maxNodes),
  );

  server.registerTool(
    "app_get_element_tree",
    {
      title: "Get preview element tree",
      description:
        "Read the React Native Fiber or accessibility hierarchy for the open SimView preview.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: elementTreeOutputSchema,
      _meta: metadata.appOnly,
    },
    ({ scope, maxNodes }) => getElementTree(scope, maxNodes),
  );

  server.registerTool(
    "get_accessibility_tree",
    {
      title: "Get accessibility tree",
      description:
        "Read the selected device accessibility hierarchy without taking another screenshot.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: accessibilitySnapshotSchema,
      _meta: metadata.modelOnly,
    },
    ({ scope, maxNodes }) => getAccessibilityTree(scope, maxNodes),
  );

  server.registerTool(
    "app_get_accessibility_tree",
    {
      title: "Get preview accessibility tree",
      description: "Read the accessibility hierarchy for the open SimView preview.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: accessibilitySnapshotSchema,
      _meta: metadata.appOnly,
    },
    ({ scope, maxNodes }) => getAccessibilityTree(scope, maxNodes),
  );

  server.registerTool(
    "find_elements",
    {
      title: "Find elements",
      description:
        "Find React Native or accessible elements by identifier, role, name, value, or a generation-scoped ref.",
      inputSchema: selectorSchema,
      outputSchema: findElementsOutputSchema,
    },
    async (selector) => {
      const result = await session.findElements(accessibilitySelectorSchema.parse(selector));
      return toolResult(`Matched ${result.count} accessible element(s).`, result);
    },
  );

  server.registerTool(
    "tap_element",
    {
      title: "Tap element",
      description:
        "Re-resolve one React Native or accessible element, validate it, and physically tap its visible center through device input.",
      inputSchema: selectorSchema,
      outputSchema: z.object({
        selector: accessibilitySelectorSchema,
        element: accessibilityNodeSchema,
        point: normalizedPointSchema,
        receipt: acceptedOutputSchema,
      }),
      _meta: metadata.modelOnly,
    },
    tapElement,
  );

  server.registerTool(
    "app_tap_element",
    {
      title: "Tap preview element",
      description: "Re-resolve and physically tap an element selected in the open preview.",
      inputSchema: selectorSchema,
      outputSchema: z.object({
        selector: accessibilitySelectorSchema,
        element: accessibilityNodeSchema,
        point: normalizedPointSchema,
        receipt: acceptedOutputSchema,
      }),
      _meta: metadata.appOnly,
    },
    tapElement,
  );

  server.registerTool(
    "inspect_point",
    {
      title: "Inspect point",
      description: "Return the deepest accessible element at a normalized device coordinate.",
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      },
      outputSchema: inspectPointOutputSchema,
      _meta: metadata.modelOnly,
    },
    ({ x, y }) => inspectPoint(x, y),
  );

  server.registerTool(
    "app_inspect_point",
    {
      title: "Inspect preview point",
      description: "Return element context at a point selected in the open preview.",
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      },
      outputSchema: inspectPointOutputSchema,
      _meta: metadata.appOnly,
    },
    ({ x, y }) => inspectPoint(x, y),
  );

  server.registerTool(
    "get_ui_context",
    {
      title: "Get UI context",
      description:
        "Get the optional UIKit probe status and active scene, window, and controller hierarchy.",
      inputSchema: {},
      outputSchema: uiContextSchema,
      _meta: metadata.modelOnly,
    },
    getUiContext,
  );

  server.registerTool(
    "app_get_ui_context",
    {
      title: "Get preview UI context",
      description: "Get optional UIKit probe context for the open preview.",
      inputSchema: {},
      outputSchema: uiContextSchema,
      _meta: metadata.appOnly,
    },
    getUiContext,
  );

  server.registerTool(
    "enable_ui_probe",
    {
      title: "Enable UIKit probe",
      description:
        "Explicitly terminate and relaunch one third-party Simulator app with SimView's bundled read-only UIKit probe.",
      inputSchema: {
        bundleId: z
          .string()
          .min(3)
          .max(255)
          .refine((value) => !value.startsWith("com.apple."), {
            message: "Apple platform applications cannot load the UIKit probe",
          }),
      },
      outputSchema: genericObjectOutputSchema,
      _meta: metadata.modelOnly,
    },
    ({ bundleId }) => enableUiProbe(bundleId),
  );

  server.registerTool(
    "app_enable_ui_probe",
    {
      title: "Enable preview UIKit probe",
      description: "Enable the optional UIKit probe from the open preview.",
      inputSchema: {
        bundleId: z
          .string()
          .min(3)
          .max(255)
          .refine((value) => !value.startsWith("com.apple."), {
            message: "Apple platform applications cannot load the UIKit probe",
          }),
      },
      outputSchema: genericObjectOutputSchema,
      _meta: metadata.appOnly,
    },
    ({ bundleId }) => enableUiProbe(bundleId),
  );

  server.registerTool(
    "wait_for_element",
    {
      title: "Wait for element",
      description: "Wait for a semantic element to appear or disappear without model-side polling.",
      inputSchema: {
        ...selectorSchema,
        state: z.enum(["visible", "hidden"]).default("visible"),
        timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
      },
      outputSchema: waitOutputSchema,
    },
    async ({ state, timeoutMs, ...selector }) => {
      const started = performance.now();
      const parsedSelector = accessibilitySelectorSchema.parse(selector);
      const result = await session.requireClient().request("accessibility.wait", {
        deviceId: session.device?.id,
        udid: session.device?.udid,
        selector: parsedSelector,
        state,
        timeoutMs,
      });
      return toolResult(`Element is ${state}.`, {
        durationMs: performance.now() - started,
        ...result,
      });
    },
  );
}

function registerInputTools(server: McpServer, session: SimViewSession): void {
  const input = async (value: unknown) => {
    const parsed = relayInputSchema.parse(value);
    const result = await session.dispatchInput(parsed);
    return toolResult("Device input accepted.", result);
  };
  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: "Tap a normalized device coordinate.",
      inputSchema: { x: z.number().min(0).max(1), y: z.number().min(0).max(1) },
      outputSchema: acceptedOutputSchema,
    },
    ({ x, y }) => input({ method: "input.tap", params: { x, y } }),
  );
  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: "Swipe between normalized device coordinates.",
      inputSchema: {
        from: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
        to: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
        durationMs: z.number().int().min(50).max(10_000).default(350),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ from, to, durationMs }) =>
      input({ method: "input.swipe", params: { from, to, durationMs } }),
  );
  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description: "Hold a normalized device coordinate.",
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        durationMs: z.number().int().min(100).max(10_000).default(600),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ x, y, durationMs }) => input({ method: "input.longPress", params: { x, y, durationMs } }),
  );
  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Type text at the selected device's declared ASCII or Unicode capability level.",
      inputSchema: { text: z.string().max(10_000) },
      outputSchema: acceptedOutputSchema,
    },
    ({ text }) => input({ method: "input.typeText", params: { text } }),
  );
  server.registerTool(
    "press_button",
    {
      title: "Press button",
      description: "Press a supported device hardware or navigation button.",
      inputSchema: {
        button: z.enum(["home", "back", "overview", "lock", "volume-up", "volume-down", "action"]),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ button }) => input({ method: "input.button", params: { button } }),
  );
}

function registerAppBridgeTools(
  server: McpServer,
  session: SimViewSession,
  metadata: ResourceMetadata,
): void {
  server.registerTool(
    "save_review_images",
    {
      title: "Save review images",
      description:
        "Persist the frozen frame and annotation crops in a session-owned temporary directory.",
      inputSchema: saveReviewImagesInputSchema,
      outputSchema: saveReviewImagesOutputSchema,
      _meta: metadata.appOnly,
    },
    async (input) => ({
      content: [],
      structuredContent: await session.saveReviewImages(input),
    }),
  );

  server.registerTool(
    "get_preview_packets",
    {
      title: "Read preview packets",
      description: "Read a bounded batch of H.264 preview packets for the embedded SimView app.",
      inputSchema: {
        afterSequence: z.number().int().min(0).optional(),
        maxPackets: z.number().int().min(1).max(30).default(12),
        timeoutMs: z.number().int().min(50).max(5_000).default(1_500),
      },
      outputSchema: previewPacketBatchSchema,
      _meta: metadata.appOnly,
    },
    async ({ afterSequence, maxPackets, timeoutMs }) => {
      const batch = await session.previewPackets(afterSequence, maxPackets, timeoutMs);
      return {
        content: [],
        structuredContent: {
          reset: batch.reset,
          configuration: batch.configuration
            ? Buffer.from(batch.configuration).toString("base64")
            : undefined,
          packets: batch.packets.map((packet) => ({
            sequence: packet.sequence,
            kind: packet.kind,
            data: Buffer.from(packet.payload).toString("base64"),
          })),
          nextSequence: batch.nextSequence,
        },
      };
    },
  );

  const registerDeviceInput = (name: "device_input" | "simulator_input", legacy: boolean) =>
    server.registerTool(
      name,
      {
        title: legacy ? "Send simulator input" : "Send device input",
        description: legacy
          ? "Compatibility alias for device_input."
          : "Forward an input event from the embedded SimView app to the selected device.",
        inputSchema: {
          method: z.enum([
            "input.touch",
            "input.tap",
            "input.longPress",
            "input.swipe",
            "input.button",
            "input.typeText",
          ]),
          params: z.record(z.string(), z.unknown()),
        },
        outputSchema: acceptedOutputSchema,
        _meta: metadata.appOnly,
      },
      async ({ method, params }) => {
        const parsed = relayInputSchema.parse({ method, params });
        const result = await session.dispatchInput(parsed);
        return {
          content: [],
          structuredContent: result,
        };
      },
    );
  registerDeviceInput("device_input", false);
  registerDeviceInput("simulator_input", true);
}

function registerAnnotationTools(
  server: McpServer,
  session: SimViewSession,
  metadata: ResourceMetadata,
): void {
  server.registerTool(
    "add_annotation",
    {
      title: "Add annotation",
      description:
        "Add a comment at a normalized point or rectangular region on the current simulator frame.",
      inputSchema: {
        geometry: annotationGeometrySchema,
        note: z.string().min(1).max(2_000),
        frameId: z.string().optional(),
        route: z.string().optional(),
        component: z
          .object({
            testID: z.string().optional(),
            label: z.string().optional(),
            source: z.string().optional(),
          })
          .optional(),
        context: annotationContextSchema.optional(),
      },
      outputSchema: annotationSchema,
      _meta: metadata.modelOnly,
    },
    async (input) => {
      const annotation = session.addAnnotation(input);
      return toolResult("Added screen annotation.", annotation);
    },
  );

  server.registerTool(
    "update_annotation",
    {
      title: "Update annotation",
      description: "Edit an existing annotation in the current review.",
      inputSchema: {
        id: z.string().uuid(),
        note: z.string().min(1).max(2_000).optional(),
        geometry: annotationGeometrySchema.optional(),
      },
      outputSchema: annotationSchema,
      _meta: metadata.appOnly,
    },
    async ({ id, ...patch }) =>
      toolResult("Annotation updated.", session.updateAnnotation(id, patch)),
  );

  server.registerTool(
    "delete_annotation",
    {
      title: "Delete annotation",
      description: "Delete an annotation from the current review.",
      inputSchema: { id: z.string().uuid() },
      outputSchema: z.object({ deleted: z.boolean(), id: z.string().uuid() }),
      _meta: metadata.appOnly,
    },
    async ({ id }) =>
      toolResult("Annotation deleted.", { deleted: session.deleteAnnotation(id), id }),
  );
}

async function appHtml(initialState: SessionState): Promise<string> {
  const root = resolveAppRoot();
  const templatePath = join(root, "dist", "preview.html");
  const scriptPath = join(root, "dist", "preview.js");
  const [template, script] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(scriptPath, "utf8"),
  ]);
  return inlineAppModule(template, script, initialState);
}

function toolResult(text: string, structuredContent: unknown) {
  const json = jsonObjectSchema.parse(JSON.parse(JSON.stringify(structuredContent)));
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: json,
  };
}

export async function runServer(session = new SimViewSession()): Promise<void> {
  const server = createServer(session);
  const transport = new StdioServerTransport();
  const parentPID = process.ppid;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      clearInterval(parentWatchdog);
      process.stdin.off("end", shutdown);
      process.stdin.off("close", shutdown);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      process.off("disconnect", shutdown);
      await session.close().catch(() => {});
      await server.close().catch(() => {});
      await transport.close().catch(() => {});
    })();
    return shutdownPromise;
  };
  const parentWatchdog = setInterval(() => {
    if (parentPID <= 1) {
      void shutdown();
      return;
    }
    try {
      process.kill(parentPID, 0);
    } catch {
      void shutdown();
    }
  }, 2_000);
  parentWatchdog.unref();
  transport.onclose = () => void shutdown();
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("disconnect", shutdown);
  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown();
    throw error;
  }
}
