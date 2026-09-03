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
});
