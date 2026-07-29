export const PROTOCOL_VERSION = 1 as const;

export enum FrameKind {
  Request = 0x01,
  Response = 0x02,
  H264Configuration = 0x10,
  H264Frame = 0x11,
  JpegFrame = 0x12,
  PngScreenshot = 0x20,
}

export type Codec = "h264" | "mjpeg";
export type Orientation =
  | "portrait"
  | "portrait-upside-down"
  | "landscape-left"
  | "landscape-right";

export interface DeviceDescription {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  pointWidth?: number;
  pointHeight?: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface HelloParams {
  token: string;
  codecs: Codec[];
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate?: number;
}

export type Method =
  | "hello"
  | "devices.list"
  | "device.describe"
  | "capture.start"
  | "capture.stop"
  | "capture.keyframe"
  | "capture.screenshot"
  | "input.touch"
  | "input.tap"
  | "input.longPress"
  | "input.swipe"
  | "input.typeText"
  | "input.key"
  | "input.button"
  | "device.orientation.set"
  | "accessibility.snapshot"
  | "accessibility.elementAtPoint"
  | "accessibility.find"
  | "accessibility.wait"
  | "probe.status"
  | "probe.target"
  | "probe.enable"
  | "probe.disable"
  | "probe.context"
  | "probe.inspectPoint"
  | "probe.findViews"
  | "probe.fullHierarchy"
  | "health.get"
  | "server.shutdown";

export interface ProtocolRequest<T = unknown> {
  id: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  method: Method;
  params: T;
}

export interface ProtocolError {
  code: string;
  message: string;
  details?: unknown;
  recoverable: boolean;
}

export interface ProtocolResponse<T = unknown> {
  id: string;
  result?: T;
  error?: ProtocolError;
}

export interface TouchParams {
  contactId: number;
  phase: "down" | "move" | "up";
  x: number;
  y: number;
  pressure?: number;
  timestamp?: number;
}

export interface Annotation {
  id: string;
  frameId: string;
  createdAt: string;
  geometry: { kind: "point"; x: number; y: number };
  note: string;
  route?: string;
  component?: { testID?: string; label?: string; source?: string };
  context?: AnnotationContext;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AccessibilityNode {
  ref: string;
  role?: string;
  roleDescription?: string;
  subrole?: string;
  label?: string;
  value?: string;
  valueRedacted?: boolean;
  identifier?: string;
  title?: string;
  help?: string;
  placeholder?: string;
  enabled?: boolean;
  hidden?: boolean;
  focused?: boolean;
  expanded?: boolean;
  actions?: string[];
  frame?: {
    points: NormalizedRect;
    normalized: NormalizedRect;
  };
  children?: AccessibilityNode[];
}

export interface AccessibilitySnapshot {
  schemaVersion: 1;
  snapshotId: string;
  capturedAt: string;
  source: "core-simulator-ax";
  scope: "interactive" | "visible" | "full";
  screen: NormalizedRect;
  root: AccessibilityNode;
  stats: {
    nodeCount: number;
    truncated: boolean;
  };
}

export interface AccessibilitySelector {
  ref?: string;
  identifier?: string;
  role?: string;
  name?: string;
  value?: string;
  exact?: boolean;
  index?: number;
}

export interface AnnotationContext {
  capturedAt: string;
  accessibility?: {
    snapshotId: string;
    ref?: string;
    role?: string;
    roleDescription?: string;
    title?: string;
    label?: string;
    identifier?: string;
    value?: string;
    actions?: string[];
    frame?: NormalizedRect;
    path?: string[];
  };
  native?: {
    viewClass?: string;
    controllerClass?: string;
    controllerPath?: string[];
    windowClass?: string;
    sceneIdentifier?: string;
    matchConfidence?: "exact" | "strong" | "weak" | "none";
  };
  metro?: {
    route?: string;
    component?: string;
    testID?: string;
    source?: string;
  };
}

export function flattenAccessibilityTree(root: AccessibilityNode): AccessibilityNode[] {
  const nodes: AccessibilityNode[] = [];
  const visit = (node: AccessibilityNode) => {
    nodes.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  return nodes;
}

export function compactAccessibilityTree(snapshot: AccessibilitySnapshot): string {
  const nodes = flattenAccessibilityTree(snapshot.root).filter(node =>
    node !== snapshot.root && node.hidden !== true);
  const lines = nodes.map((node, index) => {
    const label = node.label ?? node.title;
    const name = label ? ` "${label.replace(/\s+/g, " ").slice(0, 120)}"` : "";
    const identifier = node.identifier ? ` id=${node.identifier}` : "";
    const frame = node.frame?.normalized;
    const bounds = frame
      ? ` [${frame.x.toFixed(3)},${frame.y.toFixed(3)} ${frame.width.toFixed(3)}x${frame.height.toFixed(3)}]`
      : "";
    const state = [
      node.enabled === false ? "disabled" : "",
      node.focused ? "focused" : "",
      node.valueRedacted ? "secure-value" : "",
    ].filter(Boolean).join(" ");
    return `@${index + 1} ${node.role ?? "element"}${name}${identifier}${bounds}${state ? ` ${state}` : ""}`;
  });
  const screen = snapshot.screen;
  return [
    `screen ${Math.round(screen.width)}x${Math.round(screen.height)} snapshot=${snapshot.snapshotId}`,
    ...lines,
    snapshot.stats.truncated ? "… tree truncated; request a narrower query" : "",
  ].filter(Boolean).join("\n");
}

export function encodeFrame(kind: FrameKind, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, payload.byteLength, false);
  frame.set(payload, 5);
  return frame;
}

export class FrameDecoder {
  #buffer = new Uint8Array();

  push(chunk: Uint8Array): Array<{ kind: FrameKind; payload: Uint8Array }> {
    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    next.set(this.#buffer);
    next.set(chunk, this.#buffer.byteLength);
    this.#buffer = next;
    const frames: Array<{ kind: FrameKind; payload: Uint8Array }> = [];

    while (this.#buffer.byteLength >= 5) {
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      );
      const kind = view.getUint8(0) as FrameKind;
      const length = view.getUint32(1, false);
      if (length > 64 * 1024 * 1024) throw new Error(`Frame exceeds 64 MiB: ${length}`);
      if (this.#buffer.byteLength < 5 + length) break;
      frames.push({ kind, payload: this.#buffer.slice(5, 5 + length) });
      this.#buffer = this.#buffer.slice(5 + length);
    }
    return frames;
  }
}

export function validateNormalizedCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite normalized coordinate from 0 to 1`);
  }
}
