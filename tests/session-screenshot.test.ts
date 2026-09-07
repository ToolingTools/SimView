import { describe, expect, test } from "bun:test";
import { FrameKind, type SimViewClient } from "@simview/client";
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

function imageSession(
  client: unknown,
  attach: typeof SimViewClient.attach = async () => client as SimViewClient,
): SimViewSession {
  const session = new SimViewSession(undefined, { attachScreenshotClient: attach });
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
  let closed = false;
  const client = {
    connected: true,
    socketPath: "/unused-test-socket",
    token: "test",
    on(kind: FrameKind, handler: (payload: Uint8Array) => void) {
      const handlers = listeners.get(kind) ?? new Set();
      handlers.add(handler);
      listeners.set(kind, handlers);
      return () => handlers.delete(handler);
    },
    request,
    close: async () => {
      closed = true;
    },
  };
  return {
    client,
    get closed() {
      return closed;
    },
    emit(kind: FrameKind, bytes: Uint8Array) {
      for (const listener of listeners.get(kind) ?? []) listener(bytes);
    },
    listenerCount(kind: FrameKind) {
      return listeners.get(kind)?.size ?? 0;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const screenshotMetadata = { frameId: "fresh", width: 10, height: 10, byteLength: 1 };

async function waitForListener(fake: ReturnType<typeof fakeImageClient>) {
  for (let i = 0; i < 100 && !fake.listenerCount(FrameKind.PngScreenshot); i++) await Bun.sleep(1);
  expect(fake.listenerCount(FrameKind.PngScreenshot)).toBe(1);
}

describe("isolated screenshot transport", () => {
  test("coalesces concurrent callers and keeps the primary connection alive", async () => {
    const metadata = deferred<unknown>();
    const primary = fakeImageClient(async () => {
      throw new Error("primary must not capture");
    });
    const capture = fakeImageClient(() => metadata.promise);
    let attaches = 0;
    const session = imageSession(primary.client, async () => {
      attaches++;
      return capture.client as unknown as SimViewClient;
    });
    const first = session.screenshot();
    const second = session.screenshot();
    await waitForListener(capture);
    capture.emit(FrameKind.PngScreenshot, new Uint8Array([42]));
    metadata.resolve(screenshotMetadata);
    expect(await first).toEqual(await second);
    expect(attaches).toBe(1);
    expect(capture.closed).toBe(true);
    expect(primary.closed).toBe(false);
    expect(capture.listenerCount(FrameKind.PngScreenshot)).toBe(0);
  });

  test("does not pair a timed-out request's late payload with retry metadata", async () => {
    const metadata = deferred<unknown>();
    const primary = fakeImageClient(async () => ({}));
    const old = fakeImageClient(() => metadata.promise);
    const fresh = fakeImageClient(async () => screenshotMetadata);
    const connections = [old, fresh];
    const session = imageSession(primary.client, async () => {
      const connection = connections.shift();
      if (!connection) throw new Error("Unexpected screenshot attachment");
      return connection.client as unknown as SimViewClient;
    });
    const first = session.screenshot();
    const rejected = first.catch((error: unknown) => error);
    await waitForListener(old);
    metadata.reject(new Error("metadata deadline"));
    expect(await rejected).toMatchObject({ message: "metadata deadline" });
    const retry = session.screenshot();
    await waitForListener(fresh);
    old.emit(FrameKind.PngScreenshot, new Uint8Array([1]));
    fresh.emit(FrameKind.PngScreenshot, new Uint8Array([2]));
    expect((await retry).bytes).toEqual(new Uint8Array([2]));
    expect(old.closed).toBe(true);
    expect(session.frameId).toBe("fresh");
  });

  test("allows slow metadata before starting the payload deadline", async () => {
    const metadata = deferred<unknown>();
    const capture = fakeImageClient(() => metadata.promise);
    const session = imageSession(capture.client);
    const result = session.screenshot();
    await waitForListener(capture);
    await Bun.sleep(5_050);
    expect(capture.listenerCount(FrameKind.PngScreenshot)).toBe(1);
    metadata.resolve(screenshotMetadata);
    capture.emit(FrameKind.PngScreenshot, new Uint8Array([3]));
    expect((await result).bytes).toEqual(new Uint8Array([3]));
  }, 7_000);

  test("closes a transport whose metadata succeeds but payload never arrives", async () => {
    const capture = fakeImageClient(async () => screenshotMetadata);
    const session = imageSession(capture.client);
    await expect(session.screenshot()).rejects.toThrow("PNG screenshot payload");
    expect(capture.closed).toBe(true);
    expect(capture.listenerCount(FrameKind.PngScreenshot)).toBe(0);
  }, 7_000);

  test("cancels metadata and releases its payload listener on session close", async () => {
    const started = deferred<void>();
    const primary = fakeImageClient(async () => ({}));
    let signal: AbortSignal | undefined;
    const capture = fakeImageClient(async () => {
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }),
      );
    });
    const session = imageSession(primary.client, async (_path, _token, _codec, options) => {
      signal = options?.signal;
      return capture.client as unknown as SimViewClient;
    });
    const result = session.screenshot().catch((error: unknown) => error);
    await started.promise;
    await session.close();
    expect(await result).toMatchObject({ message: "Screenshot connection released" });
    expect(capture.closed).toBe(true);
    expect(capture.listenerCount(FrameKind.PngScreenshot)).toBe(0);
    capture.emit(FrameKind.PngScreenshot, new Uint8Array([1]));
    expect(session.frameId).toBeUndefined();
  });

  test("cancels an attachment while the session closes", async () => {
    const started = deferred<void>();
    const primary = fakeImageClient(async () => ({}));
    const session = imageSession(primary.client, async (_path, _token, _codec, options) => {
      started.resolve();
      return new Promise<SimViewClient>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const screenshot = session.screenshot();
    const rejected = screenshot.catch((error: unknown) => error);
    await started.promise;
    await session.close();
    expect(await rejected).toMatchObject({ message: "Screenshot connection released" });
    expect(session.frameId).toBeUndefined();
  });
});
