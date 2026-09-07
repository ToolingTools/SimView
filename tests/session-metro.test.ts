import { describe, expect, test } from "bun:test";
import type { SimViewClient } from "@simview/client";
import { type AccessibilitySnapshot, parseDeviceDescription } from "@simview/contracts";
import { MetroInspector } from "../packages/mcp/src/metro";
import { SimViewSession } from "../packages/mcp/src/session";

const mkm = "com.mkm.ecommerce.test";
const spenny = "studio.churro.spenny";

function fixture(metroAvailable = true, connectedProbe = false) {
  let probeContextReads = 0;
  let afterNativeSnapshot: (() => void) | undefined;
  let app: string | undefined = mkm;
  let evaluations = 0;
  let scans = 0;
  const inspector = new MetroInspector({
    scan: async () => {
      scans++;
      return metroAvailable
        ? [
            {
              host: "localhost",
              port: 8081,
              targets: [
                {
                  id: "metro-app",
                  title: "MKM",
                  description: "React Native Bridgeless",
                  type: "node",
                  appId: mkm,
                  deviceName: "iPhone 17 Pro",
                  reactNative: {
                    logicalDeviceId: "opaque-metro-connection-hash",
                    capabilities: { supportsMultipleDebuggers: true },
                  },
                  webSocketDebuggerUrl: "ws://localhost:8081/app",
                },
              ],
            },
          ]
        : [];
    },
    status: async () => null,
    connect: async () => ({
      isConnected: true,
      close() {},
      async send<T>(_method: string, params?: Record<string, unknown>): Promise<T> {
        if (String(params?.expression).includes("Promise.resolve")) evaluations++;
        return {
          result: {
            value: {
              state: "fulfilled",
              value: {
                renderer: "fabric",
                root: { ref: "rn:mkm", role: "AXButton", label: "MKM account" },
                nodeCount: 1,
                truncated: false,
                reasons: ["host-measurement-incomplete"],
                screen: { route: "Account", confidence: "exact" },
              },
            },
          },
        } as T;
      },
    }),
  });
  const session = new SimViewSession(undefined, { metroInspector: inspector });
  session.device = parseDeviceDescription({
    udid: "SIM-123",
    name: "iPhone 17 Pro",
    state: "Booted",
    runtime: "iOS 26.5",
  });
  session.client = {
    connected: true,
    async request(method: string) {
      if (method === "probe.target") return { source: "simctl", bundleId: app };
      if (method === "probe.status") return { connected: connectedProbe, bundleId: mkm };
      if (method === "probe.context") {
        probeContextReads++;
        throw new Error("Background probe must not be read");
      }
      if (method === "accessibility.snapshot") {
        const snapshot = nativeSnapshot(app);
        afterNativeSnapshot?.();
        return snapshot;
      }
      throw new Error(`Unexpected ${method}`);
    },
    async close() {},
  } as unknown as SimViewClient;
  return {
    session,
    afterNativeSnapshot(callback: () => void) {
      afterNativeSnapshot = callback;
    },
    setApp(value: string | undefined) {
      app = value;
    },
    get probeContextReads() {
      return probeContextReads;
    },
    get evaluations() {
      return evaluations;
    },
    get scans() {
      return scans;
    },
  };
}

function nativeSnapshot(app?: string): AccessibilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: `native-${app}`,
    capturedAt: new Date().toISOString(),
    source: "core-simulator-xctest",
    scope: "interactive",
    screen: { x: 0, y: 0, width: 430, height: 932 },
    root: {
      ref: `ax:${app}`,
      role: "AXButton",
      label: app === spenny ? "Spenny budget" : "Native account",
    },
    stats: { nodeCount: 1, truncated: false, quality: "complete" },
  };
}

describe("foreground app enrichment", () => {
  test("discards native output if the foreground changes during capture", async () => {
    const f = fixture(false);
    f.afterNativeSnapshot(() => f.setApp(spenny));
    try {
      await expect(f.session.elementSnapshot()).rejects.toThrow("Semantic state changed");
      const recovered = await f.session.accessibilityElementSnapshot();
      expect(recovered.screenContext.bundleId).toBe(spenny);
      expect(recovered.snapshot.root.label).toBe("Spenny budget");
    } finally {
      await f.session.close();
    }
  });
  test("does not merge background probe context into the foreground native app", async () => {
    const f = fixture(false, true);
    f.setApp(spenny);
    try {
      const result = await f.session.elementSnapshot();
      expect(result.screenContext.bundleId).toBe(spenny);
      expect(f.probeContextReads).toBe(0);
    } finally {
      await f.session.close();
    }
  });
  test("switches MKM to Spenny and back while Metro remains available", async () => {
    const f = fixture();
    const first = await f.session.preparedElementSnapshot();
    expect(first.snapshot.source).toBe("react-native-fiber");
    expect(first.snapshot.stats).toMatchObject({
      quality: "partial",
      reason: "host-measurement-incomplete",
    });
    expect((await f.session.preparedElementSnapshot()).snapshot.snapshotId).toBe(
      first.snapshot.snapshotId,
    );
    f.setApp(spenny);
    const native = await f.session.preparedElementSnapshot();
    expect(native.snapshot.source).toBe("core-simulator-xctest");
    expect(native.snapshot.stats.quality).toBe("complete");
    expect(native.screenContext).toMatchObject({ kind: "native-ios", bundleId: spenny });
    expect(JSON.stringify(native)).not.toContain("Account");
    expect(f.evaluations).toBe(1);
    f.setApp(mkm);
    const back = await f.session.preparedElementSnapshot();
    expect(back.snapshot.source).toBe("react-native-fiber");
    expect(f.evaluations).toBe(2);
    await f.session.close();
  });

  test("unknown identity cannot reuse a cached Fiber tree or old refs", async () => {
    const f = fixture();
    await f.session.preparedElementSnapshot();
    f.setApp(undefined);
    const found = await f.session.findElements({ ref: "rn:mkm", exact: true });
    expect(found.count).toBe(0);
    expect(f.session.lastElements?.source).toBe("core-simulator-xctest");
    expect(f.evaluations).toBe(1);
    await f.session.close();
  });

  test("no Metro preserves complete native output without evaluation waits", async () => {
    const f = fixture(false);
    f.setApp(spenny);
    const start = performance.now();
    const result = await f.session.elementSnapshot();
    expect(result.snapshot.source).toBe("core-simulator-xctest");
    expect(result.snapshot.stats.quality).toBe("complete");
    expect(result.fallback?.detail).toBe("metro-unreachable");
    expect(f.evaluations).toBe(0);
    expect(performance.now() - start).toBeLessThan(250);
    await f.session.close();
  });
});
