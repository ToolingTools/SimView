import { describe, expect, test } from "bun:test";
import {
  decodeXCTestProbeLog,
  XCTEST_SNAPSHOT_MARKER,
  type XCTestProbeResult,
} from "../scripts/xctest-probe-result";

function markedLog(result: unknown): string {
  const encoded = Buffer.from(JSON.stringify(result)).toString("base64");
  return `test noise\n${XCTEST_SNAPSHOT_MARKER}${encoded}\nmore noise`;
}

const validResult: XCTestProbeResult = {
  schemaVersion: 1,
  provider: "core-simulator-xctest-probe",
  bundleId: "dev.example.app",
  captures: [
    {
      sequence: 0,
      captureDurationMs: 42,
      root: { children: [], elementType: 2 },
    },
  ],
};

describe("decodeXCTestProbeLog", () => {
  test("extracts and validates a marked snapshot", () => {
    expect(decodeXCTestProbeLog(markedLog(validResult))).toEqual(validResult);
  });

  test("rejects logs without a marked snapshot", () => {
    expect(() => decodeXCTestProbeLog("** TEST SUCCEEDED **")).toThrow("no marked snapshot");
  });

  test("rejects malformed and unsupported envelopes", () => {
    expect(() => decodeXCTestProbeLog(`${XCTEST_SNAPSHOT_MARKER}not-base64`)).toThrow(
      "invalid snapshot payload",
    );
    expect(() => decodeXCTestProbeLog(markedLog({ ...validResult, schemaVersion: 2 }))).toThrow(
      "unsupported envelope",
    );
    expect(() => decodeXCTestProbeLog(markedLog({ ...validResult, captures: [] }))).toThrow(
      "unsupported envelope",
    );
  });

  test("rejects invalid or duplicate captures", () => {
    expect(() =>
      decodeXCTestProbeLog(
        markedLog({
          ...validResult,
          captures: [validResult.captures[0], validResult.captures[0]],
        }),
      ),
    ).toThrow("invalid capture");
    expect(() =>
      decodeXCTestProbeLog(
        markedLog({ ...validResult, captures: [{ sequence: 0, captureDurationMs: -1, root: {} }] }),
      ),
    ).toThrow("invalid capture");
  });
});
