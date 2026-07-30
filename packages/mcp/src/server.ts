import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  compactAccessibilityTree,
  type Annotation,
  type AccessibilitySelector,
} from "@simview/client";
import { resolveAppRoot } from "./app-assets";
import { inlineAppModule } from "./app-html";
import { SimViewSession } from "./session";

const VERSION = process.env.SIMVIEW_RESOURCE_VERSION ?? "0.1.0";
const RESOURCE_URI = `ui://simview/${VERSION}/preview.html`;
const session = new SimViewSession();
const OPEN_PREVIEW_META = {
  ui: { resourceUri: RESOURCE_URI, visibility: ["model"] as const },
  "openai/outputTemplate": RESOURCE_URI,
  "openai/widgetAccessible": true,
};
const APP_CALLABLE_META = {
  ui: { resourceUri: RESOURCE_URI, visibility: ["model", "app"] as const },
  "ui/resourceUri": RESOURCE_URI,
  "openai/widgetAccessible": true,
};
const APP_ONLY_META = {
  ui: { resourceUri: RESOURCE_URI, visibility: ["app"] as const },
  "ui/resourceUri": RESOURCE_URI,
  "openai/widgetAccessible": true,
};

const geometry = z.object({
  kind: z.literal("point"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export function createServer(): McpServer {
  const server = new McpServer({ name: "simview", version: VERSION });

  registerAppTool(server, "open_simview", {
    title: "Open SimView",
    description: "Start or select a simulator session and open its interactive preview.",
    inputSchema: { udid: z.string().uuid().optional() },
    _meta: OPEN_PREVIEW_META,
  }, async ({ udid }) => {
    const state = await session.open(udid);
    return toolResult(
      `SimView is connected to ${state.device?.name}. The browser fallback is ${state.browserUrl}.`,
      state,
    );
  });

  server.registerTool("connect_simulator", {
    title: "Connect simulator",
    description: "Start or select a simulator session without opening the interactive preview.",
    inputSchema: { udid: z.string().uuid().optional() },
    _meta: APP_CALLABLE_META,
  }, async ({ udid }) => {
    const state = await session.open(udid);
    return toolResult(`SimView is connected to ${state.device?.name}.`, state);
  });

  server.registerTool("list_simulators", {
    title: "List simulators",
    description: "List local iOS Simulators and their current state.",
    inputSchema: {},
    _meta: APP_CALLABLE_META,
  }, async () => {
    const existing = session.client;
    const temporary = existing
      ? existing
      : await import("@simview/client").then(({ SimViewClient }) => SimViewClient.start());
    try {
      return toolResult("Local simulator devices.", {
        devices: await temporary.request("devices.list"),
      });
    } finally {
      if (!existing) await temporary.close();
    }
  });

  registerInputTools(server);
  registerAppBridgeTools(server);
  registerAccessibilityTools(server);
  registerAnnotationTools(server);

  server.registerTool("take_screenshot", {
    title: "Take screenshot",
    description:
      "Observe the selected simulator as a PNG. Use its pixel positions to choose normalized coordinates for tap, swipe, or long_press, then observe again.",
    inputSchema: {},
    _meta: APP_CALLABLE_META,
  }, async () => {
    const screenshot = await session.screenshot();
    return {
      content: [{
        type: "image" as const,
        data: Buffer.from(screenshot.bytes).toString("base64"),
        mimeType: "image/png",
      }, {
        type: "text" as const,
        text: `Captured frame ${screenshot.frameId} at ${screenshot.width}×${screenshot.height}.`,
      }],
      structuredContent: {
        frameId: screenshot.frameId,
        width: screenshot.width,
        height: screenshot.height,
      },
    };
  });

  server.registerTool("get_simview_state", {
    title: "Get SimView state",
    description: "Get the current device, stream, frame, route context, and annotation count.",
    inputSchema: {},
    _meta: APP_CALLABLE_META,
  }, async () => toolResult("Current SimView state.", session.state()));

  server.registerTool("set_orientation", {
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
  }, ({ orientation }) => {
    const result = session.requireClient().request("device.orientation.set", { orientation });
    return result.then(value => toolResult("Simulator orientation accepted.", value));
  });

  registerAppResource(server, "SimView preview", RESOURCE_URI, {
    description: "Interactive local iOS Simulator preview and review surface.",
  }, async () => {
    const html = await appHtml();
    return {
      contents: [{
        uri: RESOURCE_URI,
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
      }],
    };
  });

  return server;
}

function registerAccessibilityTools(server: McpServer): void {
  const selectorSchema = {
    ref: z.string().optional(),
    identifier: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    exact: z.boolean().default(true),
    index: z.number().int().min(0).optional(),
  };

  server.registerTool("observe_screen", {
    title: "Observe screen",
    description:
      "Capture the simulator as a PNG and return a compact interactive accessibility tree. Use element selectors for navigation when possible.",
    inputSchema: {},
  }, async () => {
    const frameStarted = new Date();
    const screenshot = await session.screenshot();
    const frameCapturedAt = new Date();
    const snapshot = await session.accessibilitySnapshot("interactive");
    const accessibilityCapturedAt = new Date(snapshot.capturedAt);
    return {
      content: [{
        type: "image" as const,
        data: Buffer.from(screenshot.bytes).toString("base64"),
        mimeType: "image/png",
      }, {
        type: "text" as const,
        text: compactAccessibilityTree(snapshot),
      }],
      structuredContent: {
        frameId: screenshot.frameId,
        frameCapturedAt: frameCapturedAt.toISOString(),
        snapshot,
        accessibilityCapturedAt: snapshot.capturedAt,
        captureDeltaMs: Math.max(
          0,
          accessibilityCapturedAt.getTime() - frameStarted.getTime(),
        ),
      },
    };
  });

  server.registerTool("get_accessibility_tree", {
    title: "Get accessibility tree",
    description: "Read the frontmost Simulator accessibility hierarchy without taking another screenshot.",
    inputSchema: {
      scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
      maxNodes: z.number().int().min(1).max(1_200).default(1_200),
    },
    _meta: APP_CALLABLE_META,
  }, async ({ scope, maxNodes }) => {
    const snapshot = await session.accessibilitySnapshot(scope, maxNodes);
    return toolResult(compactAccessibilityTree(snapshot), snapshot);
  });

  server.registerTool("find_elements", {
    title: "Find elements",
    description: "Find accessible elements by identifier, role, name, value, or a generation-scoped ref.",
    inputSchema: selectorSchema,
  }, async selector => {
    const result = await session.findElements(selector as AccessibilitySelector);
    return toolResult(`Matched ${result.count} accessible element(s).`, result);
  });

  server.registerTool("tap_element", {
    title: "Tap element",
    description:
      "Re-resolve one accessible element, validate it, and physically tap its visible center through simulator HID.",
    inputSchema: selectorSchema,
    _meta: APP_CALLABLE_META,
  }, async selector => {
    const result = await session.findElements(selector as AccessibilitySelector);
    const index = selector.index ?? 0;
    if (result.count !== 1 && selector.index === undefined) {
      throw new Error(`Selector matched ${result.count} elements; refine the selector or pass index`);
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
    return toolResult("Physical element tap accepted; observe the screen to verify the outcome.", {
      selector,
      element: match,
      point,
      receipt,
    });
  });

  server.registerTool("inspect_point", {
    title: "Inspect point",
    description: "Return the deepest accessible element at a normalized simulator coordinate.",
    inputSchema: {
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    },
    _meta: APP_CALLABLE_META,
  }, async ({ x, y }) => {
    const accessibility = await session.inspectPoint(x, y);
    const status = await session.probeStatus();
    const native = status.connected ? await session.probeInspectPoint(x, y) : undefined;
    return toolResult("Element context at the requested point.", {
      ...accessibility,
      native,
      probe: status,
    });
  });

  server.registerTool("get_ui_context", {
    title: "Get UI context",
    description:
      "Get the optional UIKit probe status and active scene, window, and controller hierarchy.",
    inputSchema: {},
    _meta: APP_CALLABLE_META,
  }, async () => {
    const status = await session.probeStatus();
    const target = status.connected ? undefined : await session.probeTarget();
    const context = status.connected ? await session.probeContext() : undefined;
    return toolResult(
      status.connected ? "UIKit probe context." : "UIKit probe is not enabled; accessibility remains available.",
      { status, context, target },
    );
  });

  server.registerTool("enable_ui_probe", {
    title: "Enable UIKit probe",
    description:
      "Explicitly terminate and relaunch one third-party Simulator app with SimView's bundled read-only UIKit probe.",
    inputSchema: {
      bundleId: z.string().min(3).max(255).refine(value => !value.startsWith("com.apple."), {
        message: "Apple platform applications cannot load the UIKit probe",
      }),
    },
    _meta: APP_CALLABLE_META,
  }, async ({ bundleId }) => toolResult(
    "The target app relaunched and connected to the UIKit probe.",
    await session.enableProbe(bundleId),
  ));

  server.registerTool("wait_for_element", {
    title: "Wait for element",
    description: "Wait for a semantic element to appear or disappear without model-side polling.",
    inputSchema: {
      ...selectorSchema,
      state: z.enum(["visible", "hidden"]).default("visible"),
      timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    },
  }, async ({ state, timeoutMs, ...selector }) => {
    const started = performance.now();
    let result = await session.findElements(selector as AccessibilitySelector);
    while (
      !((state === "hidden" && result.count === 0) || (state === "visible" && result.count > 0))
      && performance.now() - started < timeoutMs
    ) {
      await Bun.sleep(200);
      result = await session.findElements(selector as AccessibilitySelector);
    }
    const satisfied = (state === "hidden" && result.count === 0)
      || (state === "visible" && result.count > 0);
    if (!satisfied) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for element to be ${state}; last match count ${result.count}`,
      );
    }
    return toolResult(`Element is ${state}.`, {
      state,
      durationMs: performance.now() - started,
      ...result,
    });
  });
}

function registerInputTools(server: McpServer): void {
  const input = async (method: Parameters<ReturnType<typeof session.requireClient>["request"]>[0], params: unknown) => {
    const result = await session.requireClient().request(method, params);
    return toolResult("Simulator input accepted.", result);
  };
  server.registerTool("tap", {
    title: "Tap",
    description: "Tap a normalized simulator coordinate.",
    inputSchema: { x: z.number().min(0).max(1), y: z.number().min(0).max(1) },
  }, ({ x, y }) => input("input.tap", { x, y }));
  server.registerTool("swipe", {
    title: "Swipe",
    description: "Swipe between normalized simulator coordinates.",
    inputSchema: {
      from: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
      to: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
      durationMs: z.number().int().min(50).max(10_000).default(350),
    },
  }, ({ from, to, durationMs }) => input("input.swipe", { from, to, durationMs }));
  server.registerTool("long_press", {
    title: "Long press",
    description: "Hold a normalized simulator coordinate.",
    inputSchema: {
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      durationMs: z.number().int().min(100).max(10_000).default(600),
    },
  }, ({ x, y, durationMs }) => input("input.longPress", { x, y, durationMs }));
  server.registerTool("type_text", {
    title: "Type text",
    description: "Type UTF-8 text using HID keys or the controlled Unicode paste fallback.",
    inputSchema: { text: z.string().max(10_000) },
  }, ({ text }) => input("input.typeText", { text }));
  server.registerTool("press_button", {
    title: "Press button",
    description: "Press a supported simulator hardware button.",
    inputSchema: { button: z.enum(["home", "lock", "volume-up", "volume-down", "action"]) },
  }, ({ button }) => input("input.button", { button }));
}

function registerAppBridgeTools(server: McpServer): void {
  server.registerTool("get_preview_packets", {
    title: "Read preview packets",
    description: "Read a bounded batch of H.264 preview packets for the embedded SimView app.",
    inputSchema: {
      afterSequence: z.number().int().min(0).optional(),
      maxPackets: z.number().int().min(1).max(30).default(12),
      timeoutMs: z.number().int().min(50).max(5_000).default(1_500),
    },
    _meta: APP_ONLY_META,
  }, async ({ afterSequence, maxPackets, timeoutMs }) => {
    const batch = await session.previewPackets(afterSequence, maxPackets, timeoutMs);
    return {
      content: [],
      structuredContent: {
        reset: batch.reset,
        configuration: batch.configuration
          ? Buffer.from(batch.configuration).toString("base64")
          : undefined,
        packets: batch.packets.map(packet => ({
          sequence: packet.sequence,
          kind: packet.kind,
          data: Buffer.from(packet.payload).toString("base64"),
        })),
        nextSequence: batch.nextSequence,
      },
    };
  });

  server.registerTool("simulator_input", {
    title: "Send simulator input",
    description: "Forward an input event from the embedded SimView app to the selected Simulator.",
    inputSchema: {
      method: z.enum(["input.touch", "input.tap", "input.button", "input.typeText"]),
      params: z.record(z.string(), z.unknown()),
    },
    _meta: APP_ONLY_META,
  }, async ({ method, params }) => {
    const result = await session.requireClient().request(method, params);
    return {
      content: [],
      structuredContent: result as Record<string, unknown>,
    };
  });
}

function registerAnnotationTools(server: McpServer): void {
  server.registerTool("add_annotation", {
    title: "Add annotation",
    description: "Add a comment at a normalized point on the current simulator frame.",
    inputSchema: {
      geometry,
      note: z.string().min(1).max(2_000),
      frameId: z.string().optional(),
      route: z.string().optional(),
      component: z.object({
        testID: z.string().optional(),
        label: z.string().optional(),
        source: z.string().optional(),
      }).optional(),
      context: z.any().optional(),
    },
    _meta: APP_CALLABLE_META,
  }, async input => {
    const annotation = session.addAnnotation(input);
    return toolResult("Added point annotation.", annotation);
  });

  server.registerTool("update_annotation", {
    title: "Update annotation",
    description: "Edit an existing annotation in the current review.",
    inputSchema: {
      id: z.string().uuid(),
      note: z.string().min(1).max(2_000).optional(),
      geometry: geometry.optional(),
    },
    _meta: APP_ONLY_META,
  }, async ({ id, ...patch }) => toolResult("Annotation updated.", session.updateAnnotation(id, patch)));

  server.registerTool("delete_annotation", {
    title: "Delete annotation",
    description: "Delete an annotation from the current review.",
    inputSchema: { id: z.string().uuid() },
    _meta: APP_ONLY_META,
  }, async ({ id }) => toolResult("Annotation deleted.", { deleted: session.deleteAnnotation(id), id }));
}

async function appHtml(): Promise<string> {
  const root = resolveAppRoot();
  const templatePath = join(root, "dist", "preview.html");
  const scriptPath = join(root, "dist", "preview.js");
  const [template, script] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(scriptPath, "utf8"),
  ]);
  return inlineAppModule(template, script);
}

function toolResult(text: string, structuredContent: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

export async function runServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
