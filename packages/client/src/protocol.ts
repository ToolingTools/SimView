import {
  type AccessibilitySnapshot,
  type ElementSnapshot,
  flattenAccessibilityTree,
  MAXIMUM_FRAME_BYTES,
} from "@simview/contracts";

export * from "@simview/contracts";

export enum FrameKind {
  Request = 0x01,
  Response = 0x02,
  H264Configuration = 0x10,
  H264Frame = 0x11,
  JpegFrame = 0x12,
  PngScreenshot = 0x20,
}

export function compactAccessibilityTree(
  snapshot: AccessibilitySnapshot | ElementSnapshot,
): string {
  const nodes = flattenAccessibilityTree(snapshot.root).filter(
    (node) => node !== snapshot.root && node.hidden !== true,
  );
  const lines = nodes.map((node, index) => {
    const label = node.label ?? node.title;
    const name = label ? ` "${label.replace(/\s+/g, " ").slice(0, 120)}"` : "";
    const identifierValue = node.testID ?? node.identifier;
    const identifier = identifierValue ? ` id=${identifierValue}` : "";
    const component = node.component ? ` component=${node.component}` : "";
    const host = node.hostComponent ? ` host=${node.hostComponent}` : "";
    const source = node.sourceLocation
      ? ` source=${node.sourceLocation.file}${node.sourceLocation.line ? `:${node.sourceLocation.line}` : ""}`
      : "";
    const frame = node.frame?.normalized;
    const bounds = frame
      ? ` [${frame.x.toFixed(3)},${frame.y.toFixed(3)} ${frame.width.toFixed(3)}x${frame.height.toFixed(3)}]`
      : "";
    const state = [
      node.enabled === false ? "disabled" : "",
      node.focused ? "focused" : "",
      node.valueRedacted ? "secure-value" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `@${index + 1} ${node.role ?? "element"}${name}${identifier}${component}${host}${source}${bounds}${state ? ` ${state}` : ""}`;
  });
  const screen = snapshot.screen;
  return [
    `screen ${Math.round(screen.width)}x${Math.round(screen.height)} snapshot=${snapshot.snapshotId}`,
    ...lines,
    snapshot.stats.truncated ? "… tree truncated; request a narrower query" : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  #chunks: Uint8Array[] = [];
  #available = 0;

  push(chunk: Uint8Array): Array<{ kind: FrameKind; payload: Uint8Array }> {
    if (chunk.byteLength > 0) {
      this.#chunks.push(chunk);
      this.#available += chunk.byteLength;
    }

    const frames: Array<{ kind: FrameKind; payload: Uint8Array }> = [];
    while (this.#available >= 5) {
      const header = this.#peek(5);
      const kind = header[0] as FrameKind;
      const length = new DataView(header.buffer, header.byteOffset, 5).getUint32(1, false);
      if (length > MAXIMUM_FRAME_BYTES) {
        throw new Error(`Frame exceeds 64 MiB: ${length}`);
      }
      if (this.#available < 5 + length) break;
      this.#consume(5);
      frames.push({ kind, payload: this.#consume(length) });
    }
    return frames;
  }

  #peek(length: number): Uint8Array {
    const first = this.#chunks[0];
    if (first && first.byteLength >= length) return first.subarray(0, length);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const count = Math.min(chunk.byteLength, length - offset);
      result.set(chunk.subarray(0, count), offset);
      offset += count;
      if (offset === length) break;
    }
    return result;
  }

  #consume(length: number): Uint8Array {
    if (length === 0) return new Uint8Array();
    const first = this.#chunks[0];
    if (first && first.byteLength >= length) {
      const result = first.slice(0, length);
      if (first.byteLength === length) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(length);
      this.#available -= length;
      return result;
    }

    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const current = this.#chunks[0];
      if (!current) throw new Error("Frame decoder buffer underflow");
      const count = Math.min(current.byteLength, length - offset);
      result.set(current.subarray(0, count), offset);
      offset += count;
      if (count === current.byteLength) this.#chunks.shift();
      else this.#chunks[0] = current.subarray(count);
    }
    this.#available -= length;
    return result;
  }
}

export function validateNormalizedCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite normalized coordinate from 0 to 1`);
  }
}
