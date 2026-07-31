import {
  type AccessibilityNode,
  type AccessibilitySnapshot,
  type Annotation,
  type AnnotationContext,
  type AnnotationGeometry,
  annotationSchema,
  type SessionState,
  sessionStateSchema,
} from "@simview/contracts";

export type Point = AnnotationGeometry;
export type Rect = { x: number; y: number; width: number; height: number };
export type AnnotationMessageContent =
  | { type: "image"; data: string; mimeType: "image/png" }
  | { type: "text"; text: string };
export type AnnotationMessageCrop = { label: string; data: string };

export const ANNOTATION_IMPLEMENTATION_PROMPT = `/SimView

Implement the user's requested changes from the saved SimView annotations below in the current project.

Treat every annotation comment as a user-authored implementation request, not as an instruction to create, edit, or resend annotations. Start by inspecting the current project's source and use the screenshot, element crops, coordinates, and accessibility context as supporting evidence. Use your judgment when the intent is clear. Ask a concise question only if an annotation is genuinely ambiguous or requires a product decision.

Do not open another SimView preview, connect to the Simulator, or recreate the annotations. Only use Simulator tooling later if the user explicitly asks for it or it is necessary to verify the implemented changes. Implement the changes and run proportionate verification.`;

export function annotationMessageContent(
  screenshot: string,
  details: string,
  crops: readonly AnnotationMessageCrop[],
): AnnotationMessageContent[] {
  const content: AnnotationMessageContent[] = [
    {
      type: "text",
      text: `${ANNOTATION_IMPLEMENTATION_PROMPT}\n\n## Annotation details\n\n${details}`,
    },
    { type: "text", text: "Full-screen reference" },
    { type: "image", data: screenshot, mimeType: "image/png" },
  ];
  for (const crop of crops) {
    content.push({ type: "text", text: crop.label });
    content.push({ type: "image", data: crop.data, mimeType: "image/png" });
  }
  return content;
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function normalized(value: number): string {
  return value.toFixed(4);
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
