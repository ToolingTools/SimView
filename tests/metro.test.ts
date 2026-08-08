import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  type AccessibilitySnapshot,
  type DeviceDescription,
  parseDeviceDescription,
} from "@simview/contracts";
import {
  fiberInspectionExpression,
  MetroInspector,
  metroMeasurementViewport,
  normalizeProjectSource,
  selectMetroTarget,
} from "../packages/mcp/src/metro";

type MetroServerInfo = Parameters<typeof selectMetroTarget>[0][number];
type MetroTarget = MetroServerInfo["targets"][number] & { appId?: string };

const device: DeviceDescription = parseDeviceDescription({
  udid: "SIM-123",
  name: "iPhone 17 Pro",
  state: "Booted",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
});

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
    const exact = target({ id: "exact", reactNative: { logicalDeviceId: "SIM-123" } });

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

  test("does not attach an iOS Fiber target to an Android preview", () => {
    const android = androidDevice();
    const iosTarget = target({
      title: "com.example.app (iPhone 17 Pro)",
      deviceName: "iPhone 17 Pro",
    });

    expect(selectMetroTarget([server(iosTarget)], android)).toBeUndefined();
  });

  test("accepts a compatible Android Fiber target", () => {
    const android = androidDevice();
    const pixelTarget = target({
      title: "com.example.app (Pixel 9 Pro XL)",
      deviceName: "Pixel 9 Pro XL",
    });

    expect(selectMetroTarget([server(pixelTarget)], android)?.target.id).toBe("target-1");
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

describe("Metro React Native viewport scaling", () => {
  test("normalizes Android density-independent measurements against capture pixels", () => {
    const android = androidDevice();

    expect(metroMeasurementViewport(android, { x: 0, y: 0, width: 1_344, height: 2_992 })).toEqual({
      width: 448,
      height: 2_992 / 3,
      scaleX: 3,
      scaleY: 3,
    });
  });

  test("keeps iOS measurements in the accessibility viewport coordinate space", () => {
    expect(metroMeasurementViewport(device, { x: 0, y: 0, width: 430, height: 932 })).toEqual({
      width: 430,
      height: 932,
      scaleX: 1,
      scaleY: 1,
    });
  });
});

function androidDevice(): DeviceDescription {
  return parseDeviceDescription({
    id: "android:emulator-5554",
    platform: "android",
    kind: "emulator",
    state: "ready",
    available: true,
    name: "Pixel 9 Pro XL",
    runtime: "Android 16 (API 36)",
    serial: "emulator-5554",
    capabilities: {
      capture: { h264: true, mjpeg: true, screenshot: true },
      input: {
        touch: true,
        rawTouch: true,
        text: "ascii",
        buttons: ["back", "home", "overview"],
      },
      orientation: true,
      accessibility: true,
      androidContext: true,
      uikitProbe: false,
    },
    metadata: { densityDpi: "480" },
  });
}

describe("Metro source normalization", () => {
  const root = "/work/app";

  test("keeps project-relative source locations", () => {
    expect(
      normalizeProjectSource({ file: "/work/app/src/InboxScreen.tsx", line: 42, column: 7 }, root),
    ).toEqual({ file: "src/InboxScreen.tsx", line: 42, column: 7 });
  });

  test("omits invalid debugger source positions", () => {
    expect(
      normalizeProjectSource({ file: "/work/app/src/InboxScreen.tsx", line: 0, column: 0 }, root),
    ).toEqual({ file: "src/InboxScreen.tsx" });
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

  test("keeps the focused scene and global overlays while omitting inactive navigation scenes", async () => {
    const root = fiber("Root", {});
    const navigation = fiber("NavigationContainer", {});
    const activeScene = fiber("SceneView", { route: { key: "inbox-key", name: "Inbox" } });
    const inactiveScene = fiber("SceneView", { route: { key: "settings-key", name: "Settings" } });
    const activeScreen = fiber("InboxScreen", {}, "/work/app/src/InboxScreen.tsx");
    const inactiveScreen = fiber("SettingsScreen", {}, "/work/app/src/SettingsScreen.tsx");
    const activeHost = fiber("View", { testID: "inbox-button" });
    const inactiveHost = fiber("View", { testID: "settings-button" });
    const toastHost = fiber("View", { testID: "toast-overlay" });
    activeHost.type = "RCTView";
    inactiveHost.type = "RCTView";
    toastHost.type = "RCTView";
    navigation.memoizedState = {
      memoizedState: { index: 0, routes: [{ key: "inbox-key", name: "Inbox" }] },
      next: null,
    };
    link(root, navigation);
    navigation.sibling = toastHost;
    toastHost.return = root;
    link(navigation, activeScene);
    activeScene.sibling = inactiveScene;
    inactiveScene.return = navigation;
    link(activeScene, activeScreen);
    link(activeScreen, activeHost);
    link(inactiveScene, inactiveScreen);
    link(inactiveScreen, inactiveHost);

    const result = await inspectFiber(root, { nativeFabricUIManager: {} });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("inbox-button");
    expect(serialized).toContain("toast-overlay");
    expect(serialized).not.toContain("settings-button");
    expect(result.screen).toMatchObject({ route: "Inbox", component: "InboxScreen" });
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

  test("keeps semantic tab siblings when an earlier branch exceeds a 240-node budget", async () => {
    const root = fiber("Root", {});
    const deepScene = fiber("View", {});
    deepScene.type = "RCTView";
    link(root, deepScene);
    let parent = deepScene;
    for (let index = 0; index < 300; index += 1) {
      const wrapper = fiber("View", {});
      wrapper.type = "RCTView";
      link(parent, wrapper);
      parent = wrapper;
    }
    const tabBar = fiber("TabBar", {});
    deepScene.sibling = tabBar;
    tabBar.return = root;
    let previousTab: TestFiber | undefined;
    for (const name of ["Home", "Branches", "Menu", "Invoices", "Settings"]) {
      const tab = fiber("Pressable", {
        testID: `tab-${name.toLocaleLowerCase()}`,
        accessibilityLabel: name,
        accessibilityRole: "tab",
        onPress: () => {},
      });
      tab.type = "RCTView";
      if (previousTab) {
        previousTab.sibling = tab;
        tab.return = tabBar;
      } else {
        link(tabBar, tab);
      }
      previousTab = tab;
    }

    const result = await inspectFibers([root], 240);
    const serialized = JSON.stringify(result);

    expect(result.nodeCount).toBe(240);
    expect(result.truncated).toBe(true);
    for (const name of ["home", "branches", "menu", "invoices", "settings"]) {
      expect(serialized).toContain(`tab-${name}`);
    }
  });

  test("fairly projects later roots and infers navigation outside the first root", async () => {
    const firstRoot = fiber("FirstRoot", {});
    let parent = firstRoot;
    for (let index = 0; index < 300; index += 1) {
      const host = fiber("View", {});
      host.type = "RCTView";
      link(parent, host);
      parent = host;
    }

    const route = { key: "menu-key", name: "Menu" };
    const secondRoot = fiber("SecondRoot", {});
    const navigation = fiber("NavigationContainer", {});
    navigation.memoizedState = {
      memoizedState: { index: 0, routes: [route] },
      next: null,
    };
    const scene = fiber("SceneView", { route });
    const screen = fiber(
      "MenuScreen",
      { route, testID: "menu-screen" },
      "/work/app/src/MenuScreen.tsx",
    );
    const menuTab = fiber("Pressable", {
      testID: "menu-tab",
      accessibilityLabel: "Menu",
      accessibilityRole: "tab",
      onPress: () => {},
    });
    menuTab.type = "RCTView";
    link(secondRoot, navigation);
    link(navigation, scene);
    link(scene, screen);
    link(screen, menuTab);

    const result = await inspectFibers([firstRoot, secondRoot], 240);

    expect(result.nodeCount).toBe(240);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).toContain("menu-tab");
    expect(result.screen).toMatchObject({
      route: "Menu",
      component: "MenuScreen",
      testID: "menu-screen",
      confidence: "exact",
    });
  });

  test("drops unmeasured navigation ghosts and prefers the actual screen component", async () => {
    const route = { key: "invoices-key", name: "Invoices" };
    const root = fiber("Root", {});
    const navigation = fiber("NavigationContainer", {});
    navigation.memoizedState = {
      memoizedState: { index: 0, routes: [route] },
      next: null,
    };
    const scene = fiber("SceneView", { route });
    const phantom = fiber(
      "TabBarItemInternal",
      { accessibilityLabel: "OrderConfirmationScreen, tab, 6 of 6", accessibilityRole: "tab" },
      "/work/app/node_modules/navigation/TabBarItemInternal.tsx",
    );
    const screen = fiber(
      "InvoicesScreen",
      { route, testID: "invoices-screen" },
      "/work/app/src/screens/InvoicesScreen.tsx",
    );
    const realTab = fiber("Pressable", {
      accessibilityLabel: "Invoices, tab, 4 of 5",
      accessibilityRole: "tab",
      testID: "invoices-tab",
      onPress: () => {},
    });
    realTab.type = "RCTView";
    realTab.stateNode = {
      measure(callback: (...values: number[]) => void) {
        callback(0, 0, 80, 44, 240, 820);
      },
    };
    link(root, navigation);
    link(navigation, scene);
    link(scene, phantom);
    phantom.sibling = screen;
    screen.return = scene;
    link(screen, realTab);

    const result = await inspectFiber(root);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("OrderConfirmationScreen, tab, 6 of 6");
    expect(serialized).toContain("Invoices, tab, 4 of 5");
    expect(result.screen).toMatchObject({
      route: "Invoices",
      component: "InvoicesScreen",
      testID: "invoices-screen",
    });
  });

  test("does not report bottom-tab navigation chrome as an exact screen", async () => {
    const route = { key: "invoices-key", name: "Invoices" };
    const root = fiber("Root", {});
    const navigation = fiber("NavigationContainer", {});
    navigation.memoizedState = {
      memoizedState: { index: 0, routes: [route] },
      next: null,
    };
    const scene = fiber("SceneView", { route });
    const tabItem = fiber(
      "TabBarItemInternal",
      { route },
      "/work/app/src/navigation/BottomTabsNavigator.tsx",
    );
    const genericView = fiber(
      "View",
      { route },
      "/work/app/src/navigation/BottomTabsNavigator.tsx",
    );
    link(root, navigation);
    link(navigation, scene);
    link(scene, tabItem);
    link(tabItem, genericView);

    const result = await inspectFiber(root);

    expect(result.screen).toMatchObject({
      route: "Invoices",
      confidence: "none",
    });
    expect(result.screen.component).toBeNull();
  });
});

type InspectionResult = {
  renderer: string;
  root: { children?: Array<Record<string, unknown>> };
  screen: Record<string, unknown>;
  nodeCount: number;
  truncated: boolean;
};

async function inspectFiber(
  root: TestFiber,
  globals: Record<string, unknown> = {},
): Promise<InspectionResult> {
  return inspectFibers([root], 100, globals);
}

async function inspectFibers(
  roots: TestFiber[],
  maxNodes: number,
  globals: Record<string, unknown> = {},
): Promise<InspectionResult> {
  return (await runInNewContext(fiberInspectionExpression(430, 932, maxNodes), {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      getFiberRoots: (id: number) =>
        roots[id - 1] ? new Set([{ current: roots[id - 1] }]) : new Set(),
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
