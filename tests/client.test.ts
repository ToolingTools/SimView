import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeFrame,
  FrameDecoder,
  FrameKind,
  type ProtocolRequest,
  SimViewClient,
} from "@simview/client";

const resources: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((cleanup) => cleanup()));
});

describe("SimViewClient", () => {
  test("authenticates and validates method-keyed results", async () => {
    await withCore(
      (request, respond) => {
        if (request.method === "hello") return respond(request.id, helloResult());
        if (request.method === "devices.list") return respond(request.id, []);
      },
      async ({ socketPath, token }) => {
        const client = await SimViewClient.attach(socketPath, token);
        resources.push(() => client.close());
        expect(await client.request("devices.list", {})).toEqual([]);
      },
    );
  });

  test("rejects a malformed native result with the method name", async () => {
    await withCore(
      (request, respond) => {
        if (request.method === "hello") return respond(request.id, helloResult());
        if (request.method === "devices.list") return respond(request.id, [{ name: "Incomplete" }]);
      },
      async ({ socketPath, token }) => {
        const client = await SimViewClient.attach(socketPath, token);
        resources.push(() => client.close());
        await expect(client.request("devices.list", {})).rejects.toThrow(
          "Invalid devices.list result from simview-core",
        );
      },
    );
  });

  test("enforces request deadlines and preflight cancellation", async () => {
    await withCore(
      (request, respond) => {
        if (request.method === "hello") respond(request.id, helloResult());
      },
      async ({ socketPath, token }) => {
        const client = await SimViewClient.attach(socketPath, token);
        resources.push(() => client.close());
        await expect(client.request("devices.list", {}, { timeoutMs: 20 })).rejects.toThrow(
          "devices.list timed out after 20ms",
        );

        const controller = new AbortController();
        controller.abort(new Error("cancelled"));
        await expect(
          client.request("devices.list", {}, { signal: controller.signal }),
        ).rejects.toThrow("cancelled");
      },
    );
  });
});

type Respond = (id: string, result: unknown) => void;

async function withCore(
  handle: (request: ProtocolRequest, respond: Respond) => void,
  run: (connection: { socketPath: string; token: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "simview-client-test-"));
  const socketPath = join(directory, "core.sock");
  const decoders = new WeakMap<object, FrameDecoder>();
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        const decoder = decoders.get(socket) ?? new FrameDecoder();
        decoders.set(socket, decoder);
        for (const frame of decoder.push(new Uint8Array(data))) {
          if (frame.kind !== FrameKind.Request) continue;
          const request = JSON.parse(new TextDecoder().decode(frame.payload)) as ProtocolRequest;
          handle(request, (id, result) => {
            socket.write(
              encodeFrame(
                FrameKind.Response,
                new TextEncoder().encode(JSON.stringify({ id, result })),
              ),
            );
          });
        }
      },
    },
  });
  resources.push(async () => {
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  });
  await run({ socketPath, token: "a".repeat(64) });
}

function helloResult() {
  return {
    protocolVersion: 2,
    codec: "h264",
    maxFrameRate: 60,
    server: "simview-core/test",
    capabilities: {
      capture: true,
      input: true,
      accessibility: true,
      probe: false,
    },
  };
}
