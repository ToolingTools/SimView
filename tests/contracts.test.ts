import { describe, expect, test } from "bun:test";
import {
  accessibilitySelectorSchema,
  inspectPointOutputSchema,
  methodSchemas,
  parseMethodParams,
  parseMethodResult,
  protocolResponseSchema,
  sessionStateSchema,
} from "@simview/contracts";

describe("shared protocol contracts", () => {
  test("round-trips the canonical hello fixture", async () => {
    const fixture = (await Bun.file("tests/fixtures/protocol/hello.json").json()) as {
      request: { params: unknown };
      response: unknown;
    };
    const params = parseMethodParams("hello", fixture.request.params);
    const response = protocolResponseSchema.parse(fixture.response);
    const result = parseMethodResult("hello", response.result);

    expect(params.codecs).toEqual(["h264", "mjpeg"]);
    expect(result.codec).toBe("h264");
    expect(result.protocolVersion).toBe(1);
  });

  test("rejects empty accessibility selectors", () => {
    expect(accessibilitySelectorSchema.safeParse({}).success).toBe(false);
    expect(accessibilitySelectorSchema.parse({ identifier: "submit" }).exact).toBe(true);
  });

  test("uses visible and hidden as the only wait states", () => {
    const base = {
      selector: { identifier: "submit" },
      timeoutMs: 1_000,
    };
    expect(
      methodSchemas["accessibility.wait"].params.safeParse({
        ...base,
        state: "visible",
      }).success,
    ).toBe(true);
    expect(
      methodSchemas["accessibility.wait"].params.safeParse({
        ...base,
        state: "absent",
      }).success,
    ).toBe(false);
  });

  test("rejects out-of-range input at the protocol boundary", () => {
    expect(methodSchemas["input.tap"].params.safeParse({ x: 1.1, y: 0.5 }).success).toBe(false);
  });

  test("keeps relay secrets out of model-visible session state", () => {
    const state = sessionStateSchema.parse({
      reviewId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      annotations: [],
      codec: "h264",
      connected: true,
      relayToken: "must-not-survive",
      browserUrl: "http://127.0.0.1/#token=must-not-survive",
    });
    expect(state).toEqual({
      reviewId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      annotations: [],
      codec: "h264",
      connected: true,
    });
  });

  test("wraps point inspection as an element instead of mislabeling it as a snapshot", () => {
    const output = inspectPointOutputSchema.parse({
      element: { ref: "node:1", role: "button" },
      probe: { bundled: true, connected: false },
    });
    expect(output.element.ref).toBe("node:1");
    expect(() =>
      inspectPointOutputSchema.parse({
        root: { ref: "node:1" },
        probe: { bundled: true, connected: false },
      }),
    ).toThrow();
  });
});
