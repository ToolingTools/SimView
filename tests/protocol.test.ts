import { describe, expect, test } from "bun:test";
import {
  FrameDecoder,
  FrameKind,
  encodeFrame,
  validateNormalizedCoordinate,
} from "@simview/client";

describe("binary protocol", () => {
  test("decodes fragmented and coalesced frames", () => {
    const first = encodeFrame(FrameKind.Response, new TextEncoder().encode('{"id":"1"}'));
    const second = encodeFrame(FrameKind.PngScreenshot, new Uint8Array([1, 2, 3]));
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first);
    combined.set(second, first.length);
    const decoder = new FrameDecoder();
    expect(decoder.push(combined.slice(0, 7))).toHaveLength(0);
    const frames = decoder.push(combined.slice(7));
    expect(frames.map(frame => frame.kind)).toEqual([FrameKind.Response, FrameKind.PngScreenshot]);
    expect([...frames[1]!.payload]).toEqual([1, 2, 3]);
  });

  test("rejects non-normalized input", () => {
    expect(() => validateNormalizedCoordinate(-0.1, "x")).toThrow();
    expect(() => validateNormalizedCoordinate(1.1, "y")).toThrow();
    expect(() => validateNormalizedCoordinate(0.5, "x")).not.toThrow();
  });
});
