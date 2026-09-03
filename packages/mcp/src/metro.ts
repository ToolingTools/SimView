import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AccessibilityNode,
  AccessibilitySnapshot,
  DeviceDescription,
  ElementFallbackDetail,
  ElementFallbackReason,
  ReactNativeElementSnapshot,
  ReactNativeScreenContext,
  SourceLocation,
} from "@simview/contracts";
import {
  CDPSession,
  checkMetroStatus,
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
  scan?: ((host: string) => Promise<MetroServerInfo[]>) | undefined;
  status?: ((host: string, port: number) => Promise<string | null>) | undefined;
  connect?: ((target: MetroTarget) => Promise<InspectorSession>) | undefined;
  projectRoot?: string | undefined;
  now?: (() => number) | undefined;
};
type MetroTargetWithAppId = MetroTarget & { appId?: unknown };

const METRO_PROXY_RECORD = `${tmpdir()}/metro-mcp-proxy.json`;
const METRO_HOST = "localhost";
export const METRO_DISCOVERY_PORTS = [8081, 8082, 19000, 19001, 19002] as const;
const NEGATIVE_DISCOVERY_TTL_MS = 5_000;
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

class StaleMetroConnection extends Error {}

export class MetroInspector {
  #generation = 0;
  #connectionGeneration = 0;
  #connecting: { key: string; generation: number; promise: Promise<InspectorSession> } | undefined;
  #session: InspectorSession | undefined;
  #targetKey: string | undefined;
  #selected: SelectedTarget | undefined;
  #deviceId: string | undefined;
  #lastError: string | undefined;
  #fallbackReason: ElementFallbackReason | undefined;
  #fallbackDetail: ElementFallbackDetail | undefined;
  #negativeDiscovery:
    | { deviceId: string; expiresAt: number; detail: ElementFallbackDetail }
    | undefined;
  readonly #scan: (host: string) => Promise<MetroServerInfo[]>;
  readonly #status: (host: string, port: number) => Promise<string | null>;
  readonly #connectSession: (target: MetroTarget) => Promise<InspectorSession>;
  readonly #projectRoot: string | undefined;
  readonly #now: () => number;

  constructor(dependencies: MetroInspectorDependencies = {}) {
    this.#scan = dependencies.scan ?? ((host) => scanMetroPorts(host));
    this.#status = dependencies.status ?? ((host, port) => checkMetroStatus(host, port));
    this.#connectSession = dependencies.connect ?? ((target) => CDPSession.connect(target));
    this.#projectRoot = dependencies.projectRoot ?? process.env.SIMVIEW_PROJECT_ROOT;
    this.#now = dependencies.now ?? Date.now;
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
    const generation = this.#generation;
    let activeSession: InspectorSession | undefined;
    try {
      if (this.#negativeDiscovery && this.#negativeDiscovery.deviceId !== device.id) {
        this.#negativeDiscovery = undefined;
      }
      let selected =
        this.#session?.isConnected && this.#deviceId === device.id ? this.#selected : undefined;
      if (!selected) {
        const cached = this.#negativeDiscovery;
        if (cached && cached.deviceId === device.id && cached.expiresAt > this.#now()) {
          this.#setUnavailable(cached.detail);
          return undefined;
        }
        const statusPromise = Promise.all(
          METRO_DISCOVERY_PORTS.map((port) => this.#status(METRO_HOST, port).catch(() => null)),
        );
        const servers = await this.#scan(METRO_HOST);
        if (generation !== this.#generation) return undefined;
        selected = selectMetroTarget(servers, device);
        if (!selected) {
          let detail: ElementFallbackDetail;
          if (servers.length > 0) {
            detail = "metro-target-mismatch";
          } else if ((await statusPromise).some((status) => status !== null)) {
            detail = "metro-running-no-debug-targets";
          } else {
            detail = "metro-unreachable";
          }
          if (generation !== this.#generation) return undefined;
          this.#negativeDiscovery = {
            deviceId: device.id,
            expiresAt: this.#now() + NEGATIVE_DISCOVERY_TTL_MS,
            detail,
          };
          this.#setUnavailable(detail);
          return undefined;
        }
      }
      const session = await this.#connect(selected);
      activeSession = session;
      if (generation !== this.#generation) return undefined;
      this.#deviceId = device.id;
      const measurementViewport = metroMeasurementViewport(device, accessibility.screen);
      const raw = await evaluateInspection(
        session,
        measurementViewport.width,
        measurementViewport.height,
        maxNodes,
      );
      if (generation !== this.#generation || session !== this.#session) return undefined;
      if (!raw?.root) {
        this.#lastError = "The React Native inspector returned no Fiber root";
        this.#fallbackReason = "metro-fiber-unavailable";
        this.#fallbackDetail = "metro-fiber-root-missing";
        return undefined;
      }
      scaleMetroPointFrames(raw.root, measurementViewport.scaleX, measurementViewport.scaleY);
      const projectRoot = await symbolicateTree(raw, selected.server, this.#projectRoot);
      if (generation !== this.#generation || session !== this.#session) return undefined;

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
        stats: {
          nodeCount: raw.nodeCount,
          truncated: raw.truncated,
          quality: raw.truncated ? "partial" : "complete",
          capturedBudget: maxNodes,
          ...(raw.truncated ? { reason: "node-budget-exhausted" } : {}),
        },
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
      this.#fallbackDetail = undefined;
      this.#negativeDiscovery = undefined;
      return { snapshot, screenContext };
    } catch (error) {
      if (
        error instanceof StaleMetroConnection ||
        generation !== this.#generation ||
        (activeSession && activeSession !== this.#session)
      )
        return undefined;
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#fallbackReason = "metro-inspection-failed";
      this.#fallbackDetail = "metro-connect-or-evaluate-failed";
      console.error(`[simview:metro] ${this.#lastError}`);
      this.#disconnectSession();
      return undefined;
    }
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  get fallbackReason(): ElementFallbackReason | undefined {
    return this.#fallbackReason;
  }

  get fallbackDetail(): ElementFallbackDetail | undefined {
    return this.#fallbackDetail;
  }

  close(): void {
    this.#generation += 1;
    this.#disconnectSession();
    this.#negativeDiscovery = undefined;
    this.#lastError = undefined;
    this.#fallbackReason = undefined;
    this.#fallbackDetail = undefined;
  }

  async #connect(selected: SelectedTarget): Promise<InspectorSession> {
    const targetKey = `${selected.server.host}:${selected.server.port}:${selected.target.id}`;
    if (this.#session?.isConnected && this.#targetKey === targetKey) return this.#session;
    if (this.#connecting?.key === targetKey && this.#connecting.generation === this.#generation)
      return this.#connecting.promise;
    this.#disconnectSession();
    this.#negativeDiscovery = undefined;
    const generation = this.#generation;
    const connectionGeneration = this.#connectionGeneration;
    const current = () =>
      generation === this.#generation && connectionGeneration === this.#connectionGeneration;
    const promise = (async () => {
      const target = supportsMultipleDebuggers(selected.target)
        ? selected.target
        : ((await existingProxyTarget(selected)) ?? selected.target);
      if (!current()) throw new StaleMetroConnection();
      const session = await this.#connectSession(target);
      if (!current()) {
        session.close();
        throw new StaleMetroConnection();
      }
      this.#session = session;
      this.#targetKey = targetKey;
      this.#selected = selected;
      return session;
    })();
    this.#connecting = { key: targetKey, generation, promise };
    try {
      return await promise;
    } finally {
      if (this.#connecting?.promise === promise) this.#connecting = undefined;
    }
  }

  #setUnavailable(detail: ElementFallbackDetail): void {
    this.#lastError = "No matching React Native Metro target was found";
    this.#fallbackReason = "metro-target-unavailable";
    this.#fallbackDetail = detail;
  }

  #disconnectSession(): void {
    this.#connectionGeneration += 1;
    this.#connecting = undefined;
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
    var rootEntries = [];
    var rendererIds = hook.renderers && hook.renderers.keys ? Array.from(hook.renderers.keys()) : [];
    // Older DevTools hooks do not publish renderers; keep a bounded fallback
    // for their renderer IDs while still enumerating every registered renderer.
    if (!rendererIds.length) rendererIds = Array.from({ length: 64 }, function(_, index) { return index + 1; });
    for (var id of rendererIds) {
      try {
        var candidate = hook.getFiberRoots(id);
        if (candidate && candidate.size) {
          var candidateRenderer = hook.renderers && hook.renderers.get ? hook.renderers.get(id) : null;
          candidate.forEach(function(root) { if (root && root.current) rootEntries.push({ fiber: root.current, renderer: candidateRenderer }); });
        }
      } catch (_) {}
    }
    if (!rootEntries.length) return null;
    var WIDTH = ${JSON.stringify(width)};
    var HEIGHT = ${JSON.stringify(height)};
    var MAX_NODES = ${Math.min(1_199, Math.max(0, maxNodes - 1))};
    var VISIT_LIMIT = Math.min(10000, Math.max(1, MAX_NODES * 20));
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
    function measure(node, fiber, renderer) {
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
    var focus = focused(navState());
    function priorityOf(props) {
      var candidateRole = props.accessibilityRole || props.role;
      var candidateLabel = props.accessibilityLabel || props['aria-label'];
      var candidateAction = props.onPress || props.onPressIn || props.onLongPress || props.onClick || props.onTap;
      return (candidateAction ? 8 : 0) + (candidateLabel ? 4 : 0) + (props.testID ? 2 : 0) + (candidateRole ? 1 : 0);
    }
    function describe(fiber, rootIndex, renderer, order) {
      var name = nameOf(fiber);
      var props = fiber.memoizedProps || {};
      var host = typeof fiber.type === 'string';
      var testID = typeof props.testID === 'string' ? props.testID : undefined;
      var label = typeof props.accessibilityLabel === 'string' ? props.accessibilityLabel :
        (typeof props['aria-label'] === 'string' ? props['aria-label'] : undefined);
      var interactive = !!(props.onPress || props.onPressIn || props.onLongPress || props.onClick || props.onTap);
      var source = sourceOf(fiber);
      var useful = !!name && (host || !!source || !!testID || !!label || interactive) &&
        (host || !INTERNAL.has(name) || !!source);
      return useful ? { fiber: fiber, rootIndex: rootIndex, renderer: renderer, order: order, priority: priorityOf(props) } : null;
    }
    // Breadth-first queues are advanced round-robin across roots. The scan is
    // bounded independently from the output budget so a deep first scene or
    // first renderer cannot hide a later tab bar before selection begins.
    var queues = rootEntries.map(function(entry) { return [entry.fiber]; });
    var entries = [];
    var visited = 0;
    var order = 0;
    while (visited < VISIT_LIMIT && queues.some(function(queue) { return queue.length > 0; })) {
      for (var rootIndex = 0; rootIndex < queues.length && visited < VISIT_LIMIT; rootIndex++) {
        var queue = queues[rootIndex];
        var fiber = queue.shift();
        if (!fiber) continue;
        visited++;
        var props = fiber.memoizedProps || {};
        if (nameOf(fiber) === 'SceneView' && inactiveScene(props.route)) continue;
        var entry = describe(fiber, rootIndex, rootEntries[rootIndex].renderer, order++);
        if (entry) entries.push(entry);
        var child = fiber.child;
        while (child) { queue.push(child); child = child.sibling; }
      }
    }
    if (queues.some(function(queue) { return queue.length > 0; })) truncated = true;
    function takeFair(pool, limit) {
      var groups = rootEntries.map(function(_, rootIndex) {
        return pool.filter(function(entry) { return entry.rootIndex === rootIndex; }).sort(function(left, right) {
          return right.priority - left.priority || left.order - right.order;
        });
      });
      var taken = [];
      while (taken.length < limit && groups.some(function(group) { return group.length > 0; })) {
        for (var groupIndex = 0; groupIndex < groups.length && taken.length < limit; groupIndex++) {
          var next = groups[groupIndex].shift();
          if (next) taken.push(next);
        }
      }
      return taken;
    }
    var semanticEntries = entries.filter(function(entry) { return entry.priority > 0; });
    var selected = takeFair(semanticEntries, MAX_NODES);
    var selectedFibers = new Set(selected.map(function(entry) { return entry.fiber; }));
    var contextualEntries = entries.filter(function(entry) { return !selectedFibers.has(entry.fiber); });
    selected = selected.concat(takeFair(contextualEntries, Math.max(0, MAX_NODES - selected.length)));
    if (selected.length < entries.length) truncated = true;
    var nodesByFiber = new Map();
    var prioritiesByNode = new Map();
    selected.sort(function(left, right) { return left.order - right.order; }).forEach(function(entry) {
      var fiber = entry.fiber;
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
      var node = {
        ref: 'rn:' + (++count),
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
        sourceLocation: sourceOf(fiber)
      };
      nodesByFiber.set(fiber, node);
      prioritiesByNode.set(node, entry.priority);
      if (host) measure(node, fiber, entry.renderer);
    });
    var projected = [];
    selected.forEach(function(entry) {
      var node = nodesByFiber.get(entry.fiber);
      var parent = entry.fiber.return;
      while (parent && !nodesByFiber.has(parent)) parent = parent.return;
      var parentNode = parent && nodesByFiber.get(parent);
      if (parentNode) {
        if (!parentNode.children) parentNode.children = [];
        parentNode.children.push(node);
      } else projected.push(node);
    });
    function prioritize(nodes) {
      nodes.sort(function(left, right) { return (prioritiesByNode.get(right) || 0) - (prioritiesByNode.get(left) || 0); });
      nodes.forEach(function(node) { if (node.children) prioritize(node.children); });
    }
    prioritize(projected);
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
    function pruneUnmeasuredNavigation(nodes) {
      return nodes.filter(function(node) {
        if (node.children) node.children = pruneUnmeasuredNavigation(node.children);
        var label = typeof node.label === 'string' ? node.label : '';
        var unmeasuredTab = !node.frame && /,\\s*tab,\\s*\\d+\\s+of\\s+\\d+$/i.test(label);
        return !unmeasuredTab;
      });
    }
    function projectedCount(nodes) {
      return nodes.reduce(function(total, node) { return total + 1 + projectedCount(node.children || []); }, 0);
    }
    projected = pruneUnmeasuredNavigation(projected);
    var outputNodeCount = projectedCount(projected) + 1;
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
      var found = null;
      for (var rootIndex = 0; rootIndex < rootEntries.length && !found; rootIndex++) {
        var stack = [rootEntries[rootIndex].fiber];
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
      }
      return found;
    }
    function focused(state) {
      var path = []; var routeKeys = []; var current = state; var route = null;
      while (current && Array.isArray(current.routes) && current.routes.length) {
        var index = typeof current.index === 'number' ? current.index : current.routes.length - 1;
        route = current.routes[index]; if (!route) break;
        if (typeof route.name === 'string') path.push(route.name);
        if (typeof route.key === 'string') routeKeys.push(route.key);
        current = route.state;
      }
      return { route: route, path: path, routeKeys: routeKeys };
    }
    function inactiveScene(route) {
      if (!route || (!focus.routeKeys.length && !focus.path.length)) return false;
      if (typeof route.key === 'string') return focus.routeKeys.indexOf(route.key) === -1;
      return typeof route.name === 'string' && focus.path.indexOf(route.name) === -1;
    }
    var match = null; var matchDepth = -1; var fallbackMatch = null; var fallbackDepth = -1;
    var fibers = rootEntries.map(function(entry) { return { fiber: entry.fiber, depth: 0 }; });
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
      var queue = start ? [{ fiber: start, depth: 0 }] : []; var best = null; var bestScore = -Infinity; var inspected = 0;
      while (queue.length && inspected < 2000) {
        var entry = queue.shift(); var f = entry.fiber; var depth = entry.depth; var n = nameOf(f); var source = sourceOf(f); inspected++;
        if (n && typeof f.type !== 'string' && !INTERNAL.has(n)) {
          var props = f.memoizedProps || {};
          var screenName = /(?:Screen|Page)$/i.test(n);
          var screenSource = !!(source && /\\/screens?\\//i.test(source.file));
          var screenTestID = typeof props.testID === 'string' && /screen/i.test(props.testID);
          var generic = /^(?:View|AnimatedView|Animated\\(View\\)|ForwardRef|Memo|Fragment)$/i.test(n);
          var navigationChrome = /(?:TabBar|TabItem|Navigator|NavigationContainer)/i.test(n) ||
            !!(source && /(?:node_modules.*(?:bottom-tabs|tab-view)|\\/navigation\\/BottomTabsNavigator)/i.test(source.file));
          if (!generic && !navigationChrome && (screenName || screenSource || screenTestID)) {
            var score = (screenName ? 120 : 0) + (screenSource ? 80 : 0) +
              (screenTestID ? 30 : 0) + (source ? 20 : 0) - depth * 0.01;
            if (score > bestScore) { best = f; bestScore = score; }
          }
        }
        var child = f.child;
        while (child) { queue.push({ fiber: child, depth: depth + 1 }); child = child.sibling; }
      }
      return best;
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
        return { renderer: globalThis.nativeFabricUIManager ? 'fabric' : 'paper', root: root, nodeCount: outputNodeCount, truncated: truncated,
          screen: { route: focus.route && focus.route.name, navigationPath: focus.path, component: inferred.node.component,
            componentPath: inferred.node.componentPath, testID: inferred.node.testID, sourceLocation: inferred.node.sourceLocation, confidence: confidence } };
      }
    }
    var screenProps = screen && screen.memoizedProps || {};
    return { renderer: globalThis.nativeFabricUIManager ? 'fabric' : 'paper', root: root, nodeCount: outputNodeCount, truncated: truncated,
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
  const line = positiveSourcePosition(source.line);
  const column = positiveSourcePosition(source.column);
  return {
    file: projectRelative,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

function positiveSourcePosition(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
