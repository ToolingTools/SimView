import assert from "node:assert/strict";
import { FrameKind, SimViewClient } from "../packages/client/src/index";
import type { Orientation } from "../packages/contracts/src/index";

// Opt-in: use a dedicated booted Simulator. Frames remain in memory.
const deviceId = process.env.SIMVIEW_DEVICE_ID ?? "";
assert(deviceId.startsWith("ios:"), "Set SIMVIEW_DEVICE_ID to a dedicated iOS Simulator");
const udid = deviceId.slice(4);
const cliNames: Record<Orientation, string> = {
  portrait: "portrait",
  "portrait-upside-down": "portraitUpsideDown",
  "landscape-left": "landscapeRight",
  "landscape-right": "landscapeLeft",
};

async function orientation(): Promise<string> {
  const child = Bun.spawn(
    [
      "xcrun",
      "devicectl",
      "device",
      "orientation",
      "get",
      "--device",
      udid,
      "--quiet",
      "--json-output",
      "-",
      "--timeout",
      "10",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(status, 0, stderr);
  const result = JSON.parse(stdout).result;
  return result.deviceOrientationNonFlat;
}

async function screenshot(client: SimViewClient) {
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = new Promise<Uint8Array>((resolve, reject) => {
    unsubscribe = client.on(FrameKind.PngScreenshot, resolve);
    timer = setTimeout(() => reject(new Error("Screenshot frame timed out")), 10_000);
  });
  try {
    const [metadata, bytes] = await Promise.all([client.request("capture.screenshot", {}), frame]);
    assert.equal(bytes.byteLength, metadata.byteLength);
    assert.deepEqual(Array.from(bytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    return { width: metadata.width, height: metadata.height, byteLength: bytes.byteLength };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

const original = await orientation();
const restore = (Object.keys(cliNames) as Orientation[]).find((key) => cliNames[key] === original);
assert(restore, `Cannot restore unknown orientation: ${original}`);
const client = await SimViewClient.start({
  deviceId,
  codec: "h264",
  binary: process.env.SIMVIEW_CORE_BINARY,
});
let frames = 0;
const unsubscribe = client.on(FrameKind.H264Frame, () => frames++);
try {
  await client.request("capture.start", { deviceId });
  await client.request("capture.preview", { enabled: true });
  for (const value of ["landscape-left", "landscape-right", "portrait"] as const) {
    const started = performance.now();
    await client.request("device.orientation.set", { orientation: value });
    assert.equal(await orientation(), cliNames[value]);
    await Bun.sleep(500);
    const png = await screenshot(client);
    console.log(
      JSON.stringify({ orientation: value, durationMs: performance.now() - started, png }),
    );
  }
  await Bun.sleep(2_000);
  assert(frames > 0, "No live H.264 frames arrived");
  console.log(JSON.stringify({ deviceId, liveFrames: frames, result: "passed" }));
} finally {
  try {
    await client.request("device.orientation.set", { orientation: restore });
  } finally {
    unsubscribe();
    await client.close();
  }
}
