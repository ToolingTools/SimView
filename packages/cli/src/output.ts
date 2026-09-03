import {
  type DeviceDescription,
  type ElementTreeOutput,
  parseDeviceDescription,
} from "@simview/contracts";
import { compactAccessibilityTree } from "../../client/src/protocol";

export function formatElementTree(result: ElementTreeOutput): string {
  const context = result.screenContext;
  let summary: string;
  if (context.kind === "react-native") {
    const screen = context.navigationPath?.length
      ? context.navigationPath.join(" > ")
      : context.route;
    summary = [
      `source=react-native-fiber renderer=${context.renderer}`,
      screen ? `screen=${screen}` : undefined,
      context.screenComponent ? `component=${context.screenComponent}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  } else {
    const fallbackDetail = result.fallback?.detail ? ` detail=${result.fallback.detail}` : "";
    const fallback = result.fallback ? ` fallback=${result.fallback.reason}${fallbackDetail}` : "";
    summary = `context=${context.kind} elements=${result.snapshot.source}${fallback}`;
  }
  return `${summary}\n${compactAccessibilityTree(result.snapshot)}`;
}

export function filterDeviceList(value: unknown, bootedOnly: boolean): DeviceDescription[] {
  if (!Array.isArray(value)) throw new Error("Device discovery returned an invalid response");
  const devices = value.map(parseDeviceDescription);
  if (!bootedOnly) return devices;
  return devices.filter(
    (device) =>
      device.available &&
      device.state === "ready" &&
      (device.kind === "simulator" || device.kind === "emulator"),
  );
}
