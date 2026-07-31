import {
  type AccessibilityNode,
  type AccessibilitySnapshot,
  type Annotation,
  type AnnotationContext,
  type AnnotationGeometry,
  annotationSchema,
  type SessionState,
  sessionStateSchema,
  type UiContext,
} from "@simview/contracts";

export type Point = AnnotationGeometry;
export type Rect = { x: number; y: number; width: number; height: number };
export type AnnotationMessageContent =
  | { type: "image"; data: string; mimeType: "image/png" }
  | { type: "text"; text: string };
export type AnnotationMessageItem = {
  text: string;
  context: readonly string[];
  crop?: string | undefined;
};

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
  const source = metro?.source ?? annotation.component?.source;
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
    testID && testID !== accessibility?.identifier && `Test ID: ${testID}`,
    source && `Source: ${source}`,
    native?.viewClass && native.viewClass !== object && `View: ${native.viewClass}`,
  ].filter((value): value is string => Boolean(value));
}

export function annotationMessageScreenContext(
  state: Pick<SessionState, "device" | "frameId" | "route" | "component">,
  uiContext: UiContext | undefined,
  annotations: readonly Annotation[],
): string[] {
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

  return [
    state.device && `Simulator: ${state.device.name} · ${formatRuntime(state.device.runtime)}`,
    bundleId && `App: ${bundleId}`,
    controllerPath?.length && `Screen: ${controllerPath.join(" › ")}`,
    state.route && `Route: ${state.route}`,
    state.component?.label && `Component: ${state.component.label}`,
    state.component?.testID && `Test ID: ${state.component.testID}`,
    state.component?.source && `Source: ${state.component.source}`,
    (keyWindow?.className ?? native?.windowClass) &&
      `Window: ${keyWindow?.className ?? native?.windowClass}`,
    activeScene?.delegateClass && `Scene delegate: ${activeScene.delegateClass}`,
    activeScene?.configurationName && `Scene configuration: ${activeScene.configurationName}`,
    state.frameId && `Frame: ${state.frameId}`,
  ].filter((value): value is string => Boolean(value));
}

export function annotationMessageContent(
  screenshot: string,
  screenContext: readonly string[],
  annotations: readonly AnnotationMessageItem[],
  includeImages = true,
): AnnotationMessageContent[] {
  const content: AnnotationMessageContent[] = [
    { type: "text", text: ANNOTATION_IMPLEMENTATION_PROMPT },
  ];
  if (includeImages) {
    content.push({ type: "image", data: screenshot, mimeType: "image/png" });
  }
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
      text: `${index === 0 ? "## Annotations\n\n" : ""}${index + 1}. Annotation: ${annotation.text}\nContext:\n${context}`,
    });
    if (includeImages && annotation.crop) {
      content.push({ type: "image", data: annotation.crop, mimeType: "image/png" });
    }
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

export function visibleTree(
  root: AccessibilityNode,
  expanded: Set<string>,
  search: string,
): { node: AccessibilityNode; depth: number; isRoot: boolean }[] {
  const query = search.trim().toLowerCase();
  if (query) {
    return flattenTree(root)
      .filter((node) => node !== root && !node.hidden)
      .filter((node) =>
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
      .map((node) => ({ node, depth: 0, isRoot: false }));
  }
  const rows: { node: AccessibilityNode; depth: number; isRoot: boolean }[] = [];
  const visit = (node: AccessibilityNode, depth: number) => {
    if (!node.hidden) rows.push({ node, depth, isRoot: node === root });
    if (expanded.has(node.ref)) {
      node.children?.forEach((child) => {
        visit(child, depth + 1);
      });
    }
  };
  visit(root, 0);
  return rows;
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
  return matches
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
  snapshot: AccessibilitySnapshot,
  node: AccessibilityNode,
): AnnotationContext {
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
  };
}

export function contextForInspectedNode(
  snapshot: AccessibilitySnapshot | undefined,
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
