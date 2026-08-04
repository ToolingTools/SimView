import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AccessibilityNode,
  AccessibilitySnapshot,
  DeviceDescription,
  ElementFallbackReason,
  ReactNativeElementSnapshot,
  ReactNativeScreenContext,
  SourceLocation,
} from "@simview/contracts";
import {
  CDPSession,
  fetchTargets,
  type MetroServerInfo,
  type MetroTarget,
  scanMetroPorts,
  selectBestTarget,
  supportsMultipleDebuggers,
} from "metro-bridge";

type RuntimeEvaluateResult = {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};
type InspectionEnvelope =
  | { state: "pending" }
  | { state: "fulfilled"; value?: RawInspection | undefined }
  | { state: "rejected"; error: string };

type RawSource = {
  file?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
};
type RawNode = AccessibilityNode & {
  sourceLocation?: RawSource | undefined;
  children?: RawNode[] | undefined;
};
type RawInspection = {
  renderer: "fabric" | "paper" | "unknown";
  root: RawNode;
  nodeCount: number;
  truncated: boolean;
  screen?: {
    route?: string | undefined;
    navigationPath?: string[] | undefined;
    component?: string | undefined;
    componentPath?: string[] | undefined;
    testID?: string | undefined;
    sourceLocation?: RawSource | undefined;
    confidence: "exact" | "inferred" | "none";
  };
};

type SelectedTarget = { server: MetroServerInfo; target: MetroTarget };
type InspectorSession = {
  readonly isConnected: boolean;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
};
type MetroInspectorDependencies = {
  scan?: (() => Promise<MetroServerInfo[]>) | undefined;
  connect?: ((target: MetroTarget) => Promise<InspectorSession>) | undefined;
  projectRoot?: string | undefined;
};
type MetroTargetWithAppId = MetroTarget & { appId?: unknown };

const METRO_PROXY_RECORD = `${tmpdir()}/metro-mcp-proxy.json`;
const INTERNAL_NAMES = new Set([
  "AppContainer",
  "BaseNavigationContainer",
  "EnsureSingleNavigator",
  "Fragment",
  "ForwardRef",
  "NavigationContainerInner",
  "PreventRemoveProvider",
  "SafeAreaProvider",
  "SceneView",
  "Screen",
  "StaticContainer",
  "ThemeProvider",
]);

export class MetroInspector {
  #session: InspectorSession | undefined;
  #targetKey: string | undefined;
  #selected: SelectedTarget | undefined;
  #deviceId: string | undefined;
  #lastError: string | undefined;
  #fallbackReason: ElementFallbackReason | undefined;
  readonly #scan: () => Promise<MetroServerInfo[]>;
  readonly #connectSession: (target: MetroTarget) => Promise<InspectorSession>;
  readonly #projectRoot: string | undefined;

  constructor(dependencies: MetroInspectorDependencies = {}) {
    this.#scan = dependencies.scan ?? (() => scanMetroPorts("127.0.0.1"));
    this.#connectSession = dependencies.connect ?? ((target) => CDPSession.connect(target));
    this.#projectRoot = dependencies.projectRoot ?? process.env.SIMVIEW_PROJECT_ROOT;
  }

  async inspect(
    device: DeviceDescription,
    accessibility: AccessibilitySnapshot,
    frameId: string,
    maxNodes = 1_200,
  ): Promise<
    | {
        snapshot: ReactNativeElementSnapshot;
        screenContext: ReactNativeScreenContext;
      }
    | undefined
  > {
    try {
      const selected =
        this.#session?.isConnected && this.#deviceId === device.id
          ? this.#selected
          : selectMetroTarget(await this.#scan(), device);
      if (!selected) {
        this.#lastError = "No matching React Native Metro target was found";
        this.#fallbackReason = "metro-target-unavailable";
        return undefined;
      }
      const session = await this.#connect(selected);
      this.#deviceId = device.id;
      const measurementViewport = metroMeasurementViewport(device, accessibility.screen);
      const raw = await evaluateInspection(
        session,
        measurementViewport.width,
        measurementViewport.height,
        maxNodes,
      );
      if (!raw?.root) {
        this.#lastError = "The React Native inspector returned no Fiber root";
        this.#fallbackReason = "metro-fiber-unavailable";
        return undefined;
      }
      scaleMetroPointFrames(raw.root, measurementViewport.scaleX, measurementViewport.scaleY);
      const projectRoot = await symbolicateTree(raw, selected.server, this.#projectRoot);

      const capturedAt = new Date().toISOString();
      const viewport = accessibility.screen;
      const snapshot: ReactNativeElementSnapshot = {
        schemaVersion: 1,
        snapshotId: randomUUID(),
        capturedAt,
        source: "react-native-fiber",
        scope: accessibility.scope,
        screen: viewport,
        root: raw.root,
        stats: { nodeCount: raw.nodeCount, truncated: raw.truncated },
        metro: {
          host: selected.server.host,
          port: selected.server.port,
          targetId: selected.target.id,
          targetTitle: selected.target.title,
          renderer: raw.renderer,
        },
      };
      const sourceLocation = normalizeProjectSource(raw.screen?.sourceLocation, projectRoot);
      const screenContext: ReactNativeScreenContext = {
        schemaVersion: 1,
        kind: "react-native",
        platform: device.platform,
        capturedAt,
        frameId,
        simulatorName: device.name,
        deviceName: device.name,
        runtime: device.runtime,
        viewport,
        orientation: viewport.width > viewport.height ? "landscape" : "portrait",
        renderer: raw.renderer,
        target: selected.target.title || selected.target.id,
        ...(device.platform === "android"
          ? { packageName: targetAppId(selected.target) }
          : { bundleId: targetAppId(selected.target) }),
        route: raw.screen?.route,
        navigationPath: raw.screen?.navigationPath,
        screenComponent: raw.screen?.component,
        componentPath: raw.screen?.componentPath,
        testID: raw.screen?.testID,
        sourceLocation,
        confidence: raw.screen?.confidence ?? "none",
      };
      this.#lastError = undefined;
      this.#fallbackReason = undefined;
      return { snapshot, screenContext };
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#fallbackReason = "metro-inspection-failed";
      console.error(`[simview:metro] ${this.#lastError}`);
      this.#disconnect();
      return undefined;
    }
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  get fallbackReason(): ElementFallbackReason | undefined {
    return this.#fallbackReason;
  }

  close(): void {
    this.#disconnect();
  }

  async #connect(selected: SelectedTarget): Promise<InspectorSession> {
    const targetKey = `${selected.server.host}:${selected.server.port}:${selected.target.id}`;
    if (this.#session?.isConnected && this.#targetKey === targetKey) return this.#session;
    this.#disconnect();

    const target = supportsMultipleDebuggers(selected.target)
      ? selected.target
      : ((await existingProxyTarget(selected)) ?? selected.target);
    this.#session = await this.#connectSession(target);
    this.#targetKey = targetKey;
    this.#selected = selected;
    return this.#session;
  }

  #disconnect(): void {
    this.#session?.close();
    this.#session = undefined;
    this.#targetKey = undefined;
    this.#selected = undefined;
    this.#deviceId = undefined;
  }
}

type MetroMeasurementViewport = {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

export function metroMeasurementViewport(
  device: DeviceDescription,
  screen: AccessibilitySnapshot["screen"],
): MetroMeasurementViewport {
  if (device.platform !== "android") {
    return { width: screen.width, height: screen.height, scaleX: 1, scaleY: 1 };
  }

  const densityDpi = Number(device.metadata?.densityDpi);
  if (Number.isFinite(densityDpi) && densityDpi > 0) {
    const density = densityDpi / 160;
    return {
      width: screen.width / density,
      height: screen.height / density,
      scaleX: density,
      scaleY: density,
    };
  }

  let pointWidth = device.pointWidth;
  let pointHeight = device.pointHeight;
  if (pointWidth && pointHeight) {
    const screenIsLandscape = screen.width > screen.height;
    const pointsAreLandscape = pointWidth > pointHeight;
    if (screenIsLandscape !== pointsAreLandscape) {
      [pointWidth, pointHeight] = [pointHeight, pointWidth];
    }
    return {
      width: pointWidth,
      height: pointHeight,
      scaleX: screen.width / pointWidth,
      scaleY: screen.height / pointHeight,
    };
  }

  return { width: screen.width, height: screen.height, scaleX: 1, scaleY: 1 };
}

function scaleMetroPointFrames(node: RawNode, scaleX: number, scaleY: number): void {
  if (node.frame && (scaleX !== 1 || scaleY !== 1)) {
    const points = node.frame.points;
    node.frame = {
      ...node.frame,
      points: {
        x: points.x * scaleX,
        y: points.y * scaleY,
        width: points.width * scaleX,
        height: points.height * scaleY,
      },
    };
  }
  for (const child of node.children ?? []) {
    scaleMetroPointFrames(child, scaleX, scaleY);
  }
}

export function selectMetroTarget(
  servers: MetroServerInfo[],
  device: DeviceDescription,
): SelectedTarget | undefined {
  const candidates = servers.flatMap((server) =>
    server.targets.map((target) => ({ server, target })),
  );
  const debuggable = candidates.filter(({ target }) => Boolean(target.webSocketDebuggerUrl));
  const nativeIdentifiers = new Set(
    [device.id, device.udid, device.serial].filter((value): value is string => Boolean(value)),
  );
  const exact = debuggable.filter(({ target }) => {
    const logicalDeviceId = target.reactNative?.logicalDeviceId;
    return logicalDeviceId !== undefined && nativeIdentifiers.has(logicalDeviceId);
  });
  if (exact.length === 1) return exact[0];
  const normalizedDeviceName = normalizeDeviceName(device.name);
  const named = debuggable.filter(({ target }) =>
    normalizeDeviceName(target.deviceName ?? target.title).includes(normalizedDeviceName),
  );
  if (named.length === 1) return named[0];
  const compatible = debuggable.filter(({ target }) => targetSupportsPlatform(target, device));
  if (compatible.length === 1) return compatible[0];

  for (const server of servers) {
    const compatibleTargets = server.targets.filter((target) =>
      targetSupportsPlatform(target, device),
    );
    const target = selectBestTarget(compatibleTargets);
    if (target && servers.length === 1 && compatibleTargets.length === 1) return { server, target };
  }
  return undefined;
}

function targetSupportsPlatform(target: MetroTarget, device: DeviceDescription): boolean {
  const name = normalizeDeviceName(target.deviceName ?? target.title);
  const explicitPlatform = /\b(?:iphone|ipad|ipod|ios)\b/.test(name)
    ? "ios"
    : /\b(?:android|emulator|pixel|sdk gphone)\b/.test(name)
      ? "android"
      : undefined;
  return explicitPlatform === undefined || explicitPlatform === device.platform;
}

function normalizeDeviceName(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function targetAppId(target: MetroTarget): string | undefined {
  const appId = (target as MetroTargetWithAppId).appId;
  return typeof appId === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(appId) ? appId : undefined;
}

async function existingProxyTarget(selected: SelectedTarget): Promise<MetroTarget | undefined> {
  try {
    const record = JSON.parse(await readFile(METRO_PROXY_RECORD, "utf8")) as {
      pid?: number;
      port?: number;
      metroPort?: number;
    };
    if (!record.pid || !record.port) return undefined;
    if (record.metroPort && record.metroPort !== selected.server.port) return undefined;
    process.kill(record.pid, 0);
    const targets = await fetchTargets("127.0.0.1", record.port);
    const target = selectBestTarget(targets);
    if (!target) return undefined;
    const expectedName = normalizeDeviceName(selected.target.deviceName ?? selected.target.title);
    const actualName = normalizeDeviceName(target.deviceName ?? target.title);
    return actualName.includes(expectedName) || expectedName.includes(actualName)
      ? target
      : undefined;
  } catch {
    return undefined;
  }
}

async function evaluateInspection(
  session: InspectorSession,
  width: number,
  height: number,
  maxNodes: number,
): Promise<RawInspection | undefined> {
  const key = `__simviewInspection${randomUUID().replaceAll("-", "")}`;
  const keyLiteral = JSON.stringify(key);
  try {
    const kickoff = await withTimeout(
      session.send<RuntimeEvaluateResult>("Runtime.evaluate", {
        expression: `globalThis[${keyLiteral}] = { state: 'pending' };
Promise.resolve(${fiberInspectionExpression(width, height, maxNodes)}).then(
  function(value) { globalThis[${keyLiteral}] = { state: 'fulfilled', value: value }; },
  function(error) { globalThis[${keyLiteral}] = { state: 'rejected', error: String(error && (error.stack || error.message) || error) }; }
); void 0;`,
        returnByValue: true,
      }),
      1_000,
      "starting React Native Fiber inspection",
    );
    throwForEvaluationException(kickoff);

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const response = await withTimeout(
        session.send<RuntimeEvaluateResult>("Runtime.evaluate", {
          expression: `globalThis[${keyLiteral}]`,
          returnByValue: true,
        }),
        750,
        "reading React Native Fiber inspection",
      );
      throwForEvaluationException(response);
      const envelope = response.result?.value as InspectionEnvelope | undefined;
      if (envelope?.state === "fulfilled") return envelope.value;
      if (envelope?.state === "rejected") throw new Error(envelope.error);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for React Native Fiber inspection");
  } finally {
    await withTimeout(
      session.send("Runtime.evaluate", {
        expression: `delete globalThis[${keyLiteral}]`,
        returnByValue: true,
      }),
      250,
      "cleaning up React Native Fiber inspection",
    ).catch(() => {});
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  action: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out ${action}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function throwForEvaluationException(response: RuntimeEvaluateResult): void {
  if (!response.exceptionDetails) return;
  throw new Error(
    response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      "React Native inspection failed",
  );
}

export function fiberInspectionExpression(width: number, height: number, maxNodes: number): string {
  return `(async function() {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.getFiberRoots) return null;
    var roots = null;
    var renderer = null;
    for (var id = 1; id <= 20; id++) {
      try {
        var candidate = hook.getFiberRoots(id);
        if (candidate && candidate.size) {
          roots = candidate;
          renderer = hook.renderers && hook.renderers.get ? hook.renderers.get(id) : null;
          break;
        }
      } catch (_) {}
    }
    if (!roots || !roots.size) return null;
    var rootFiber = Array.from(roots)[0].current;
    var WIDTH = ${JSON.stringify(width)};
    var HEIGHT = ${JSON.stringify(height)};
    var MAX_NODES = ${Math.min(1_199, Math.max(0, maxNodes - 1))};
    var INTERNAL = new Set(${JSON.stringify([...INTERNAL_NAMES])});
    var count = 0;
    var truncated = false;
    var measureJobs = [];

    function nameOf(fiber) {
      if (!fiber || !fiber.type) return null;
      if (typeof fiber.type === 'string') return fiber.type;
      return fiber.type.displayName || fiber.type.name || null;
    }
    function sourceOf(fiber) {
      var source = fiber && fiber._debugSource;
      if (source && source.fileName) {
        return { file: String(source.fileName), line: source.lineNumber || undefined, column: source.columnNumber || undefined };
      }
      var stack = fiber && fiber._debugStack && fiber._debugStack.stack;
      if (typeof stack !== 'string') return undefined;
      var matches = Array.from(stack.matchAll(/(?:at .*? \\()?((?:file:\\/\\/|https?:\\/\\/|\\/)[^\\n()]+?):(\\d+):(\\d+)\\)?/g));
      var match = matches[1] || matches[0];
      return match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : undefined;
    }
    function componentPath(fiber) {
      var names = [];
      var current = fiber;
      while (current && names.length < 24) {
        var name = nameOf(current);
        if (name && typeof current.type !== 'string' && !INTERNAL.has(name) && names[0] !== name) names.unshift(name);
        current = current.return;
      }
      return names;
    }
    function primitiveText(value) {
      if (typeof value === 'string' || typeof value === 'number') return String(value).slice(0, 300);
      if (!Array.isArray(value)) return undefined;
      var text = value.filter(function(item) { return typeof item === 'string' || typeof item === 'number'; }).join(' ');
      return text ? text.slice(0, 300) : undefined;
    }
    function measure(node, fiber) {
      var stateNode = fiber.stateNode;
      var candidates = [
        stateNode && stateNode.canonical && stateNode.canonical.publicInstance,
        stateNode && stateNode.publicInstance,
        stateNode
      ];
      if (renderer && renderer.findHostInstanceByFiber) {
        try { candidates.unshift(renderer.findHostInstanceByFiber(fiber)); } catch (_) {}
      }
      var instance = candidates.find(function(candidate) {
        return candidate && (typeof candidate.getBoundingClientRect === 'function' || typeof candidate.measure === 'function');
      });
      if (!instance) return;
      measureJobs.push(new Promise(function(resolve) {
        var settled = false;
        var finish = function(rect) {
          if (settled) return;
          settled = true;
          if (rect && rect.width > 0 && rect.height > 0) {
            var x = Number(rect.x || 0); var y = Number(rect.y || 0);
            var w = Number(rect.width); var h = Number(rect.height);
            node.frame = {
              points: { x: x, y: y, width: w, height: h },
              normalized: {
                x: Math.max(0, Math.min(1, x / WIDTH)),
                y: Math.max(0, Math.min(1, y / HEIGHT)),
                width: Math.max(0, Math.min(1, w / WIDTH)),
                height: Math.max(0, Math.min(1, h / HEIGHT))
              }
            };
          }
          resolve();
        };
        var timer = setTimeout(function() { finish(null); }, 120);
        var done = function(rect) { clearTimeout(timer); finish(rect); };
        try {
          if (typeof instance.getBoundingClientRect === 'function') {
            var rect = instance.getBoundingClientRect();
            if (rect && typeof rect.then === 'function') rect.then(done, function() { done(null); });
            else done(rect);
          } else if (typeof instance.measure === 'function') {
            instance.measure(function(_x, _y, w, h, pageX, pageY) { done({ x: pageX, y: pageY, width: w, height: h }); });
          } else done(null);
        } catch (_) { done(null); }
      }));
    }
    function walk(fiber, depth) {
      if (!fiber || depth > 600 || count >= MAX_NODES) {
        if (fiber) truncated = true;
        return [];
      }
      var name = nameOf(fiber);
      var props = fiber.memoizedProps || {};
      var host = typeof fiber.type === 'string';
      var path = componentPath(fiber);
      var testID = typeof props.testID === 'string' ? props.testID : undefined;
      var label = typeof props.accessibilityLabel === 'string' ? props.accessibilityLabel :
        (typeof props['aria-label'] === 'string' ? props['aria-label'] : undefined);
      var role = typeof props.accessibilityRole === 'string' ? props.accessibilityRole :
        (typeof props.role === 'string' ? props.role : undefined);
      var text = primitiveText(props.children);
      var interactive = !!(props.onPress || props.onPressIn || props.onLongPress || props.onClick || props.onTap);
      var source = sourceOf(fiber);
      var useful = !!name && (host || !!source || !!testID || !!label || interactive) &&
        (host || !INTERNAL.has(name) || !!source);
      var node = null;
      if (useful) {
        count++;
        node = {
          ref: 'rn:' + count,
          role: role,
          roleDescription: host ? name : 'React component',
          label: label || (!host ? name : undefined),
          value: text,
          identifier: testID,
          enabled: props.disabled !== true && props.accessibilityState?.disabled !== true,
          hidden: props.accessibilityElementsHidden === true || props['aria-hidden'] === true,
          actions: interactive ? ['press'] : undefined,
          kind: host ? 'host' : 'component',
          component: path.length ? path[path.length - 1] : (!host ? name : undefined),
          componentPath: path.length ? path : undefined,
          hostComponent: host ? name : undefined,
          testID: testID,
          text: text,
          interactive: interactive,
          sourceLocation: source
        };
        if (host) measure(node, fiber);
      }
      var children = [];
      var child = fiber.child;
      while (child && count < MAX_NODES) {
        children = children.concat(walk(child, depth + 1));
        child = child.sibling;
      }
      if (child) truncated = true;
      if (!node) return children;
      if (children.length) node.children = children;
      return [node];
    }
    var projected = walk(rootFiber, 0);
    await Promise.all(measureJobs);
    function union(node) {
      var frames = [];
      if (node.frame) frames.push(node.frame.points);
      (node.children || []).forEach(function(child) {
        union(child);
        if (child.frame) frames.push(child.frame.points);
      });
      if (!node.frame && frames.length) {
        var left = Math.min.apply(null, frames.map(function(f) { return f.x; }));
        var top = Math.min.apply(null, frames.map(function(f) { return f.y; }));
        var right = Math.max.apply(null, frames.map(function(f) { return f.x + f.width; }));
        var bottom = Math.max.apply(null, frames.map(function(f) { return f.y + f.height; }));
        node.frame = {
          points: { x: left, y: top, width: right - left, height: bottom - top },
          normalized: { x: left / WIDTH, y: top / HEIGHT, width: (right - left) / WIDTH, height: (bottom - top) / HEIGHT }
        };
      }
    }
    projected.forEach(union);
    var root = {
      ref: 'rn:root', role: 'AXApplication', roleDescription: 'React Native screen', label: 'Screen',
      frame: { points: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, normalized: { x: 0, y: 0, width: 1, height: 1 } },
      kind: 'component', children: projected
    };
    function navState() {
      try {
        var bridge = globalThis.__METRO_BRIDGE__ || globalThis.__METRO_MCP__;
        if (bridge && bridge.navigation && bridge.navigation.getState) return bridge.navigation.getState();
        var expo = globalThis.__EXPO_ROUTER_STATE__;
        if (typeof expo === 'function') expo = expo();
        if (expo && expo.routes) return expo;
      } catch (_) {}
      var found = null; var stack = [rootFiber];
      while (stack.length && !found) {
        var fiber = stack.pop(); if (!fiber) continue;
        var n = nameOf(fiber); var state = fiber.memoizedState;
        if (n === 'NavigationContainer' || n === 'NavigationContainerInner' || n === 'BaseNavigationContainer') {
          while (state && !found) {
            if (state.memoizedState && state.memoizedState.routes) found = state.memoizedState;
            else if (state.queue && state.queue.lastRenderedState && state.queue.lastRenderedState.routes) found = state.queue.lastRenderedState;
            state = state.next;
          }
          if (!found && fiber.memoizedProps && fiber.memoizedProps.state?.routes) found = fiber.memoizedProps.state;
        }
        if (fiber.sibling) stack.push(fiber.sibling); if (fiber.child) stack.push(fiber.child);
      }
      return found;
    }
    function focused(state) {
      var path = []; var current = state; var route = null;
      while (current && Array.isArray(current.routes) && current.routes.length) {
        var index = typeof current.index === 'number' ? current.index : current.routes.length - 1;
        route = current.routes[index]; if (!route) break;
        if (typeof route.name === 'string') path.push(route.name);
        current = route.state;
      }
      return { route: route, path: path };
    }
    var focus = focused(navState());
    var match = null; var matchDepth = -1; var fallbackMatch = null; var fallbackDepth = -1;
    var fibers = [{ fiber: rootFiber, depth: 0 }];
    while (fibers.length) {
      var entry = fibers.pop(); var f = entry && entry.fiber; if (!f) continue;
      var depth = entry.depth; var p = f.memoizedProps || {}; var r = p.route;
      if (focus.route && r && ((focus.route.key && r.key === focus.route.key) || (focus.route.name && r.name === focus.route.name))) {
        if (depth >= fallbackDepth) { fallbackMatch = f; fallbackDepth = depth; }
        var matchName = nameOf(f);
        if (matchName && typeof f.type !== 'string' && !INTERNAL.has(matchName) && depth >= matchDepth) {
          match = f; matchDepth = depth;
        }
      }
      if (f.sibling) fibers.push({ fiber: f.sibling, depth: depth });
      if (f.child) fibers.push({ fiber: f.child, depth: depth + 1 });
    }
    if (!match) match = fallbackMatch;
    function screenFiber(start) {
      var queue = start ? [start] : []; var fallback = null;
      while (queue.length) {
        var f = queue.shift(); var n = nameOf(f); var source = sourceOf(f);
        if (n && typeof f.type !== 'string' && !INTERNAL.has(n)) {
          if (source) return f; if (!fallback) fallback = f;
        }
        if (f.child) queue.push(f.child);
      }
      return fallback;
    }
    var screen = screenFiber(match);
    var confidence = screen && match ? 'exact' : 'none';
    if (!screen) {
      function best(node, depth) {
        var candidate = null;
        if (node.kind === 'component' && node.frame && node.sourceLocation && node.frame.normalized.width * node.frame.normalized.height >= 0.65) {
          candidate = { node: node, depth: depth };
        }
        (node.children || []).forEach(function(child) { var next = best(child, depth + 1); if (next && (!candidate || next.depth > candidate.depth)) candidate = next; });
        return candidate;
      }
      var inferred = best(root, 0); if (inferred) {
        confidence = 'inferred';
        return { renderer: globalThis.nativeFabricUIManager ? 'fabric' : 'paper', root: root, nodeCount: count + 1, truncated: truncated,
          screen: { route: focus.route && focus.route.name, navigationPath: focus.path, component: inferred.node.component,
            componentPath: inferred.node.componentPath, testID: inferred.node.testID, sourceLocation: inferred.node.sourceLocation, confidence: confidence } };
      }
    }
    var screenProps = screen && screen.memoizedProps || {};
    return { renderer: globalThis.nativeFabricUIManager ? 'fabric' : 'paper', root: root, nodeCount: count + 1, truncated: truncated,
      screen: { route: focus.route && focus.route.name, navigationPath: focus.path, component: screen && nameOf(screen),
        componentPath: screen && componentPath(screen), testID: typeof screenProps.testID === 'string' ? screenProps.testID : undefined,
        sourceLocation: screen && sourceOf(screen), confidence: confidence } };
  })()`;
}

async function symbolicateTree(
  inspection: RawInspection,
  server: MetroServerInfo,
  projectRootHint: string | undefined,
): Promise<string> {
  const entries: Array<{
    owner: { sourceLocation?: RawSource | undefined };
    source: RawSource;
  }> = [];
  const collect = (node: RawNode) => {
    if (node.sourceLocation?.file) entries.push({ owner: node, source: node.sourceLocation });
    node.children?.forEach(collect);
  };
  collect(inspection.root);
  if (inspection.screen?.sourceLocation?.file) {
    entries.push({ owner: inspection.screen, source: inspection.screen.sourceLocation });
  }

  const bundleEntries = entries.filter(({ source }) => isBundleSource(source.file));
  if (bundleEntries.length) {
    try {
      const response = await fetch(`http://${server.host}:${server.port}/symbolicate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stack: bundleEntries.map(({ source }) => ({
            file: source.file,
            lineNumber: source.line ?? 1,
            column: source.column ?? 1,
          })),
        }),
        signal: AbortSignal.timeout(2_500),
      });
      if (response.ok) {
        const result = (await response.json()) as {
          stack?: Array<RawSource & { lineNumber?: number | undefined }>;
        };
        result.stack?.forEach((source, index) => {
          const entry = bundleEntries[index];
          if (entry) {
            entry.owner.sourceLocation = {
              file: source.file,
              line: source.line ?? source.lineNumber,
              column: source.column,
            };
          }
        });
      }
    } catch {
      // Source context is optional; retain the rest of the tree.
    }
  }

  const projectRoot =
    projectRootHint ??
    (await inferProjectRoot(entries.map(({ owner }) => owner.sourceLocation))) ??
    process.cwd();

  const normalize = (owner: { sourceLocation?: RawSource | undefined }) => {
    const normalized = normalizeProjectSource(owner.sourceLocation, projectRoot);
    if (normalized) owner.sourceLocation = normalized;
    else delete owner.sourceLocation;
  };
  entries.forEach(({ owner }) => {
    normalize(owner);
  });
  if (inspection.screen && !inspection.screen.sourceLocation && inspection.screen.component) {
    let inferred: RawSource | undefined;
    const inferFromNode = (node: RawNode) => {
      if (
        !inferred &&
        node.sourceLocation?.file &&
        node.componentPath?.includes(inspection.screen?.component ?? "")
      ) {
        inferred = node.sourceLocation;
      }
      node.children?.forEach(inferFromNode);
    };
    inferFromNode(inspection.root);
    if (inferred) inspection.screen.sourceLocation = inferred;
  }
  return projectRoot;
}

async function inferProjectRoot(
  sources: Array<RawSource | undefined>,
): Promise<string | undefined> {
  for (const source of sources) {
    const file = sourceFilePath(source?.file);
    if (!file || !isAbsolute(file) || file.includes("/node_modules/")) continue;
    let directory = dirname(file);
    for (let depth = 0; depth < 24; depth += 1) {
      try {
        await access(join(directory, "package.json"));
        return directory;
      } catch {
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  }
  return undefined;
}

function sourceFilePath(value: string | undefined): string | undefined {
  if (!value || /^https?:/.test(value) || value.includes("index.bundle")) return undefined;
  try {
    return decodeURIComponent(value.replace(/^file:\/\//, "").replace(/^webpack:\/\//, ""));
  } catch {
    return undefined;
  }
}

function isBundleSource(file: string | undefined): boolean {
  return Boolean(file && (/index\.bundle/.test(file) || /^https?:/.test(file)));
}

export function normalizeProjectSource(
  source: RawSource | undefined,
  projectRoot: string,
): SourceLocation | undefined {
  if (!source?.file) return undefined;
  let file = source.file.replace(/^file:\/\//, "");
  try {
    if (/^https?:/.test(file)) file = new URL(file).pathname;
  } catch {
    return undefined;
  }
  file = decodeURIComponent(file).replace(/^webpack:\/\//, "");
  if (file.includes("node_modules") || file.includes("index.bundle")) return undefined;
  const absolute = isAbsolute(file)
    ? resolve(file)
    : resolve(projectRoot, file.replace(/^\/+/, ""));
  const projectRelative = relative(resolve(projectRoot), absolute);
  if (!projectRelative || projectRelative.startsWith("..") || isAbsolute(projectRelative)) {
    return undefined;
  }
  return {
    file: projectRelative,
    line: source.line,
    column: source.column,
  };
}
