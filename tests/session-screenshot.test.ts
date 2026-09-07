import { describe, expect, test } from "bun:test";
import { FrameKind } from "@simview/client";
import { SimViewSession } from "../packages/mcp/src/session";

describe("session image waits", () => {
  test("removes the screenshot payload listener when metadata fails", async () => {
    const fake = fakeImageClient(async () => {
      throw new Error("capture request failed");
    });
    const session = imageSession(fake.client);

    await expect(session.screenshot()).rejects.toThrow("capture request failed");
    expect(fake.listenerCount(FrameKind.PngScreenshot)).toBe(0);
  });

  test("removes the prepared image listener when observation metadata fails", async () => {
    const fake = fakeImageClient(async () => {
      throw new Error("observation request failed");
    });
    const session = imageSession(fake.client);

    await expect(session.warmObservation({ visual: true, maxWaitMs: 20 })).rejects.toThrow(
      "observation request failed",
    );
    expect(fake.listenerCount(FrameKind.PreparedImage)).toBe(0);
  });
});

function imageSession(client: unknown): SimViewSession {
  const session = new SimViewSession();
  session.client = client as SimViewSession["client"];
  session.device = {
    id: "ios:test",
    platform: "ios",
    kind: "simulator",
    state: "ready",
    available: true,
    name: "Test Simulator",
    runtime: "iOS 26.5",
    udid: "test",
    capabilities: {
      capture: { h264: true, mjpeg: true, screenshot: true },
      input: {
        touch: true,
        rawTouch: true,
        multiTouch: false,
        text: "unicode",
        keys: [],
        buttons: [],
      },
      orientation: true,
      accessibility: true,
      androidContext: false,
      uikitProbe: false,
    },
  };
  return session;
}

function fakeImageClient(request: (method: string) => Promise<unknown>) {
  const listeners = new Map<FrameKind, Set<(payload: Uint8Array) => void>>();
  const client = {
    connected: true,
    on(kind: FrameKind, handler: (payload: Uint8Array) => void) {
      const handlers = listeners.get(kind) ?? new Set();
      handlers.add(handler);
      listeners.set(kind, handlers);
      return () => handlers.delete(handler);
    },
    request,
    close: async () => {},
  };
  return {
    client,
    listenerCount(kind: FrameKind) {
      return listeners.get(kind)?.size ?? 0;
    },
  };
}
