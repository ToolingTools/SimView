import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameDecoder, FrameKind, encodeFrame, SimViewClient } from "@simview/client";
import type { ProtocolRequest } from "@simview/contracts";
import { SimViewSession } from "../packages/mcp/src/session";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("browser preview ownership", () => {
  test("enables the MJPEG native connection and releases it independently of H.264", async () => {
    const core = await previewCore();
    const primary = await SimViewClient.attach(core.socketPath, core.token, "h264");
    const session = new SimViewSession();
    session.client = primary;
    session.startRelay(await availablePort());
    cleanups.push(() => session.close(), () => core.close());

    const origin = relayOrigin(session).replace(/^http/, "ws");
    const h264 = await authenticatedSocket(`${origin}/stream?codec=h264`, session.relayToken);
    await waitFor(() => core.connections.some((connection) => connection.previewEnabled));
    const mjpeg = await authenticatedSocket(`${origin}/stream?codec=mjpeg`, session.relayToken);
    await waitFor(() =>
      core.connections.some((connection) => connection.codec === "mjpeg" && connection.previewEnabled),
    );

    const secondary = core.connections.find((connection) => connection.codec === "mjpeg");
    expect(secondary?.previewEnabled).toBe(true);

    mjpeg.close();
    await waitFor(() => secondary?.closed === true);
    expect(core.connections.find((connection) => connection.codec === "h264")?.previewEnabled).toBe(
      true,
    );

    h264.close();
    await waitFor(() =>
      core.connections.find((connection) => connection.codec === "h264")?.previewEnabled === false,
    );
  });

  test("closes a secondary socket when preview initialization fails and allows a retry", async () => {
    const core = await previewCore({ failFirstMjpegPreview: true });
    const primary = await SimViewClient.attach(core.socketPath, core.token, "h264");
    const session = new SimViewSession();
    session.client = primary;
    session.startRelay(await availablePort());
    cleanups.push(() => session.close(), () => core.close());

    const origin = relayOrigin(session).replace(/^http/, "ws");
    const h264 = await authenticatedSocket(`${origin}/stream?codec=h264`, session.relayToken);
    await waitFor(() => core.connections.some((connection) => connection.previewEnabled));

    const firstMjpeg = await authenticatedSocket(
      `${origin}/stream?codec=mjpeg`,
      session.relayToken,
    );
    await waitFor(() =>
      core.connections.filter((connection) => connection.codec === "mjpeg").length === 1 &&
      core.connections.find((connection) => connection.codec === "mjpeg")?.closed === true,
    );
    firstMjpeg.close();

    const retry = await authenticatedSocket(`${origin}/stream?codec=mjpeg`, session.relayToken);
    await waitFor(() =>
      core.connections.filter((connection) => connection.codec === "mjpeg").some(
        (connection) => connection.previewEnabled && !connection.closed,
      ),
    );
    retry.close();
    h264.close();
  });
});

type PreviewConnection = {
  codec: "h264" | "mjpeg" | undefined;
  previewEnabled: boolean;
  closed: boolean;
};

async function previewCore(options: { failFirstMjpegPreview?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "simview-preview-test-"));
  const socketPath = join(directory, "core.sock");
  const token = "a".repeat(64);
  const connections: PreviewConnection[] = [];
  let failFirstMjpegPreview = options.failFirstMjpegPreview === true;
  const decoders = new WeakMap<object, FrameDecoder>();
  const states = new WeakMap<object, PreviewConnection>();
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        const state: PreviewConnection = { codec: undefined, previewEnabled: false, closed: false };
        connections.push(state);
        states.set(socket, state);
      },
      data(socket, data) {
        const decoder = decoders.get(socket) ?? new FrameDecoder();
        decoders.set(socket, decoder);
        const state = states.get(socket);
        for (const frame of decoder.push(new Uint8Array(data))) {
          if (frame.kind !== FrameKind.Request || !state) continue;
          const request = JSON.parse(new TextDecoder().decode(frame.payload)) as ProtocolRequest;
          const params = request.params as { codecs?: Array<"h264" | "mjpeg">; enabled?: boolean };
          let result: unknown;
          if (request.method === "hello") {
            state.codec = params.codecs?.[0];
            result = {
              protocolVersion: 4,
              codec: state.codec,
              maxFrameRate: 60,
              server: "simview-core/test",
              capabilities: {
                capture: true,
                input: true,
                accessibility: true,
                probe: false,
              },
            };
          } else if (request.method === "capture.preview") {
            if (state.codec === "mjpeg" && params.enabled === true && failFirstMjpegPreview) {
              failFirstMjpegPreview = false;
              socket.write(
                encodeFrame(
                  FrameKind.Response,
                  new TextEncoder().encode(
                    JSON.stringify({
                      id: request.id,
                      error: { code: "TEST_PREVIEW_FAILED", message: "preview failed" },
                    }),
                  ),
                ),
              );
              continue;
            }
            state.previewEnabled = params.enabled === true;
            result = { enabled: state.previewEnabled };
          } else if (request.method === "capture.keyframe") {
            result = { accepted: true };
          } else {
            throw new Error(`Unexpected ${request.method}`);
          }
          socket.write(
            encodeFrame(
              FrameKind.Response,
              new TextEncoder().encode(JSON.stringify({ id: request.id, result })),
            ),
          );
        }
      },
      close(socket) {
        const state = states.get(socket);
        if (state) state.closed = true;
      },
    },
  });
  cleanups.push(async () => {
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    socketPath,
    token,
    connections,
    async close() {
      listener.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function authenticatedSocket(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "authenticate", token }));
      resolve();
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket upgrade failed")));
  });
  return socket;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for preview state");
}

async function availablePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function relayOrigin(session: SimViewSession): string {
  if (!session.relay) throw new Error("Relay did not start");
  return `http://${session.relay.hostname}:${session.relay.port}`;
}
