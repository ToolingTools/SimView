export const XCTEST_SNAPSHOT_MARKER = "SIMVIEW_XCTEST_SNAPSHOT_V1:";

export interface XCTestProbeCapture {
  sequence: number;
  captureDurationMs: number;
  root: Record<string, unknown>;
}

export interface XCTestProbeResult {
  schemaVersion: 1;
  provider: "core-simulator-xctest-probe";
  bundleId: string;
  captures: XCTestProbeCapture[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeXCTestProbeLog(log: string): XCTestProbeResult {
  const markedLine = log.split(/\r?\n/u).find((line) => line.includes(XCTEST_SNAPSHOT_MARKER));
  const encoded = markedLine?.slice(
    markedLine.indexOf(XCTEST_SNAPSHOT_MARKER) + XCTEST_SNAPSHOT_MARKER.length,
  );
  if (!encoded) throw new Error("XCTest probe emitted no marked snapshot");

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
  } catch {
    throw new Error("XCTest probe emitted an invalid snapshot payload");
  }
  if (
    !isRecord(decoded) ||
    decoded.schemaVersion !== 1 ||
    decoded.provider !== "core-simulator-xctest-probe" ||
    typeof decoded.bundleId !== "string" ||
    !Array.isArray(decoded.captures) ||
    decoded.captures.length === 0
  ) {
    throw new Error("XCTest probe snapshot has an unsupported envelope");
  }

  const seenSequences = new Set<number>();
  for (const capture of decoded.captures) {
    if (
      !isRecord(capture) ||
      !Number.isSafeInteger(capture.sequence) ||
      typeof capture.captureDurationMs !== "number" ||
      capture.captureDurationMs < 0 ||
      !isRecord(capture.root) ||
      seenSequences.has(capture.sequence as number)
    ) {
      throw new Error("XCTest probe snapshot contains an invalid capture");
    }
    seenSequences.add(capture.sequence as number);
  }

  return decoded as unknown as XCTestProbeResult;
}
