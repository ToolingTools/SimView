import { FrameKind, SimViewClient } from "@simview/client";

const binary = process.env.SIMVIEW_CORE_BINARY;
const requestedID = process.env.SIMVIEW_ANDROID_DEVICE_ID;
const allowPhysical = process.env.SIMVIEW_ANDROID_ALLOW_PHYSICAL === "1";
const allowFallback = process.env.SIMVIEW_ANDROID_ALLOW_FALLBACK === "1";
const exerciseInput = process.env.SIMVIEW_ANDROID_INPUT_SMOKE === "1";
const exerciseRotation = process.env.SIMVIEW_ANDROID_ROTATION_SMOKE === "1";

const devices = await SimViewClient.listDevices(binary);
const device = requestedID
  ? devices.find((candidate) => candidate.id === requestedID)
  : devices.find(
      (candidate) =>
        candidate.platform === "android" && candidate.kind === "emulator" && candidate.available,
    );

if (!device) {
  throw new Error(
    requestedID
      ? `Android target ${requestedID} was not found`
      : "No ready Android emulator was found; set SIMVIEW_ANDROID_DEVICE_ID to select one",
  );
}
if (device.platform !== "android") throw new Error(`${device.id} is not an Android target`);
if (!device.available) throw new Error(`${device.id} is ${device.state}, not ready`);
if (device.kind === "physical" && !allowPhysical) {
  throw new Error(
    "Physical-device smoke tests require SIMVIEW_ANDROID_ALLOW_PHYSICAL=1 acknowledgement",
  );
}

const client = await SimViewClient.start({ deviceId: device.id, binary });
let configurations = 0;
let frames = 0;
let keyframes = 0;
let latestFrameBytes = 0;
const removeConfiguration = client.on(FrameKind.H264Configuration, () => configurations++);
const removeFrame = client.on(FrameKind.H264Frame, (payload) => {
  frames++;
  if (payload[8] === 1) keyframes++;
  latestFrameBytes = payload.byteLength;
});

try {
  const started = await client.request("capture.start", { deviceId: device.id });
  await waitFor(() => configurations > 0 && frames > 0, 15_000, "first Android H.264 frame");
  const framesBeforeKeyframe = frames;
  const keyframesBeforeRequest = keyframes;
  await client.request("capture.keyframe", {});
  if (exerciseInput) {
    await client.request("input.button", { button: "overview" });
  }
  await waitFor(
    () => frames > framesBeforeKeyframe && keyframes > keyframesBeforeRequest,
    5_000,
    "requested Android keyframe",
  );
  if (exerciseInput) await client.request("input.button", { button: "back" });
  const keyframeRecoveryFrame = keyframes > keyframesBeforeRequest;

  let rotationRecovery = false;
  if (exerciseRotation) {
    const configurationsBeforeRotation = configurations;
    await client.request("device.orientation.set", { orientation: "landscape-right" });
    await waitFor(
      () => configurations > configurationsBeforeRotation,
      10_000,
      "landscape Android codec configuration",
    );
    const landscapeConfigurations = configurations;
    await client.request("device.orientation.set", { orientation: "portrait" });
    await waitFor(
      () => configurations > landscapeConfigurations,
      10_000,
      "portrait Android codec configuration",
    );
    rotationRecovery = true;
  }

  const pngPromise = new Promise<Uint8Array>((resolvePNG) => {
    const remove = client.on(FrameKind.PngScreenshot, (payload) => {
      remove();
      resolvePNG(payload);
    });
  });
  const screenshot = await client.request("capture.screenshot", {});
  const png = await Promise.race([
    pngPromise,
    Bun.sleep(5_000).then(() => {
      throw new Error("Timed out waiting for the Android PNG payload");
    }),
  ]);
  if (
    png.byteLength !== screenshot.byteLength ||
    png[0] !== 0x89 ||
    png[1] !== 0x50 ||
    png[2] !== 0x4e ||
    png[3] !== 0x47
  ) {
    throw new Error("Android screenshot response was not an exact PNG payload");
  }

  const context = await client.request("device.context", {});
  const accessibility = await client.request("accessibility.snapshot", {
    deviceId: device.id,
    scope: "visible",
    maxNodes: 1_200,
  });
  const inspected = await client.request("accessibility.elementAtPoint", {
    deviceId: device.id,
    x: 0.5,
    y: 0.5,
  });
  if (
    accessibility.source !== "android-uiautomator" ||
    accessibility.stats.nodeCount < 1 ||
    !inspected.ref.startsWith("android:")
  ) {
    throw new Error("Android UIAutomator smoke returned an invalid semantic snapshot");
  }
  if (typeof context.package !== "string" || typeof context.activity !== "string") {
    throw new Error("Android foreground package/activity context is unavailable");
  }
  const health = await client.request("health.get", {});
  const captureTransport = health.device?.metadata?.captureTransport;
  if (captureTransport !== "simview-agent" && !allowFallback) {
    throw new Error(
      `Android agent did not start (${String(captureTransport)}); set SIMVIEW_ANDROID_ALLOW_FALLBACK=1 to test the PNG fallback`,
    );
  }

  const exercised: string[] = [];
  if (exerciseInput) {
    await client.request("input.touch", {
      contactId: 0,
      phase: "down",
      x: 0.5,
      y: 0.5,
      pressure: 1,
    });
    await client.request("input.touch", {
      contactId: 0,
      phase: "up",
      x: 0.5,
      y: 0.5,
      pressure: 0,
    });
    exercised.push("raw-touch");
    await client.request("input.swipe", {
      from: { x: 0.7, y: 0.7 },
      to: { x: 0.3, y: 0.7 },
      durationMs: 250,
    });
    exercised.push("swipe");
    await client.request("input.longPress", { x: 0.5, y: 0.5, durationMs: 500 });
    exercised.push("long-press");
    if (process.env.SIMVIEW_ANDROID_TEXT !== undefined) {
      await client.request("input.typeText", { text: process.env.SIMVIEW_ANDROID_TEXT });
      exercised.push("text");
    }
    exercised.push("overview", "back");
  }

  console.log(
    JSON.stringify(
      {
        device: started.device,
        capture: {
          transport: captureTransport,
          configurations,
          frames,
          keyframes,
          latestFrameBytes,
          keyframeRecoveryFrame,
          rotationRecovery,
          screenshot,
        },
        accessibility: {
          source: accessibility.source,
          nodes: accessibility.stats.nodeCount,
          truncated: accessibility.stats.truncated,
          inspectedRef: inspected.ref,
        },
        context,
        input: exerciseInput
          ? { exercised }
          : { exercised, skipped: "set SIMVIEW_ANDROID_INPUT_SMOKE=1" },
      },
      null,
      2,
    ),
  );
} finally {
  removeConfiguration();
  removeFrame();
  await client.request("capture.stop", {}).catch(() => {});
  await client.close();
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}
