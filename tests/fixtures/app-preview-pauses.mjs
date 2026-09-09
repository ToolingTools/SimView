import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { parseDeviceDescription } from "@simview/contracts";
import { Window } from "happy-dom";

const relay = process.argv.includes("--relay");
const browser = new Window({ url: "http://localhost/preview#token=fixture-token" });
if (!relay) Object.defineProperty(browser, "parent", { value: {} });
browser.document.body.innerHTML = '<div id="app"></div>';
const device = parseDeviceDescription({
  udid: "pause-test",
  name: "Test phone",
  state: "Booted",
  runtime: "iOS",
});
const state = {
  reviewId: "859e3744-1c54-4d38-a4d2-f3d7cb945fa1",
  device,
  annotations: [],
  codec: "h264",
  connected: true,
};
browser.__SIMVIEW_INITIAL_STATE__ = state;
let pollCount = 0;
let paints = 0;
let lastPaint = 0;
const treeRequests = [];
let recoveryRequests = 0;
let inputs = 0;
const deadlines = new Map();
const schedule = browser.setTimeout.bind(browser);
browser.setTimeout = (callback, milliseconds, ...args) => {
  const id = schedule(callback, milliseconds, ...args);
  if (milliseconds === 30_000 || milliseconds === 50_000)
    deadlines.set(id, { callback, milliseconds });
  return id;
};
const clear = browser.clearTimeout.bind(browser);
browser.clearTimeout = (id) => {
  deadlines.delete(id);
  clear(id);
};
browser.HTMLCanvasElement.prototype.getContext = () => ({
  drawImage(frame) {
    paints++;
    lastPaint = frame.timestamp;
  },
});
browser.VideoDecoder = class {
  state = "unconfigured";
  constructor(callbacks) {
    this.callbacks = callbacks;
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk) {
    this.callbacks.output({
      timestamp: chunk.timestamp,
      displayWidth: 390,
      displayHeight: 844,
      close() {},
    });
  }
  close() {
    this.state = "closed";
  }
};
browser.EncodedVideoChunk = class {
  constructor(value) {
    Object.assign(this, value);
  }
};
browser.__simviewTestBridge = {
  connect: async () => {},
  getHostContext: () => ({}),
  async callServerTool({ name, arguments: args }, options = {}) {
    if (["device_input", "simulator_input"].includes(name)) inputs++;
    if (name === "get_preview_packets") {
      pollCount++;
      await Bun.sleep(20);
      if (options.signal?.aborted) throw options.signal.reason;
      const frame = Buffer.alloc(10);
      frame.writeBigUInt64BE(BigInt(pollCount), 0);
      frame[8] = 1;
      return {
        structuredContent: {
          reset: true,
          configuration: "AUIAHg==",
          packets: [{ sequence: pollCount, kind: 0x11, data: frame.toString("base64") }],
          nextSequence: pollCount,
        },
      };
    }
    if (name === "app_connect_device") {
      recoveryRequests++;
      return {
        structuredContent: {
          ...state,
          iosAccessibility: {
            schemaVersion: 1,
            status: "enhanced-ready",
            activeProvider: "core-simulator-xctest",
          },
        },
      };
    }
    if (name === "app_get_element_tree_page") {
      return await new Promise((resolve, reject) => {
        treeRequests.push({ args, resolve, reject, signal: options.signal });
        options.signal?.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    }
    return { isError: true, content: [{ type: "text", text: "Not available in preview fixture" }] };
  },
};
const build = await Bun.build({
  entrypoints: [new URL("../../packages/app/src/index.tsx", import.meta.url).pathname],
  target: "browser",
  format: "iife",
  write: false,
  plugins: [
    {
      name: "preview-host-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({
          path: "host",
          namespace: "test-host",
        }));
        builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({
          contents: "export class App { constructor() { return window.__simviewTestBridge; } }",
          loader: "js",
        }));
      },
    },
  ],
});
assert.equal(build.success, true, build.logs.join("\n"));
// Run only the local app bundle in this isolated fixture process. Bun's VM
// contexts do not provide the built-ins expected by Happy DOM.
for (const name of [
  "document",
  "location",
  "navigator",
  "HTMLElement",
  "Element",
  "DOMException",
  "ResizeObserver",
  "VideoDecoder",
  "EncodedVideoChunk",
]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: browser[name] });
}
globalThis.window = browser;
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
const sockets = [];
if (relay) {
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/input") inputs++;
    if (path === "/state") return Response.json(state);
    if (path === "/device") {
      recoveryRequests++;
      return Response.json(state);
    }
    if (path.startsWith("/elements")) {
      return await new Promise((resolve, reject) => {
        treeRequests.push({
          args: { action: "start" },
          signal: options.signal,
          reject,
          resolve: (result) =>
            resolve(
              Response.json(
                JSON.parse(Buffer.from(result.structuredContent.chunk, "base64").toString()),
              ),
            ),
        });
        options.signal?.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    }
    return new Response("Not available in preview fixture", { status: 501 });
  };
  globalThis.WebSocket = class {
    constructor() {
      sockets.push(this);
      let configured = false;
      this.timer = setInterval(() => {
        if (!configured) {
          this.onmessage?.({ data: Uint8Array.from([0x10, 1, 0x42, 0, 0x1e]).buffer });
          configured = true;
        }
        const frame = Buffer.alloc(11);
        frame[0] = 0x11;
        frame.writeBigUInt64BE(BigInt(++pollCount), 1);
        frame[9] = 1;
        this.onmessage?.({ data: Uint8Array.from(frame).buffer });
      }, 20);
    }
    send() {}
    close() {
      clearInterval(this.timer);
    }
  };
}
runInThisContext(await build.outputs[0].text());

async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out: ${label}; text=${browser.document.body.textContent}`);
}
function click(label) {
  const button = [...browser.document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label,
  );
  assert.ok(button, `Missing button: ${label}`);
  button.click();
}
async function assertPaused(label) {
  await Bun.sleep(60);
  const before = { polls: pollCount, paints, frame: lastPaint };
  await Bun.sleep(100);
  assert.deepEqual({ polls: pollCount, paints, frame: lastPaint }, before, label);
  return before;
}
async function page(label, { pageIndex = 0, pageCount = 1, split, badHash = false } = {}) {
  const output = {
    snapshot: {
      schemaVersion: 1,
      snapshotId: label,
      capturedAt: "2026-09-09T00:00:00.000Z",
      source: "core-simulator-xctest",
      scope: "full",
      screen: { x: 0, y: 0, width: 390, height: 844 },
      root: {
        ref: `ax:${label}`,
        role: "AXApplication",
        label,
        children: [{ ref: `ax:${label}:1`, role: "AXButton", label }],
      },
      stats: { nodeCount: 2, truncated: true, quality: "partial" },
    },
    screenContext: {
      schemaVersion: 1,
      kind: "native-ios",
      platform: "ios",
      frameId: "frame-test",
      capturedAt: "2026-09-09T00:00:00.000Z",
    },
  };
  const bytes = Buffer.from(JSON.stringify(output));
  const midpoint = split ?? Math.floor(bytes.length / 2);
  const chunk =
    pageCount === 1
      ? bytes
      : pageIndex === 0
        ? bytes.subarray(0, midpoint)
        : bytes.subarray(midpoint);
  return {
    structuredContent: {
      schemaVersion: 1,
      transferId: "e7787f9d-cfd8-4f52-b136-f16d02d30d30",
      encoding: "base64-json",
      pageIndex,
      pageCount,
      chunk: chunk.toString("base64"),
      chunkBytes: chunk.length,
      totalBytes: bytes.length,
      sha256: badHash ? "0".repeat(64) : new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      ...(pageIndex + 1 < pageCount ? { nextCursor: "next" } : {}),
    },
  };
}
try {
  await until(() => paints >= 2, "live preview paints");
  click("Show inspector");
  await until(() => treeRequests.length === 1, "inspector tree request");
  await assertPaused("Inspector pauses pending tree");
  if (relay) {
    treeRequests.shift().resolve(await page("Retained tree"));
  } else {
    treeRequests.shift().resolve(await page("Retained tree", { pageCount: 2 }));
    await until(() => treeRequests.length === 1, "next page");
    assert.equal(treeRequests[0].args.action, "continue");
    await assertPaused("Inspector remains paused between pages");
    treeRequests.shift().resolve(await page("Retained tree", { pageIndex: 1, pageCount: 2 }));
  }
  await until(() => browser.document.body.textContent.includes("Retained tree"), "tree rendered");
  await assertPaused("Tree completion does not resume inspector");
  const screen = browser.document.querySelector(".screen-wrap");
  screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 844 });
  screen.dispatchEvent(
    new browser.PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    }),
  );
  screen.dispatchEvent(
    new browser.PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    }),
  );
  await Bun.sleep(30);
  assert.equal(inputs, 0, "Inspecting a frozen frame cannot send native touches");

  click("Refresh elements");
  await until(() => treeRequests.length === 1, "refresh request");
  assert.ok(
    browser.document.body.textContent.includes("Retained tree"),
    "Refresh retains previous tree",
  );
  assert.ok(browser.document.querySelector('.elements-spinner[aria-label="Loading elements"]'));
  assert.equal(browser.document.querySelector(".elements-panel").getAttribute("aria-busy"), "true");
  assert.equal(browser.document.querySelector(".elements-panel > input").type, "search");
  const expired = [...deadlines.values()].find((entry) => entry.milliseconds === 30_000);
  assert.ok(expired, "Separate 30s tree deadline");
  expired.callback();
  await until(() => browser.document.body.textContent.includes("timed out"), "timeout is visible");
  assert.equal(treeRequests.shift().signal.aborted, true);
  assert.equal(browser.document.querySelector(".elements-spinner"), null);
  assert.ok(browser.document.querySelector('.element-tree-error [type="button"]'));
  await assertPaused("Timeout does not resume inspector");

  click("Refresh elements");
  await until(() => treeRequests.length === 1, "retry after timeout");
  const abandoned = treeRequests.shift();
  click("Hide inspector");
  await until(() => abandoned.signal.aborted, "closing inspector cancels tree");
  const previous = paints;
  await until(() => paints > previous, "closing inspector resumes video");
  abandoned.resolve(await page("Stale tree"));
  await Bun.sleep(30);
  assert.ok(!browser.document.body.textContent.includes("Stale tree"));

  click("Annotate");
  await until(() => treeRequests.length === 1, "annotation tree");
  treeRequests.shift().resolve(await page("Annotation tree"));
  await assertPaused("Annotation remains frozen after success");
  click("Show inspector");
  await until(() => treeRequests.length === 1, "overlapping inspection");
  const overlapped = treeRequests.shift();
  const frozen = await assertPaused("Annotation plus inspector stays frozen");
  click("Interact");
  await assertPaused("Leaving annotation does not resume an open inspector");
  assert.equal(lastPaint, frozen.frame);
  if (relay) overlapped.reject(new Error("Native tree failed"));
  else {
    overlapped.reject(new Error("Tree failed"));
    await until(() => treeRequests.length === 1, "native fallback request");
    treeRequests.shift().reject(new Error("Native tree failed"));
  }
  await until(
    () => browser.document.body.textContent.includes("Native tree failed"),
    "failure visible",
  );
  await assertPaused("Failure does not resume inspector");
  click("Hide inspector");
  await until(() => paints > frozen.paints, "all pause reasons cleared");
  assert.ok(recoveryRequests >= 4, "Explicit tree actions recover accessibility");
  if (!relay) {
    click("Annotate");
    await until(() => treeRequests.length === 1, "annotation before unsent confirmation");
    treeRequests.shift().resolve(await page("Unsent annotation tree"));
    const paused = await assertPaused("Annotation freeze before unsent confirmation");
    browser.__simviewTestBridge.ontoolresult({
      structuredContent: {
        ...state,
        annotations: [
          {
            id: "be4951ef-fbd5-472d-bb91-d83fd63b7c11",
            frameId: "current",
            createdAt: "2026-09-09T00:00:00.000Z",
            geometry: { kind: "point", x: 0.5, y: 0.5 },
            note: "Unsent test",
          },
        ],
      },
    });
    await until(
      () => browser.document.querySelector('[aria-label="Annotation 1: Unsent test"]'),
      "unsent annotation rendered",
    );
    click("Interact");
    await until(
      () => browser.document.querySelector('[role="alertdialog"]'),
      "unsent annotation confirmation",
    );
    await assertPaused("Confirmation leaves annotation paused");
    click("Cancel");
    await until(
      () => !browser.document.querySelector('[role="alertdialog"]'),
      "confirmation cancelled",
    );
    await assertPaused("Cancel preserves annotation mode");
    click("Interact");
    await until(
      () => browser.document.querySelector('[role="alertdialog"]'),
      "second confirmation",
    );
    click("Clear & Switch");
    await until(() => paints > paused.paints, "confirmed annotation discard resumes preview");
  }
  // A native disconnect can leave the App bridge alive. Explicit recovery must
  // restore connected state as well as the tree, so closing Inspector resumes.
  if (relay) sockets.at(-1).onclose();
  else browser.__simviewTestBridge.onclose();
  await until(
    () => browser.document.body.textContent.includes("Review disconnected"),
    "disconnect visible",
  );
  click("Show inspector");
  await until(() => treeRequests.length === 1, "tree after reconnection");
  treeRequests.shift().resolve(await page("Recovered connection tree"));
  await until(
    () => browser.document.body.textContent.includes("Recovered connection tree"),
    "recovered tree visible",
  );
  assert.ok(!browser.document.body.textContent.includes("Review disconnected"));
  const recoveredPause = await assertPaused("Reconnected Inspector stays intentionally paused");
  click("Hide inspector");
  await until(() => paints > recoveredPause.paints, "reconnected viewer resumes video");
  console.log(
    "PASS: rendered preview pauses, pagination, timeout/retry, cancellation, overlap, and resumption",
  );
} finally {
  browser.__simviewTestBridge.onclose?.();
  for (const socket of sockets) socket.close();
  await browser.happyDOM.close();
}
