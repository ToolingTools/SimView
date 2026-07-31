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
  annotationSchema,
  inspectPointOutputSchema,
  jsonObjectSchema,
  jsonValueSchema,
  normalizedPointSchema,
  previewPacketBatchSchema,
  relayInputSchema,
  type SessionState,
  SIMVIEW_VERSION,
  sessionStateSchema,
  simulatorListSchema,
  uiContextSchema,
} from "@simview/contracts";
import { z } from "zod";
import { resolveAppRoot } from "./app-assets";
import { inlineAppModule } from "./app-html";
import { SimViewSession } from "./session";

const VERSION = process.env.SIMVIEW_RESOURCE_VERSION ?? SIMVIEW_VERSION;

function resourceMetadata(reviewId: string) {
  const resourceUri = `ui://simview/${VERSION}/reviews/${reviewId}/preview.html`;
  return {
    resourceUri,
    openPreview: {
      ui: { resourceUri, visibility: ["model"] as const },
      "openai/outputTemplate": resourceUri,
      "openai/widgetAccessible": true,
    },
    appCallable: {
      ui: { resourceUri, visibility: ["model", "app"] as const },
      "ui/resourceUri": resourceUri,
      "openai/widgetAccessible": true,
    },
    appOnly: {
      ui: { resourceUri, visibility: ["app"] as const },
      "ui/resourceUri": resourceUri,
      "openai/widgetAccessible": true,
    },
  };
}

type ResourceMetadata = ReturnType<typeof resourceMetadata>;

const geometry = z.object({
  kind: z.literal("point"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

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
  snapshot: accessibilitySnapshotSchema,
  accessibilityCapturedAt: z.string(),
  captureDeltaMs: z.number().nonnegative(),
});

export function createServer(session = new SimViewSession()): McpServer {
  const server = new McpServer({ name: "simview", version: VERSION });
  const metadata = resourceMetadata(session.reviewId);

  registerAppTool(
    server,
    "open_simview",
    {
      title: "Open SimView",
      description:
        "Open the interactive preview for an already-connected simulator session. " +
        "Call connect_simulator first and continue only when it succeeds.",
      inputSchema: { udid: z.string().uuid().optional() },
      outputSchema: sessionStateSchema,
      _meta: metadata.openPreview,
    },
    async ({ udid }) => {
      const state = await session.open(udid);
      return toolResult(`SimView is connected to ${state.device?.name}.`, state);
    },
  );

  server.registerTool(
    "connect_simulator",
    {
      title: "Connect simulator",
      description: "Start or select a simulator session without opening the interactive preview.",
      inputSchema: { udid: z.string().uuid().optional() },
      outputSchema: sessionStateSchema,
      _meta: metadata.appCallable,
    },
    async ({ udid }) => {
      const state = await session.open(udid);
      return toolResult(`SimView is connected to ${state.device?.name}.`, state);
    },
  );

  server.registerTool(
    "list_simulators",
    {
      title: "List simulators",
      description: "List local iOS Simulators and their current state.",
      inputSchema: {},
      outputSchema: simulatorListSchema,
      _meta: metadata.appCallable,
    },
    async () => {
      const devices = await import("@simview/client").then(({ SimViewClient }) =>
        SimViewClient.listDevices(),
      );
      return toolResult("Local simulator devices.", { devices });
    },
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
        "Observe the selected simulator as a PNG. Use its pixel positions to choose normalized coordinates for tap, swipe, or long_press, then observe again.",
      inputSchema: {},
      outputSchema: screenshotOutputSchema,
      _meta: metadata.appCallable,
    },
    async () => {
      const screenshot = await session.screenshot();
      return {
        content: [
          {
            type: "image" as const,
            data: Buffer.from(screenshot.bytes).toString("base64"),
            mimeType: "image/png",
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
    },
  );

  server.registerTool(
    "get_simview_state",
    {
      title: "Get SimView state",
      description: "Get the current device, stream, frame, route context, and annotation count.",
      inputSchema: {},
      outputSchema: sessionStateSchema,
      _meta: metadata.appCallable,
    },
    async () => toolResult("Current SimView state.", session.state()),
  );

  server.registerTool(
    "set_orientation",
    {
      title: "Set orientation",
      description: "Rotate the selected simulator to a named orientation.",
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
      const result = session.requireClient().request("device.orientation.set", { orientation });
      return result.then((value) => toolResult("Simulator orientation accepted.", value));
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
            "openai/widgetMinFrameHeight": 0,
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
      description: "Interactive local iOS Simulator preview and review surface.",
    },
    readPreviewResource,
  );

  server.registerResource(
    "SimView review preview",
    new ResourceTemplate(`ui://simview/${VERSION}/reviews/{reviewId}/preview.html`, {
      list: undefined,
    }),
    {
      description: "Interactive local iOS Simulator preview and review surface.",
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

  server.registerTool(
    "observe_screen",
    {
      title: "Observe screen",
      description:
        "Capture the simulator as a PNG and return a compact interactive accessibility tree. Use element selectors for navigation when possible.",
      inputSchema: {},
      outputSchema: observeOutputSchema,
    },
    async () => {
      const frameStarted = new Date();
      const screenshot = await session.screenshot();
      const frameCapturedAt = new Date();
      const snapshot = await session.accessibilitySnapshot("interactive");
      const accessibilityCapturedAt = new Date(snapshot.capturedAt);
      return {
        content: [
          {
            type: "image" as const,
            data: Buffer.from(screenshot.bytes).toString("base64"),
            mimeType: "image/png",
          },
          {
            type: "text" as const,
            text: compactAccessibilityTree(snapshot),
          },
        ],
        structuredContent: {
          frameId: screenshot.frameId,
          frameCapturedAt: frameCapturedAt.toISOString(),
          snapshot,
          accessibilityCapturedAt: snapshot.capturedAt,
          captureDeltaMs: Math.max(0, accessibilityCapturedAt.getTime() - frameStarted.getTime()),
        },
      };
    },
  );

  server.registerTool(
    "get_accessibility_tree",
    {
      title: "Get accessibility tree",
      description:
        "Read the frontmost Simulator accessibility hierarchy without taking another screenshot.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: accessibilitySnapshotSchema,
      _meta: metadata.appCallable,
    },
    async ({ scope, maxNodes }) => {
      const snapshot = await session.accessibilitySnapshot(scope, maxNodes);
      return toolResult(compactAccessibilityTree(snapshot), snapshot);
    },
  );

  server.registerTool(
    "find_elements",
    {
      title: "Find elements",
      description:
        "Find accessible elements by identifier, role, name, value, or a generation-scoped ref.",
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
        "Re-resolve one accessible element, validate it, and physically tap its visible center through simulator HID.",
      inputSchema: selectorSchema,
      outputSchema: z.object({
        selector: accessibilitySelectorSchema,
        element: accessibilityNodeSchema,
        point: normalizedPointSchema,
        receipt: acceptedOutputSchema,
      }),
      _meta: metadata.appCallable,
    },
    async (selector) => {
      const result = await session.findElements(accessibilitySelectorSchema.parse(selector));
      const index = selector.index ?? 0;
      if (result.count !== 1 && selector.index === undefined) {
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
      const receipt = await session.requireClient().request("input.tap", point);
      return toolResult(
        "Physical element tap accepted; observe the screen to verify the outcome.",
        {
          selector,
          element: match,
          point,
          receipt,
        },
      );
    },
  );

  server.registerTool(
    "inspect_point",
    {
      title: "Inspect point",
      description: "Return the deepest accessible element at a normalized simulator coordinate.",
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      },
      outputSchema: inspectPointOutputSchema,
      _meta: metadata.appCallable,
    },
    async ({ x, y }) => {
      const accessibility = await session.inspectPoint(x, y);
      const status = await session.probeStatus();
      const native = status.connected ? await session.probeInspectPoint(x, y) : undefined;
      return toolResult("Element context at the requested point.", {
        element: accessibility,
        native,
        probe: status,
      });
    },
  );

  server.registerTool(
    "get_ui_context",
    {
      title: "Get UI context",
      description:
        "Get the optional UIKit probe status and active scene, window, and controller hierarchy.",
      inputSchema: {},
      outputSchema: uiContextSchema,
      _meta: metadata.appCallable,
    },
    async () => {
      const status = await session.probeStatus();
      const target = status.connected ? undefined : await session.probeTarget();
      const context = status.connected ? await session.probeContext() : undefined;
      return toolResult(
        status.connected
          ? "UIKit probe context."
          : "UIKit probe is not enabled; accessibility remains available.",
        { status, context, target },
      );
    },
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
      _meta: metadata.appCallable,
    },
    async ({ bundleId }) =>
      toolResult(
        "The target app relaunched and connected to the UIKit probe.",
        await session.enableProbe(bundleId),
      ),
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
    const client = session.requireClient();
    const result = await dispatchInput(client, parsed);
    return toolResult("Simulator input accepted.", result);
  };
  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: "Tap a normalized simulator coordinate.",
      inputSchema: { x: z.number().min(0).max(1), y: z.number().min(0).max(1) },
      outputSchema: acceptedOutputSchema,
    },
    ({ x, y }) => input({ method: "input.tap", params: { x, y } }),
  );
  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: "Swipe between normalized simulator coordinates.",
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
      description: "Hold a normalized simulator coordinate.",
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
      description: "Type UTF-8 text using HID keys or the controlled Unicode paste fallback.",
      inputSchema: { text: z.string().max(10_000) },
      outputSchema: acceptedOutputSchema,
    },
    ({ text }) => input({ method: "input.typeText", params: { text } }),
  );
  server.registerTool(
    "press_button",
    {
      title: "Press button",
      description: "Press a supported simulator hardware button.",
      inputSchema: { button: z.enum(["home", "lock", "volume-up", "volume-down", "action"]) },
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

  server.registerTool(
    "simulator_input",
    {
      title: "Send simulator input",
      description:
        "Forward an input event from the embedded SimView app to the selected Simulator.",
      inputSchema: {
        method: z.enum(["input.touch", "input.tap", "input.button", "input.typeText"]),
        params: z.record(z.string(), z.unknown()),
      },
      outputSchema: acceptedOutputSchema,
      _meta: metadata.appOnly,
    },
    async ({ method, params }) => {
      const parsed = relayInputSchema.parse({ method, params });
      const client = session.requireClient();
      const result = await dispatchInput(client, parsed);
      return {
        content: [],
        structuredContent: result,
      };
    },
  );
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
      description: "Add a comment at a normalized point on the current simulator frame.",
      inputSchema: {
        geometry,
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
      _meta: metadata.appCallable,
    },
    async (input) => {
      const annotation = session.addAnnotation(input);
      return toolResult("Added point annotation.", annotation);
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
        geometry: geometry.optional(),
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

async function dispatchInput(
  client: ReturnType<SimViewSession["requireClient"]>,
  input: ReturnType<typeof relayInputSchema.parse>,
): Promise<Record<string, unknown>> {
  switch (input.method) {
    case "input.touch":
      return client.request(input.method, input.params);
    case "input.tap":
      return client.request(input.method, input.params);
    case "input.longPress":
      return client.request(input.method, input.params);
    case "input.swipe":
      return client.request(input.method, input.params);
    case "input.typeText":
      return client.request(input.method, input.params);
    case "input.key":
      return client.request(input.method, input.params);
    case "input.button":
      return client.request(input.method, input.params);
  }
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
