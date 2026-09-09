import { describe, expect, test } from "bun:test";
import type { SimViewClient } from "@simview/client";
import { type IOSAccessibilityStatus, parseDeviceDescription } from "@simview/contracts";
import { SimViewSession } from "../packages/mcp/src/session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const native: IOSAccessibilityStatus = {
  schemaVersion: 1,
  status: "unavailable",
  activeProvider: "core-simulator-ax",
};
const ready: IOSAccessibilityStatus = {
  schemaVersion: 1,
  status: "enhanced-ready",
  activeProvider: "core-simulator-xctest",
  bundleId: "dev.example.app",
};

function fixture() {
  const session = new SimViewSession();
  const device = parseDeviceDescription({
    udid: "recovery",
    name: "Recovery",
    state: "Booted",
    runtime: "iOS",
  });
  let status = native;
  let enable = async (_bundleId?: string): Promise<IOSAccessibilityStatus> => ready;
  const methods: string[] = [];
  const client = {
    connected: true,
    close: async () => {},
    async request(method: string, params?: { bundleId?: string }) {
      methods.push(method);
      if (method === "device.describe") return device;
      if (method === "accessibility.providerStatus") return status;
      if (method === "accessibility.enableXCTestProvider") {
        status = await enable(params?.bundleId);
        return status;
      }
      if (method === "accessibility.disableXCTestProvider") {
        status = native;
        return status;
      }
      throw new Error("Not available in recovery fixture");
    },
  } as unknown as SimViewClient;
  session.client = client;
  session.device = device;
  return {
    session,
    device,
    methods,
    setEnable: (next: typeof enable) => {
      enable = next;
    },
  };
}

describe("explicit accessibility recovery", () => {
  test("retries failed startup on reconnect, including omitted device ID", async () => {
    const f = fixture();
    f.setEnable(async () => {
      throw new Error("No foreground app");
    });
    try {
      expect((await f.session.open()).iosAccessibility?.reason).toBe("No foreground app");
      f.setEnable(async () => ready);
      expect((await f.session.open(f.device.id)).iosAccessibility).toEqual(ready);
      await f.session.open();
      expect(
        f.methods.filter((method) => method === "accessibility.enableXCTestProvider"),
      ).toHaveLength(2);
    } finally {
      await f.session.close();
    }
  });

  test("the relay's same-device selection retries without device discovery", async () => {
    const f = fixture();
    f.session.devices = async () => {
      throw new Error("Should not discover devices on tree refresh");
    };
    try {
      expect((await f.session.selectDevice(f.device.id)).iosAccessibility).toEqual(ready);
    } finally {
      await f.session.close();
    }
  });

  test("deduplicates simultaneous provider startup", async () => {
    const f = fixture();
    const start = deferred<void>();
    const finish = deferred<IOSAccessibilityStatus>();
    f.setEnable(() => {
      start.resolve();
      return finish.promise;
    });
    try {
      const first = f.session.enableIOSAccessibilityProvider();
      await start.promise;
      const second = f.session.enableIOSAccessibilityProvider();
      finish.resolve(ready);
      await Promise.all([first, second]);
      expect(
        f.methods.filter((method) => method === "accessibility.enableXCTestProvider"),
      ).toHaveLength(1);
    } finally {
      await f.session.close();
    }
  });

  test("explicit enable preserves its app when joining automatic recovery", async () => {
    const f = fixture();
    const start = deferred<void>();
    const finish = deferred<IOSAccessibilityStatus>();
    const requested: (string | undefined)[] = [];
    f.setEnable(async (bundleId) => {
      requested.push(bundleId);
      if (requested.length === 1) {
        start.resolve();
        return finish.promise;
      }
      return { ...ready, bundleId };
    });
    try {
      const automatic = f.session.open();
      await start.promise;
      const explicit = f.session.enableIOSAccessibilityProvider("dev.example.other");
      finish.resolve(ready);
      await automatic;
      expect((await explicit).iosAccessibility?.bundleId).toBe("dev.example.other");
      expect(requested).toEqual([undefined, "dev.example.other"]);
    } finally {
      await f.session.close();
    }
  });

  test("explicit disable wins over in-flight startup and subsequent reconnects", async () => {
    const f = fixture();
    const start = deferred<void>();
    const finish = deferred<IOSAccessibilityStatus>();
    f.setEnable(() => {
      start.resolve();
      return finish.promise;
    });
    try {
      const pending = f.session.open();
      await start.promise;
      const disable = f.session.disableIOSAccessibilityProvider();
      finish.resolve(ready);
      await Promise.all([pending, disable]);
      await f.session.open();
      expect(f.session.state().iosAccessibility?.activeProvider).toBe("core-simulator-ax");
      expect(
        f.methods.filter((method) => method === "accessibility.enableXCTestProvider"),
      ).toHaveLength(1);
      await f.session.enableIOSAccessibilityProvider();
      expect(f.session.state().iosAccessibility).toEqual(ready);
    } finally {
      await f.session.close();
    }
  });

  test("a later explicit enable waits for an in-flight disable", async () => {
    const f = fixture();
    const start = deferred<void>();
    const finish = deferred<IOSAccessibilityStatus>();
    f.setEnable(() => {
      start.resolve();
      return finish.promise;
    });
    try {
      const opening = f.session.open();
      await start.promise;
      const disabling = f.session.disableIOSAccessibilityProvider();
      const reenabling = f.session.enableIOSAccessibilityProvider();
      finish.resolve(ready);
      await Promise.all([opening, disabling, reenabling]);
      expect(
        f.methods.filter((method) => method === "accessibility.enableXCTestProvider"),
      ).toHaveLength(2);
      expect(f.session.state().iosAccessibility).toEqual(ready);
    } finally {
      await f.session.close();
    }
  });

  test("does not apply recovery from an old client to its replacement", async () => {
    const f = fixture();
    const start = deferred<void>();
    const finish = deferred<IOSAccessibilityStatus>();
    f.setEnable(() => {
      start.resolve();
      return finish.promise;
    });
    try {
      const pending = f.session.open();
      await start.promise;
      f.session.client = { connected: true, close: async () => {} } as unknown as SimViewClient;
      finish.resolve(ready);
      await pending;
      expect(f.session.state().iosAccessibility).toBeUndefined();
    } finally {
      await f.session.close();
    }
  });

  test("does not apply startup that finishes after close", async () => {
    const f = fixture();
    const start = deferred<void>();
    const finish = deferred<IOSAccessibilityStatus>();
    f.setEnable(() => {
      start.resolve();
      return finish.promise;
    });
    const pending = f.session.open();
    await start.promise;
    const closing = f.session.close();
    finish.resolve(ready);
    await Promise.all([closing, pending.catch(() => {})]);
    expect(f.session.state().iosAccessibility).toBeUndefined();
  });
});
