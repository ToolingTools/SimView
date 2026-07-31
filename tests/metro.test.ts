import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { AccessibilitySnapshot, DeviceDescription } from "@simview/contracts";
import {
  fiberInspectionExpression,
  MetroInspector,
  normalizeProjectSource,
  selectMetroTarget,
} from "../packages/mcp/src/metro";

type MetroServerInfo = Parameters<typeof selectMetroTarget>[0][number];
type MetroTarget = MetroServerInfo["targets"][number] & { appId?: string };

const device: DeviceDescription = {
  udid: "SIM-123",
  name: "iPhone 17 Pro",
  state: "Booted",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
};

function target(overrides: Partial<MetroTarget> = {}): MetroTarget {
  return {
    id: "target-1",
    title: "Hermes React Native",
    description: "",
    type: "node",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/inspector/device?page=1",
    vm: "Hermes",
    ...overrides,
  };
}

function server(...targets: MetroTarget[]): MetroServerInfo {
  return { host: "127.0.0.1", port: 8081, targets };
}

describe("Metro React Native target selection", () => {
  test("prefers an exact logical Simulator identifier", () => {
    const other = target({ id: "other", reactNative: { logicalDeviceId: "OTHER" } });
    const exact = target({ id: "exact", reactNative: { logicalDeviceId: device.udid } });

    expect(selectMetroTarget([server(other, exact)], device)?.target.id).toBe("exact");
  });

  test("matches the target device name when the logical identifier is absent", () => {
    const match = target({ id: "named", deviceName: "iPhone 17 Pro (Simulator)" });
    const other = target({ id: "android", deviceName: "Pixel 9" });

    expect(selectMetroTarget([server(other, match)], device)?.target.id).toBe("named");
  });

  test("does not attach an ambiguous Fiber tree to the selected Simulator", () => {
    expect(
      selectMetroTarget([server(target({ id: "one" }), target({ id: "two" }))], device),
    ).toBeUndefined();
  });

  test("returns no Fiber result when Metro is unavailable", async () => {
    const inspector = new MetroInspector({
      scan: async () => [],
      connect: async () => {
        throw new Error("should not connect");
      },
    });

    expect(await inspector.inspect(device, accessibilitySnapshot(), "frame-1")).toBeUndefined();
  });

  test("disconnects a failed target and reconnects after reload", async () => {
    const first = new FakeInspectorSession(new Error("Hermes reloaded"));
    const second = new FakeInspectorSession({
      result: {
        value: {
          renderer: "paper",
          root: { ref: "rn:root", role: "AXApplication", children: [] },
          nodeCount: 1,
          truncated: false,
          screen: { route: "Inbox", confidence: "none" },
        },
      },
    });
    const sessions = [first, second];
    const inspector = new MetroInspector({
      scan: async () => [server(target())],
      connect: async () => {
        const session = sessions.shift();
        if (!session) throw new Error("unexpected connection");
        return session;
      },
      projectRoot: "/work/app",
    });

    expect(await inspector.inspect(device, accessibilitySnapshot(), "frame-1")).toBeUndefined();
    expect(first.closed).toBe(true);
    expect(await inspector.inspect(device, accessibilitySnapshot(), "frame-2")).toMatchObject({
      snapshot: { source: "react-native-fiber", metro: { renderer: "paper" } },
      screenContext: { route: "Inbox", frameId: "frame-2" },
    });
  });

  test("polls the result because Hermes does not honor Runtime.evaluate awaitPromise", async () => {
    const result = {
      renderer: "fabric" as const,
      root: { ref: "rn:root", role: "AXApplication", children: [] },
      nodeCount: 1,
      truncated: false,
      screen: { route: "Inbox", confidence: "exact" as const },
    };
    const inspector = new MetroInspector({
      scan: async () => [server(target())],
      connect: async () => new PollingInspectorSession(result),
      projectRoot: "/work/app",
    });

    expect(await inspector.inspect(device, accessibilitySnapshot(), "frame-1")).toMatchObject({
      snapshot: { source: "react-native-fiber", metro: { renderer: "fabric" } },
      screenContext: { route: "Inbox", frameId: "frame-1" },
    });
    expect(inspector.lastError).toBeUndefined();
  });

  test("uses Metro app identity instead of an unrelated native probe target", async () => {
    const inspector = new MetroInspector({
      scan: async () => [server(target({ appId: "com.example.inbox" }))],
      connect: async () =>
        new FakeInspectorSession({
          result: {
            value: {
              renderer: "fabric",
              root: { ref: "rn:root", role: "AXApplication", children: [] },
              nodeCount: 1,
              truncated: false,
              screen: { route: "Inbox", confidence: "exact" },
            },
          },
        }),
      projectRoot: "/work/app",
    });

    expect(await inspector.inspect(device, accessibilitySnapshot(), "frame-1")).toMatchObject({
      screenContext: { bundleId: "com.example.inbox" },
    });
  });

  test("bounds an unresponsive Hermes evaluation and exposes the fallback reason", async () => {
    const inspector = new MetroInspector({
      scan: async () => [server(target())],
      connect: async () => new HangingInspectorSession(),
    });
    const started = performance.now();

    expect(await inspector.inspect(device, accessibilitySnapshot(), "frame-1")).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_600);
    expect(inspector.fallbackReason).toBe("metro-inspection-failed");
  });
});

describe("Metro source normalization", () => {
  const root = "/work/app";

  test("keeps project-relative source locations", () => {
    expect(
      normalizeProjectSource({ file: "/work/app/src/InboxScreen.tsx", line: 42, column: 7 }, root),
    ).toEqual({ file: "src/InboxScreen.tsx", line: 42, column: 7 });
  });

  test("rejects dependencies, bundles, and paths outside the project", () => {
    expect(
      normalizeProjectSource({ file: "/work/app/node_modules/react/index.js" }, root),
    ).toBeUndefined();
    expect(
      normalizeProjectSource({ file: "http://127.0.0.1:8081/index.bundle", line: 1 }, root),
    ).toBeUndefined();
    expect(normalizeProjectSource({ file: "/private/outside.tsx" }, root)).toBeUndefined();
  });

  test("infers the React Native package root when SimView runs from a plugin directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "simview-metro-project-"));
    const source = join(project, "src", "InboxScreen.tsx");
    await mkdir(join(project, "src"));
    await Promise.all([
      writeFile(join(project, "package.json"), "{}"),
      writeFile(source, "export default null"),
    ]);
    const inspector = new MetroInspector({
      scan: async () => [server(target())],
      connect: async () =>
        new FakeInspectorSession({
          result: {
            value: {
              renderer: "fabric",
              root: { ref: "rn:root", role: "AXApplication", children: [] },
              nodeCount: 1,
              truncated: false,
              screen: {
                route: "Inbox",
                sourceLocation: { file: source, line: 4 },
                confidence: "exact",
              },
            },
          },
        }),
    });

    try {
      expect(await inspector.inspect(device, accessibilitySnapshot(), "frame-1")).toMatchObject({
        screenContext: { sourceLocation: { file: "src/InboxScreen.tsx", line: 4 } },
      });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("React Native Fiber projection", () => {
  test("returns measured hosts and focused screen source without serializing props", async () => {
    const root = fiber("Root", {});
    const navigation = fiber("NavigationContainer", {});
    navigation.memoizedState = {
      memoizedState: {
        index: 0,
        routes: [{ key: "inbox-key", name: "Inbox" }],
      },
      next: null,
    };
    const scene = fiber("SceneView", { route: { key: "inbox-key", name: "Inbox" } });
    const screen = fiber("InboxScreen", {}, "/work/app/src/InboxScreen.tsx");
    const host = fiber("View", {
      testID: "inbox-button",
      accessibilityLabel: "Open inbox",
      onPress: () => {},
      secret: "must-not-leak",
    });
    host.type = "RCTView";
    host.stateNode = {
      measure(callback: (...values: number[]) => void) {
        callback(0, 0, 200, 80, 20, 100);
      },
    };
    link(root, navigation);
    link(navigation, scene);
    link(scene, screen);
    link(screen, host);

    const result = await inspectFiber(root, { nativeFabricUIManager: {} });
    const serialized = JSON.stringify(result);

    expect(result.renderer).toBe("fabric");
    expect(result.screen).toMatchObject({
      route: "Inbox",
      component: "InboxScreen",
      confidence: "exact",
      sourceLocation: { file: "/work/app/src/InboxScreen.tsx" },
    });
    expect(serialized).toContain("inbox-button");
    expect(serialized).toContain("Open inbox");
    expect(serialized).toContain('"x":20');
    expect(serialized).not.toContain("must-not-leak");
  });

  test("measures Fabric hosts through their canonical public instance", async () => {
    const root = fiber("Root", {});
    const host = fiber("View", { testID: "fabric-view" });
    host.type = "RCTView";
    host.stateNode = {
      node: {},
      canonical: {
        publicInstance: {
          getBoundingClientRect() {
            return { x: 12, y: 24, width: 180, height: 60 };
          },
        },
      },
    };
    link(root, host);

    const result = await inspectFiber(root, { nativeFabricUIManager: {} });
    const projectedHost = result.root.children?.[0] as
      | { frame?: { points?: { x?: number; y?: number; width?: number; height?: number } } }
      | undefined;

    expect(projectedHost?.frame?.points).toEqual({ x: 12, y: 24, width: 180, height: 60 });
  });

  test("resolves nested navigation without serializing route params", async () => {
    const root = fiber("Root", {});
    const scene = fiber("SceneView", { route: { key: "detail-key", name: "Detail" } });
    const screen = fiber("DetailScreen", {}, "/work/app/src/DetailScreen.tsx");
    link(root, scene);
    link(scene, screen);

    const result = await inspectFiber(root, {
      __METRO_BRIDGE__: {
        navigation: {
          getState: () => ({
            index: 0,
            routes: [
              {
                key: "tabs-key",
                name: "Tabs",
                params: { secret: "must-not-leak" },
                state: {
                  index: 1,
                  routes: [
                    { key: "home-key", name: "Home" },
                    { key: "detail-key", name: "Detail", params: { token: "private" } },
                  ],
                },
              },
            ],
          }),
        },
      },
    });

    expect(result.screen).toMatchObject({
      route: "Detail",
      navigationPath: ["Tabs", "Detail"],
      component: "DetailScreen",
      confidence: "exact",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("reads Expo Router state without bridge instrumentation", async () => {
    const root = fiber("Root", {});
    const scene = fiber("SceneView", { route: { key: "settings-key", name: "settings" } });
    const screen = fiber("SettingsScreen", {}, "/work/app/app/settings.tsx");
    link(root, scene);
    link(scene, screen);

    const result = await inspectFiber(root, {
      __EXPO_ROUTER_STATE__: {
        index: 0,
        routes: [{ key: "settings-key", name: "settings" }],
      },
    });

    expect(result.screen).toMatchObject({
      route: "settings",
      navigationPath: ["settings"],
      component: "SettingsScreen",
      confidence: "exact",
    });
  });

  test("reaches a deeply nested focused screen and prefers it over route wrappers", async () => {
    const route = { key: "shop-menu-key", name: "ShopMenuRoot" };
    const root = fiber("Root", {});
    let parent = root;
    for (let depth = 0; depth < 230; depth += 1) {
      const wrapper = fiber(
        depth === 140 ? "NavigationProvider" : `Wrapper${depth}`,
        depth === 140 ? { route } : {},
      );
      link(parent, wrapper);
      parent = wrapper;
    }
    const screen = fiber(
      "ShopMenuScreen",
      { route, testID: "shop-menu-screen" },
      "/work/app/src/ShopMenuScreen.tsx",
    );
    link(parent, screen);

    const result = await inspectFiber(root, {
      __METRO_BRIDGE__: {
        navigation: {
          getState: () => ({ index: 0, routes: [route] }),
        },
      },
    });

    expect(result.truncated).toBe(false);
    expect(result.screen).toMatchObject({
      route: "ShopMenuRoot",
      component: "ShopMenuScreen",
      testID: "shop-menu-screen",
      confidence: "exact",
    });
  });
});

type InspectionResult = {
  renderer: string;
  root: { children?: Array<Record<string, unknown>> };
  screen: Record<string, unknown>;
  truncated: boolean;
};

async function inspectFiber(
  root: TestFiber,
  globals: Record<string, unknown> = {},
): Promise<InspectionResult> {
  return (await runInNewContext(fiberInspectionExpression(430, 932, 100), {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      getFiberRoots: (id: number) => (id === 1 ? new Set([{ current: root }]) : new Set()),
      renderers: new Map(),
    },
    setTimeout,
    clearTimeout,
    ...globals,
  })) as InspectionResult;
}

type TestFiber = {
  type: string | { displayName: string };
  memoizedProps: Record<string, unknown>;
  memoizedState?: unknown;
  stateNode?: unknown;
  child?: TestFiber;
  sibling?: TestFiber;
  return?: TestFiber;
  _debugSource?: { fileName: string; lineNumber: number; columnNumber: number };
};

function fiber(name: string, props: Record<string, unknown>, source?: string): TestFiber {
  return {
    type: { displayName: name },
    memoizedProps: props,
    ...(source ? { _debugSource: { fileName: source, lineNumber: 1, columnNumber: 1 } } : {}),
  };
}

function link(parent: TestFiber, child: TestFiber): void {
  parent.child = child;
  child.return = parent;
}

function accessibilitySnapshot(): AccessibilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: "ax-1",
    capturedAt: "2026-07-31T10:00:00.000Z",
    source: "core-simulator-ax",
    scope: "interactive",
    screen: { x: 0, y: 0, width: 430, height: 932 },
    root: { ref: "ax:root", role: "AXApplication" },
    stats: { nodeCount: 1, truncated: false },
  };
}

class FakeInspectorSession {
  isConnected = true;
  closed = false;

  constructor(readonly response: unknown) {}

  async send<T>(_method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.response instanceof Error) throw this.response;
    const expression = String(params?.expression ?? "");
    if (expression.startsWith("delete globalThis")) return { result: { value: true } } as T;
    if (expression.includes("Promise.resolve")) return { result: {} } as T;
    const value = (this.response as { result?: { value?: unknown } }).result?.value;
    return { result: { value: { state: "fulfilled", value } } } as T;
  }

  close(): void {
    this.closed = true;
    this.isConnected = false;
  }
}

class PollingInspectorSession {
  isConnected = true;
  #polls = 0;

  constructor(readonly value: unknown) {}

  async send<T>(_method: string, params?: Record<string, unknown>): Promise<T> {
    const expression = String(params?.expression ?? "");
    if (expression.startsWith("delete globalThis")) return { result: { value: true } } as T;
    if (expression.includes("Promise.resolve")) return { result: {} } as T;
    this.#polls += 1;
    return {
      result: {
        value: this.#polls === 1 ? { state: "pending" } : { state: "fulfilled", value: this.value },
      },
    } as T;
  }

  close(): void {
    this.isConnected = false;
  }
}

class HangingInspectorSession {
  isConnected = true;

  async send<T>(): Promise<T> {
    return new Promise<T>(() => {});
  }

  close(): void {
    this.isConnected = false;
  }
}
