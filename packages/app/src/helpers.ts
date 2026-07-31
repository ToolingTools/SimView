import {
  type AccessibilityNode,
  type AccessibilitySnapshot,
  type Annotation,
  type AnnotationContext,
  type AnnotationGeometry,
  annotationSchema,
  type ElementSnapshot,
  type ElementTreeOutput,
  type ElementTreePage,
  elementTreeOutputSchema,
  type ScreenContext,
  type SessionState,
  sessionStateSchema,
  type UiContext,
} from "@simview/contracts";

export type Point = AnnotationGeometry;
export type Rect = { x: number; y: number; width: number; height: number };
export type AnnotationMessageContent = { type: "text"; text: string };
export type AnnotationMessageItem = {
  text: string;
  context: readonly string[];
  screenshotPath: string;
};

export class PreviewBridgeGate {
  #priorityRequests = 0;

  get priorityPending(): boolean {
    return this.#priorityRequests > 0;
  }

  beginPriority(): () => void {
    this.#priorityRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#priorityRequests = Math.max(0, this.#priorityRequests - 1);
    };
  }
}

export async function assembleElementTreePages(
  pages: readonly ElementTreePage[],
): Promise<ElementTreeOutput> {
  const first = pages[0];
  if (!first) throw new Error("Element tree response contained no pages");
  if (pages.at(-1)?.nextCursor)
    throw new Error("Element tree response ended before the final page");

  if (pages.length !== first.pageCount) {
    throw new Error(`Element tree response contained ${pages.length} of ${first.pageCount} pages`);
  }
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (const [pageIndex, page] of pages.entries()) {
    if (
      page.transferId !== first.transferId ||
      page.encoding !== first.encoding ||
      page.pageIndex !== pageIndex ||
      page.pageCount !== first.pageCount ||
      page.totalBytes !== first.totalBytes ||
      page.sha256 !== first.sha256
    ) {
      throw new Error("Element tree pages are inconsistent or out of order");
    }
    const chunk = decodeBase64Bytes(page.chunk);
    if (chunk.byteLength !== page.chunkBytes) {
      throw new Error(`Element tree page ${pageIndex + 1} has an invalid byte length`);
    }
    chunks.push(chunk);
    receivedBytes += chunk.byteLength;
  }
  if (receivedBytes !== first.totalBytes) {
    throw new Error(
      `Element tree response contained ${receivedBytes} of ${first.totalBytes} bytes`,
    );
  }
  const serialized = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    serialized.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", serialized);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (sha256 !== first.sha256) throw new Error("Element tree response failed its integrity check");
  const json = new TextDecoder("utf-8", { fatal: true }).decode(serialized);
  return elementTreeOutputSchema.parse(JSON.parse(json));
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export const ANNOTATION_IMPLEMENTATION_PROMPT = `Implement all clear UI changes requested in the SimView annotations below in the current project.

Treat each annotation as the user's implementation request. Use any supplied screenshots and UI identifiers as supporting evidence to locate the relevant code.

Inspect the source, make the changes, and run proportionate verification. Do not open another SimView review or recreate the annotations. Ask a concise question only when a request is genuinely ambiguous or needs a product decision.`;

export function annotationMessageContext(annotation: Annotation): string[] {
  const accessibility = annotation.context?.accessibility;
  const native = annotation.context?.native;
  const metro = annotation.context?.metro;
  const object = accessibility?.roleDescription ?? accessibility?.role ?? native?.viewClass;
  const route = metro?.route ?? annotation.route;
  const component = metro?.component ?? annotation.component?.label;
  const testID = metro?.testID ?? annotation.component?.testID;
  const sourceLocation = metro?.sourceLocation;
  const source = sourceLocation
    ? formatSourceLocation(sourceLocation)
    : (metro?.source ?? annotation.component?.source);
  return [
    object && `Object: ${object.replace(/^AX/, "")}`,
    `Coordinate: x=${percent(annotation.geometry.x)}, y=${percent(annotation.geometry.y)}`,
    accessibility?.identifier && `ID: ${accessibility.identifier}`,
    accessibility?.title && `Title: "${accessibility.title}"`,
    accessibility?.label && `Label: "${accessibility.label}"`,
    accessibility?.value && `Value: "${accessibility.value}"`,
    accessibility?.path?.length && `Hierarchy: ${accessibility.path.join(" › ")}`,
    route && `Route: ${route}`,
    component && `Component: ${component}`,
    metro?.componentPath?.length && `Component path: ${metro.componentPath.join(" › ")}`,
    metro?.hostComponent && `Host: ${metro.hostComponent}`,
    testID && testID !== accessibility?.identifier && `Test ID: ${testID}`,
    source && `Source: ${source}`,
    native?.viewClass && native.viewClass !== object && `View: ${native.viewClass}`,
  ].filter((value): value is string => Boolean(value));
}

export function createUIKitScreenContext(
  state: Pick<SessionState, "device" | "frameId" | "route" | "component">,
  uiContext: UiContext | undefined,
  annotations: readonly Annotation[],
): ScreenContext {
  const activeScene =
    uiContext?.context?.scenes?.find((scene) => scene.activationState === "foregroundActive") ??
    uiContext?.context?.scenes?.[0];
  const keyWindow =
    activeScene?.windows?.find((window) => window.key && !window.hidden) ??
    activeScene?.windows?.find((window) => !window.hidden);
  const native = annotations.find((annotation) => annotation.context?.native)?.context?.native;
  const controllerPath = keyWindow?.visibleControllerPath?.length
    ? keyWindow.visibleControllerPath
    : native?.controllerPath?.length
      ? native.controllerPath
      : native?.controllerClass
        ? [native.controllerClass]
        : undefined;
  const bundleId = uiContext?.target?.bundleId ?? uiContext?.status.bundleId;

  return {
    schemaVersion: 1,
    kind: "uikit",
    capturedAt: new Date().toISOString(),
    frameId: state.frameId ?? "current",
    simulatorName: state.device?.name,
    runtime: state.device?.runtime,
    bundleId,
    route: state.route,
    component: state.component?.label,
    testID: state.component?.testID,
    source: state.component?.source,
    controllerPath,
    windowClass: keyWindow?.className ?? native?.windowClass,
    sceneDelegate: activeScene?.delegateClass,
    sceneConfiguration: activeScene?.configurationName,
  };
}

export function annotationMessageScreenContext(context: ScreenContext | undefined): string[] {
  if (!context) return [];
  if (context.kind === "react-native") {
    return [
      context.simulatorName &&
        `Simulator: ${context.simulatorName}${context.runtime ? ` · ${formatRuntime(context.runtime)}` : ""}`,
      context.bundleId && `App: ${context.bundleId}`,
      context.route && `Route: ${context.route}`,
      context.navigationPath?.length && `Navigation: ${context.navigationPath.join(" › ")}`,
      context.screenComponent && `Screen component: ${context.screenComponent}`,
      context.componentPath?.length && `Component path: ${context.componentPath.join(" › ")}`,
      context.testID && `Screen test ID: ${context.testID}`,
      context.sourceLocation && `Screen source: ${formatSourceLocation(context.sourceLocation)}`,
      context.viewport &&
        `Viewport: ${Math.round(context.viewport.width)} × ${Math.round(context.viewport.height)}${context.orientation ? ` · ${context.orientation}` : ""}`,
      `Renderer: ${context.renderer}`,
      context.confidence !== "exact" && `Screen match: ${context.confidence}`,
      `Frame: ${context.frameId}`,
    ].filter((value): value is string => Boolean(value));
  }
  return [
    context.simulatorName &&
      `Simulator: ${context.simulatorName}${context.runtime ? ` · ${formatRuntime(context.runtime)}` : ""}`,
    context.bundleId && `App: ${context.bundleId}`,
    context.controllerPath?.length && `Screen: ${context.controllerPath.join(" › ")}`,
    context.route && `Route: ${context.route}`,
    context.component && `Component: ${context.component}`,
    context.testID && `Test ID: ${context.testID}`,
    context.source && `Source: ${context.source}`,
    context.windowClass && `Window: ${context.windowClass}`,
    context.sceneDelegate && `Scene delegate: ${context.sceneDelegate}`,
    context.sceneConfiguration && `Scene configuration: ${context.sceneConfiguration}`,
    `Frame: ${context.frameId}`,
  ].filter((value): value is string => Boolean(value));
}

function formatSourceLocation(location: {
  file: string;
  line?: number | undefined;
  column?: number | undefined;
}): string {
  return `${location.file}${location.line ? `:${location.line}${location.column ? `:${location.column}` : ""}` : ""}`;
}

export function annotationMessageContent(
  screenshotPath: string,
  screenContext: readonly string[],
  annotations: readonly AnnotationMessageItem[],
): AnnotationMessageContent[] {
  const content: AnnotationMessageContent[] = [
    { type: "text", text: ANNOTATION_IMPLEMENTATION_PROMPT },
    { type: "text", text: `Frozen frame screenshot: ${screenshotPath}` },
  ];
  content.push({
    type: "text",
    text: `## Screen context\n\n${screenContext.length ? screenContext.map((value) => `- ${value}`).join("\n") : "- No screen identifiers were available."}`,
  });
  for (const [index, annotation] of annotations.entries()) {
    const context = annotation.context.length
      ? annotation.context.map((value) => `- ${value}`).join("\n")
      : "- No UI identifiers were available.";
    content.push({
      type: "text",
      text: `${index === 0 ? "## Annotations\n\n" : ""}${index + 1}. Annotation: ${annotation.text}\nContext:\n${context}\nCropped screenshot: ${annotation.screenshotPath}`,
    });
  }
  return content;
}

export function annotationCropRect(annotation: Annotation): Rect {
  const frame = annotation.context?.accessibility?.frame;
  const centerX = frame ? frame.x + frame.width / 2 : annotation.geometry.x;
  const centerY = frame ? frame.y + frame.height / 2 : annotation.geometry.y;
  const width = Math.min(1, Math.max(0.36, frame ? frame.width * 1.5 : 0));
  const height = Math.min(1, Math.max(0.24, frame ? frame.height * 1.5 : 0));
  return {
    x: Math.max(0, Math.min(1 - width, centerX - width / 2)),
    y: Math.max(0, Math.min(1 - height, centerY - height / 2)),
    width,
    height,
  };
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function parseSessionState(value: unknown): SessionState | undefined {
  const result = sessionStateSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function claimFullscreenRequest(
  gate: { claimed: boolean },
  context:
    | {
        displayMode?: string | undefined;
        availableDisplayModes?: readonly string[] | undefined;
      }
    | undefined,
): boolean {
  if (gate.claimed) return false;
  if (context?.displayMode === "fullscreen") {
    gate.claimed = true;
    return false;
  }
  if (!context?.availableDisplayModes?.includes("fullscreen")) return false;
  gate.claimed = true;
  return true;
}

export function requireAnnotation(value: unknown): Annotation {
  const result = annotationSchema.safeParse(value);
  if (!result.success) throw new Error("The annotation tool returned an invalid annotation");
  return result.data;
}

export function streamMessage(kind: number, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(payload.byteLength + 1);
  message[0] = kind;
  message.set(payload, 1);
  return message;
}

export function flattenTree(root: AccessibilityNode): AccessibilityNode[] {
  const result: AccessibilityNode[] = [];
  const visit = (node: AccessibilityNode) => {
    result.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  return result;
}

export type InspectorTreeRow = {
  node: AccessibilityNode;
  depth: number;
  isRoot: boolean;
  hasChildren: boolean;
  ancestorRefs: string[];
};

export function inspectorTreeRows(
  root: AccessibilityNode,
  renderedOnly = false,
): InspectorTreeRow[] {
  type Entry = { node: AccessibilityNode; children: Entry[] };
  const viewport = root.frame?.points;
  const intersectsViewport = (node: AccessibilityNode) => {
    const frame = node.frame?.points;
    if (!frame || frame.width <= 0 || frame.height <= 0) return false;
    if (!viewport) return true;
    return (
      frame.x < viewport.x + viewport.width &&
      frame.y < viewport.y + viewport.height &&
      frame.x + frame.width > viewport.x &&
      frame.y + frame.height > viewport.y
    );
  };
  const build = (node: AccessibilityNode, isRoot: boolean): Entry[] => {
    if (node.hidden) return [];
    const children = node.children?.flatMap((child) => build(child, false)) ?? [];
    if (isRoot || !renderedOnly || (node.kind === "host" && intersectsViewport(node))) {
      return [{ node, children }];
    }
    return children;
  };
  const rows: InspectorTreeRow[] = [];
  const visit = (entry: Entry, depth: number, ancestorRefs: string[]) => {
    rows.push({
      node: entry.node,
      depth,
      isRoot: depth === 0,
      hasChildren: entry.children.length > 0,
      ancestorRefs,
    });
    const nextAncestors = [...ancestorRefs, entry.node.ref];
    entry.children.forEach((child) => {
      visit(child, depth + 1, nextAncestors);
    });
  };
  build(root, true).forEach((entry) => {
    visit(entry, 0, []);
  });
  return rows;
}

export function visibleTree(
  root: AccessibilityNode,
  expanded: Set<string>,
  search: string,
  renderedOnly = false,
): InspectorTreeRow[] {
  const query = search.trim().toLowerCase();
  const allRows = inspectorTreeRows(root, renderedOnly);
  if (query) {
    return allRows
      .filter(({ node }) => node !== root)
      .filter(({ node }) =>
        [
          node.role,
          node.roleDescription,
          node.label,
          node.title,
          node.identifier,
          node.placeholder,
          node.value,
        ].some((value) => value?.toLowerCase().includes(query)),
      )
      .map((row) => ({ ...row, depth: 0, isRoot: false, ancestorRefs: [] }));
  }
  return allRows.filter(({ ancestorRefs }) =>
    ancestorRefs.every((ancestorRef) => expanded.has(ancestorRef)),
  );
}

export function elementName(node: AccessibilityNode): string {
  return (
    node.title ??
    node.label ??
    node.placeholder ??
    node.value ??
    node.help ??
    node.identifier ??
    elementRole(node)
  );
}

export function elementRole(node: AccessibilityNode): string {
  const role = (node.roleDescription ?? node.role ?? "Element").replace(/^AX/, "").toLowerCase();
  if (role === "genericelement" || role === "element") {
    return node.children?.length ? "Group" : "Element";
  }
  if (role === "statictext") return "Text";
  return role.replace(/^./, (character) => character.toUpperCase());
}

export function commentableNodeAtPoint(
  root: AccessibilityNode,
  point: Point,
  slop: { x: number; y: number } = { x: 0, y: 0 },
): AccessibilityNode | undefined {
  const matches: { node: AccessibilityNode; depth: number; area: number }[] = [];
  const visit = (node: AccessibilityNode, depth: number) => {
    const frame = node.frame?.normalized;
    if (
      frame &&
      !node.hidden &&
      frame.width > 0 &&
      frame.height > 0 &&
      point.x >= frame.x - slop.x &&
      point.x <= frame.x + frame.width + slop.x &&
      point.y >= frame.y - slop.y &&
      point.y <= frame.y + frame.height + slop.y
    ) {
      matches.push({ node, depth, area: frame.width * frame.height });
    }
    node.children?.forEach((child) => {
      visit(child, depth + 1);
    });
  };
  visit(root, 0);
  const renderedHosts = matches.filter((match) => match.node.kind === "host");
  return (renderedHosts.length ? renderedHosts : matches)
    .filter((match) => match.node !== root)
    .sort((left, right) => {
      const areaDifference = left.area - right.area;
      return Math.abs(areaDifference) > Number.EPSILON ? areaDifference : right.depth - left.depth;
    })[0]?.node;
}

export function compactIdentifier(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

export function formatProbeValue(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

export function formatRuntime(runtime?: string): string {
  if (!runtime) return "iOS Simulator";
  const version = runtime.match(/iOS-([0-9-]+)$/)?.[1]?.replaceAll("-", ".");
  return version ? `iOS ${version}` : runtime;
}

export function formatFrame(frame?: Rect): string {
  if (!frame) return "—";
  return `${percent(frame.x)}, ${percent(frame.y)} · ${percent(frame.width)} × ${percent(frame.height)}`;
}

export function contextForNode(
  snapshot: AccessibilitySnapshot | ElementSnapshot,
  node: AccessibilityNode,
): AnnotationContext {
  const metro =
    snapshot.source === "react-native-fiber"
      ? {
          route: undefined,
          component: node.component,
          componentPath: node.componentPath,
          hostComponent: node.hostComponent,
          testID: node.testID ?? node.identifier,
          sourceLocation: node.sourceLocation,
          accessibilityLabel: node.label,
          role: node.role,
          text: node.text ?? node.value,
          frame: node.frame?.normalized,
        }
      : undefined;
  return {
    capturedAt: snapshot.capturedAt,
    accessibility: {
      snapshotId: snapshot.snapshotId,
      ref: node.ref,
      role: node.role,
      roleDescription: node.roleDescription,
      title: node.title,
      label: node.label ?? node.title,
      identifier: node.identifier,
      value: node.value,
      actions: node.actions,
      frame: node.frame?.normalized,
      path: elementPath(snapshot.root, node),
    },
    metro,
  };
}

export function contextForInspectedNode(
  snapshot: AccessibilitySnapshot | ElementSnapshot | undefined,
  node: AccessibilityNode,
): AnnotationContext {
  if (snapshot) return contextForNode(snapshot, node);
  return {
    capturedAt: new Date().toISOString(),
    accessibility: {
      snapshotId: "point-inspection",
      ref: node.ref,
      role: node.role,
      roleDescription: node.roleDescription,
      title: node.title,
      label: node.label ?? node.title,
      identifier: node.identifier,
      value: node.value,
      actions: node.actions,
      frame: node.frame?.normalized,
    },
  };
}

export function elementPath(
  root: AccessibilityNode,
  target: AccessibilityNode,
): string[] | undefined {
  const visit = (node: AccessibilityNode, path: string[]): string[] | undefined => {
    const next = [...path, node === root ? "Screen" : elementName(node)];
    if (node.ref === target.ref) return next;
    for (const child of node.children ?? []) {
      const match = visit(child, next);
      if (match) return match;
    }
    return undefined;
  };
  return visit(root, []);
}
