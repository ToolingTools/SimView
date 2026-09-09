import assert from "node:assert/strict";
import { FrameKind } from "../packages/client/src/index";
import { SimViewSession } from "../packages/mcp/src/session";

// Opt-in: keep a continuously animated synthetic fixture visible on this Simulator.
// Measures encoded delivery and native capture, not distinct displayed frames.
const CYCLE_COUNT = 3;
const MIN_FPS = 30;
const VIDEO_START_TIMEOUT_MS = 15_000;
const VIDEO_SETTLE_MS = 2_000;
const SAMPLE_DURATION_MS = 5_000;
const VIDEO_CLOSE_TIMEOUT_MS = 2_000;
const RECONNECT_SETTLE_MS = 150;
const deviceId = process.env.SIMVIEW_DEVICE_ID;
assert(
  deviceId?.startsWith("ios:"),
  "Set SIMVIEW_DEVICE_ID to a dedicated motion-fixture Simulator",
);
const session = new SimViewSession();
let socket: WebSocket | undefined;
let frames = 0;
try {
  await session.open(deviceId, { startRelay: true });
  const browserUrl = session.browserUrl();
  assert(browserUrl);
  const url = new URL(browserUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert(token);
  for (let cycle = 0; cycle < CYCLE_COUNT; cycle++) {
    await new Promise<void>((resolve, reject) => {
      const next = new WebSocket(`${url.origin.replace("http:", "ws:")}/stream?codec=h264`);
      socket = next;
      next.binaryType = "arraybuffer";
      const timer = setTimeout(
        () => reject(new Error("Video startup timed out")),
        VIDEO_START_TIMEOUT_MS,
      );
      next.onopen = () => next.send(JSON.stringify({ type: "authenticate", token }));
      next.onmessage = (event) => {
        if (
          event.data instanceof ArrayBuffer &&
          new Uint8Array(event.data)[0] === FrameKind.H264Frame
        ) {
          frames++;
          clearTimeout(timer);
          resolve();
        }
      };
      next.onerror = next.onclose = () => {
        clearTimeout(timer);
        reject(new Error("Video socket closed before startup"));
      };
    });
    await Bun.sleep(VIDEO_SETTLE_MS);
    const captureStart = performance.now();
    const before = (await session.requireClient().request("health.get", {})).metrics;
    frames = 0;
    const start = performance.now();
    await Bun.sleep(SAMPLE_DURATION_MS);
    const seconds = (performance.now() - start) / 1_000;
    const deliveredFps = frames / seconds;
    const after = (await session.requireClient().request("health.get", {})).metrics;
    // Bracket both health requests so their latency cannot inflate capture FPS.
    const captureSeconds = (performance.now() - captureStart) / 1_000;
    assert(typeof before.captured === "number" && typeof after.captured === "number");
    const capturedFps = (after.captured - before.captured) / captureSeconds;
    console.log(JSON.stringify({ cycle, deliveredFps, capturedFps }));
    assert(deliveredFps >= MIN_FPS, `Cycle ${cycle}: delivery fell below ${MIN_FPS} fps`);
    assert(capturedFps >= MIN_FPS, `Cycle ${cycle}: capture fell below ${MIN_FPS} fps`);
    await new Promise<void>((resolve, reject) => {
      assert(socket);
      assert.equal(socket.readyState, WebSocket.OPEN, `Cycle ${cycle}: video socket disconnected`);
      const timer = setTimeout(
        () => reject(new Error("Video close timed out")),
        VIDEO_CLOSE_TIMEOUT_MS,
      );
      socket.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.close();
    });
    socket = undefined;
    await Bun.sleep(RECONNECT_SETTLE_MS);
  }
} finally {
  socket?.close();
  await session.close();
}
