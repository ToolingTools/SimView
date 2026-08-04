import { describe, expect, test } from "bun:test";
import { type ElementTreeOutput, parseDeviceDescription } from "@simview/contracts";
import { filterDeviceList, formatElementTree } from "../packages/cli/src/index";

describe("CLI device list filtering", () => {
  const iosCapabilities = {
    capture: { h264: true, mjpeg: true, screenshot: true },
    input: {
      touch: true,
      rawTouch: true,
      text: "unicode" as const,
      buttons: ["home" as const],
    },
    orientation: true,
    accessibility: true,
    androidContext: false,
    uikitProbe: true,
  };
  const androidCapabilities = {
    ...iosCapabilities,
    input: { ...iosCapabilities.input, text: "ascii" as const, buttons: ["back" as const] },
    androidContext: true,
    uikitProbe: false,
  };
  const devices = [
    parseDeviceDescription({
      id: "ios:BOOTED",
      platform: "ios",
      kind: "simulator",
      state: "ready",
      available: true,
      udid: "BOOTED",
      name: "iPhone 17 Pro",
      runtime: "iOS 26",
      capabilities: iosCapabilities,
    }),
    parseDeviceDescription({
      id: "ios:SHUTDOWN",
      platform: "ios",
      kind: "simulator",
      state: "shutdown",
      available: false,
      udid: "SHUTDOWN",
      name: "iPhone 17",
      runtime: "iOS 26",
      capabilities: iosCapabilities,
    }),
    parseDeviceDescription({
      id: "android:emulator-5554",
      platform: "android",
      kind: "emulator",
      state: "ready",
      available: true,
      serial: "emulator-5554",
      name: "Pixel 9 Pro XL",
      runtime: "Android 16",
      capabilities: androidCapabilities,
    }),
    parseDeviceDescription({
      id: "android:R58M1234",
      platform: "android",
      kind: "physical",
      state: "ready",
      available: true,
      serial: "R58M1234",
      name: "Pixel device",
      runtime: "Android 15",
      capabilities: androidCapabilities,
    }),
  ];

  test("keeps the complete inventory by default", () => {
    expect(filterDeviceList(devices, false)).toEqual(devices);
  });

  test("returns only booted virtual devices when requested", () => {
    expect(filterDeviceList(devices, true).map((device) => device.id)).toEqual([
      "ios:BOOTED",
      "android:emulator-5554",
    ]);
  });

  test("rejects malformed native device output", () => {
    expect(() => filterDeviceList({ devices: [] }, true)).toThrow(
      "Device discovery returned an invalid response",
    );
  });
});

describe("CLI element tree output", () => {
  test("identifies the React Native renderer and focused screen", () => {
    const result: ElementTreeOutput = {
      snapshot: {
        schemaVersion: 1,
        snapshotId: "fiber-1",
        capturedAt: "2026-07-31T10:00:00.000Z",
        source: "react-native-fiber",
        scope: "interactive",
        screen: { x: 0, y: 0, width: 430, height: 932 },
        root: { ref: "rn:root" },
        stats: { nodeCount: 1, truncated: false },
        metro: {
          host: "127.0.0.1",
          port: 8081,
          targetId: "target-1",
          targetTitle: "Shop",
          renderer: "fabric",
        },
      },
      screenContext: {
        schemaVersion: 1,
        kind: "react-native",
        capturedAt: "2026-07-31T10:00:00.000Z",
        frameId: "frame-1",
        renderer: "fabric",
        target: "Shop",
        route: "ShopMenuRoot",
        navigationPath: ["Tabs", "ShopTab", "ShopMenuRoot"],
        screenComponent: "ShopMenuScreen",
        confidence: "exact",
      },
    };

    expect(formatElementTree(result).split("\n")[0]).toBe(
      "source=react-native-fiber renderer=fabric screen=Tabs > ShopTab > ShopMenuRoot component=ShopMenuScreen",
    );
  });

  test("identifies a diagnostic AX fallback", () => {
    const result: ElementTreeOutput = {
      snapshot: {
        schemaVersion: 1,
        snapshotId: "ax-1",
        capturedAt: "2026-07-31T10:00:00.000Z",
        source: "core-simulator-ax",
        scope: "interactive",
        screen: { x: 0, y: 0, width: 430, height: 932 },
        root: { ref: "ax:root" },
        stats: { nodeCount: 1, truncated: false },
      },
      screenContext: {
        schemaVersion: 1,
        kind: "uikit",
        capturedAt: "2026-07-31T10:00:00.000Z",
        frameId: "frame-1",
      },
      fallback: { reason: "metro-target-unavailable" },
    };

    expect(formatElementTree(result).split("\n")[0]).toBe(
      "source=core-simulator-ax fallback=metro-target-unavailable",
    );
  });

  test("identifies Android UIAutomator output", () => {
    const result: ElementTreeOutput = {
      snapshot: {
        schemaVersion: 1,
        snapshotId: "android-1",
        capturedAt: "2026-08-04T10:00:00.000Z",
        source: "android-uiautomator",
        scope: "interactive",
        screen: { x: 0, y: 0, width: 1080, height: 2400 },
        root: { ref: "android:root" },
        stats: { nodeCount: 1, truncated: false },
      },
      screenContext: {
        schemaVersion: 1,
        kind: "android",
        platform: "android",
        capturedAt: "2026-08-04T10:00:00.000Z",
        frameId: "frame-android",
        packageName: "com.example.app",
        activityName: ".MainActivity",
      },
    };

    expect(formatElementTree(result).split("\n")[0]).toBe("source=android-uiautomator");
  });
});
