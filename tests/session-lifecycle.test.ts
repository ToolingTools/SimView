import { describe, expect, spyOn, test } from "bun:test";
import { SimViewClient } from "@simview/client";
import { parseDeviceDescription } from "@simview/contracts";
import { SimViewSession } from "../packages/mcp/src/session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("review shutdown races", () => {
  test("disposes a native client acquired after its review closed", async () => {
    const session = new SimViewSession();
    const device = parseDeviceDescription({
      udid: "late-client",
      name: "Late",
      state: "Booted",
      runtime: "iOS",
    });
    session.devices = async () => [device];
    const pending = deferred<SimViewClient>();
    const acquiring = deferred<void>();
    let closes = 0;
    const client = {
      close: async () => {
        closes += 1;
      },
    } as unknown as SimViewClient;
    const acquire = spyOn(SimViewClient, "acquire").mockImplementation(() => {
      acquiring.resolve();
      return pending.promise;
    });
    try {
      const opening = session.open(device.id);
      const result = opening.catch((error: unknown) => error);
      await acquiring.promise;
      const closing = session.close();
      pending.resolve(client);
      await closing;
      expect(await result).toBeInstanceOf(Error);
      expect(String(await result)).toContain("review is closed");
      expect(closes).toBe(1);
      expect(session.client).toBeUndefined();
      expect(session.relay).toBeUndefined();
      await expect(session.open(device.id)).rejects.toThrow("review is closed");
    } finally {
      acquire.mockRestore();
      await session.close();
    }
  });

  test("does not start a backend after device discovery finishes for a closed review", async () => {
    const session = new SimViewSession();
    const inventory = deferred<ReturnType<typeof parseDeviceDescription>[]>();
    const discovering = deferred<void>();
    session.devices = () => {
      discovering.resolve();
      return inventory.promise;
    };
    const acquire = spyOn(SimViewClient, "acquire");
    try {
      const opening = session.open();
      const result = opening.catch((error: unknown) => error);
      await discovering.promise;
      const closing = session.close();
      inventory.resolve([]);
      await closing;
      expect(await result).toBeInstanceOf(Error);
      expect(String(await result)).toContain("review is closed");
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      acquire.mockRestore();
      await session.close();
    }
  });

  test("releases packet demand when a backend disconnects during a packet request", async () => {
    const session = new SimViewSession();
    const device = parseDeviceDescription({
      udid: "preview-reconnect",
      name: "Preview",
      state: "Booted",
      runtime: "iOS",
    });
    session.devices = async () => [device];
    let disconnected = () => {};
    let hangPreview = true;
    const previewStarted = deferred<void>();
    const enabled: boolean[] = [];
    const client = {
      connected: true,
      onDisconnect(callback: () => void) {
        disconnected = callback;
        return () => {};
      },
      on: () => () => {},
      close: async () => {},
      async request(
        method: string,
        params: { enabled?: boolean },
        options?: { signal?: AbortSignal },
      ) {
        if (method === "capture.start") return { device };
        if (method === "accessibility.providerStatus")
          return { schemaVersion: 1, status: "native-ready", activeProvider: "core-simulator-ax" };
        if (method === "capture.preview") {
          enabled.push(params.enabled === true);
          if (hangPreview) {
            previewStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }
          return { enabled: params.enabled };
        }
        if (method === "capture.keyframe") return { accepted: true };
        throw new Error("Unavailable in lifecycle fixture");
      },
    } as unknown as SimViewClient;
    const acquire = spyOn(SimViewClient, "acquire").mockResolvedValue(client);
    try {
      await session.open(device.id);
      const pending = session.previewPackets(undefined, 1, 50).catch((error: unknown) => error);
      await previewStarted.promise;
      disconnected();
      expect(
        await Promise.race([pending, Bun.sleep(500).then(() => "not cancelled")]),
      ).toBeInstanceOf(Error);
      hangPreview = false;
      await session.open(device.id);
      await session.previewPackets(undefined, 1, 50);
      await Bun.sleep(5_100);
      expect(enabled.at(-1)).toBe(false);
    } finally {
      acquire.mockRestore();
      await session.close();
    }
  }, 10_000);

  test("rejects device discovery started after review close", async () => {
    const session = new SimViewSession();
    await session.close();
    await expect(session.devices()).rejects.toThrow("review is closed");
  });
});

describe("input dispatch lifecycle", () => {
  test("distinguishes a pre-dispatch unsupported action from transport uncertainty", async () => {
    const session = new SimViewSession();
    const device = parseDeviceDescription({
      udid: "input-receipt",
      name: "Input Receipt",
      state: "Booted",
      runtime: "iOS",
    });
    let connected = true;
    let requests = 0;
    session.device = {
      ...device,
      capabilities: {
        ...device.capabilities,
        input: { ...device.capabilities.input, touch: false, rawTouch: false },
      },
    };
    session.client = {
      get connected() {
        return connected;
      },
      request: async () => {
        requests += 1;
        connected = false;
        throw new Error("simview-core connection closed");
      },
      close: async () => {},
    } as unknown as SimViewClient;

    try {
      expect(
        await session.dispatchInputReceipt({
          method: "input.longPress",
          params: { x: 0.5, y: 0.5, durationMs: 600 },
        }),
      ).toMatchObject({
        accepted: false,
        inputDispatched: false,
        retryInput: false,
        recoveryAction: "use_supported_input",
        code: "input_unsupported",
      });
      expect(requests).toBe(0);

      session.device = device;
      expect(
        await session.dispatchInputReceipt({
          method: "input.longPress",
          params: { x: 0.5, y: 0.5, durationMs: 600 },
        }),
      ).toMatchObject({
        accepted: false,
        inputDispatched: true,
        safeToContinue: false,
        retryable: false,
        retryInput: false,
        recoveryAllowed: true,
        recoveryAction: "reconnect_then_observe",
        code: "input_dispatch_uncertain",
      });
      expect(requests).toBe(1);

      expect(
        await session.dispatchInputReceipt({
          method: "input.tap",
          params: { x: 0.5, y: 0.5 },
        }),
      ).toMatchObject({
        accepted: false,
        inputDispatched: false,
        retryInput: false,
        recoveryAction: "connect_device",
        code: "input_unavailable",
      });
      expect(requests).toBe(1);
    } finally {
      await session.close();
    }
  });
});
