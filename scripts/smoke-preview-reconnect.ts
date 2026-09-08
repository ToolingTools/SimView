import assert from "node:assert/strict";
import { FrameKind } from "../packages/client/src/index";
import { SimViewSession } from "../packages/mcp/src/session";

// Opt-in: keep a continuously animated synthetic fixture visible on this Simulator.
// Measures encoded delivery and native capture, not distinct displayed frames.
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
  for (let cycle = 0; cycle < 3; cycle++) {
    await new Promise<void>((resolve, reject) => {
      const next = new WebSocket(`${url.origin.replace("http:", "ws:")}/stream?codec=h264`);
      socket = next;
      next.binaryType = "arraybuffer";
      const timer = setTimeout(() => reject(new Error("Video startup timed out")), 15_000);
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
    await Bun.sleep(2_000);
    const before = (await session.requireClient().request("health.get", {})).metrics;
    frames = 0;
    const start = performance.now();
    await Bun.sleep(5_000);
    const seconds = (performance.now() - start) / 1_000;
    const after = (await session.requireClient().request("health.get", {})).metrics;
    const deliveredFps = frames / seconds;
    assert(typeof before.captured === "number" && typeof after.captured === "number");
    const capturedFps = (after.captured - before.captured) / seconds;
    console.log(JSON.stringify({ cycle, deliveredFps, capturedFps }));
    assert(deliveredFps >= 30, `Cycle ${cycle}: delivery fell below 30 fps`);
    assert(capturedFps >= 30, `Cycle ${cycle}: capture fell below 30 fps`);
    await new Promise<void>((resolve, reject) => {
      assert(socket);
      const timer = setTimeout(() => reject(new Error("Video close timed out")), 2_000);
      socket.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.close();
    });
    socket = undefined;
    await Bun.sleep(150);
  }
} finally {
  socket?.close();
  await session.close();
}
