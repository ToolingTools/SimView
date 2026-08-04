#!/usr/bin/env bun
import { chmod, unlink } from "node:fs/promises";
import {
  encodeFrame,
  FrameDecoder,
  FrameKind,
  PROTOCOL_VERSION,
  type ProtocolRequest,
} from "../../packages/client/src";

const argumentsMap = new Map<string, string>();
for (let index = 2; index < process.argv.length - 1; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--") && value && !value.startsWith("--")) argumentsMap.set(key, value);
}

if (process.argv[2] !== "serve") process.exit(2);
const socketPath = argumentsMap.get("--socket");
const instanceId = argumentsMap.get("--instance-id") ?? null;
const configuredUdid = argumentsMap.get("--udid") ?? null;
const configuredDeviceId =
  argumentsMap.get("--device-id") ?? (configuredUdid ? `ios:${configuredUdid}` : null);
const parsedIdleTimeout = Number(argumentsMap.get("--idle-timeout"));
const idleTimeoutSeconds = Number.isFinite(parsedIdleTimeout) ? parsedIdleTimeout : 60;
const idleTimeoutMilliseconds = idleTimeoutSeconds * 1_000;
const token = await Bun.stdin.text();
if (!socketPath || token.length < 32) process.exit(2);
const boundSocketPath = socketPath;

type ConnectionState = { authenticated: boolean; codec: "h264" | "mjpeg" };
const states = new Map<object, ConnectionState>();
const decoders = new WeakMap<object, FrameDecoder>();
let lastDisconnect = new Date();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;

const listener = Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) {
      states.set(socket, { authenticated: false, codec: "h264" });
    },
    data(socket, data) {
      const decoder = decoders.get(socket) ?? new FrameDecoder();
      decoders.set(socket, decoder);
      for (const frame of decoder.push(new Uint8Array(data))) {
        if (frame.kind !== FrameKind.Request) continue;
        const request = JSON.parse(new TextDecoder().decode(frame.payload)) as ProtocolRequest;
        const state = states.get(socket);
        if (!state) continue;
        if (request.method === "hello") {
          const params = request.params as {
            token: string;
            codecs: Array<"h264" | "mjpeg">;
          };
          if (params.token !== token) process.exit(3);
          state.authenticated = true;
          state.codec = params.codecs[0] ?? "h264";
          cancelIdleShutdown();
          respond(socket, request.id, {
            protocolVersion: PROTOCOL_VERSION,
            codec: state.codec,
            maxFrameRate: 60,
            server: "simview-core/fake",
            capabilities: { capture: true, input: true, accessibility: true, probe: false },
          });
        } else if (request.method === "health.get") {
          const clients = [...states.values()].filter((item) => item.authenticated);
          respond(socket, request.id, {
            status: "ok",
            pid: process.pid,
            instanceId,
            configuredUdid,
            configuredDeviceId,
            device: null,
            captureActive: false,
            captureState: "idle",
            idleDeadline: clients.length
              ? null
              : new Date(lastDisconnect.getTime() + idleTimeoutMilliseconds).toISOString(),
            capabilities: { capture: true, input: true, accessibility: true, probe: false },
            clients: clients.length,
            clientsByCodec: {
              h264: clients.filter((item) => item.codec === "h264").length,
              mjpeg: clients.filter((item) => item.codec === "mjpeg").length,
            },
            metrics: {},
          });
        } else if (request.method === "server.shutdown") {
          respond(socket, request.id, { shuttingDown: true });
          setTimeout(() => shutdown(0), 20);
        }
      }
    },
    close(socket) {
      const state = states.get(socket);
      states.delete(socket);
      if (state?.authenticated && ![...states.values()].some((item) => item.authenticated)) {
        lastDisconnect = new Date();
        scheduleIdleShutdown();
      }
    },
  },
});
await chmod(boundSocketPath, 0o600);
scheduleIdleShutdown();

function cancelIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

function scheduleIdleShutdown(): void {
  cancelIdleShutdown();
  if ([...states.values()].some((item) => item.authenticated)) return;
  const remaining = Math.max(0, lastDisconnect.getTime() + idleTimeoutMilliseconds - Date.now());
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if ([...states.values()].some((item) => item.authenticated)) return;
    const deadline = lastDisconnect.getTime() + idleTimeoutMilliseconds;
    if (Date.now() < deadline) {
      scheduleIdleShutdown();
      return;
    }
    shutdown(0);
  }, remaining);
}

function respond(socket: { write(data: Uint8Array): number }, id: string, result: unknown): void {
  socket.write(
    encodeFrame(FrameKind.Response, new TextEncoder().encode(JSON.stringify({ id, result }))),
  );
}

function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelIdleShutdown();
  listener.stop(true);
  void unlink(boundSocketPath)
    .catch(() => {})
    .finally(() => process.exit(exitCode));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
