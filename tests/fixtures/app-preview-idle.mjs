import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { parseDeviceDescription } from "@simview/contracts";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://127.0.0.1:12345/#token=fixture-token" });
browser.document.body.innerHTML = '<div id="app"></div>';
const device = parseDeviceDescription({
  udid: "idle-test",
  name: "Idle phone",
  state: "Booted",
  runtime: "iOS",
});
let state = {
  reviewId: "859e3744-1c54-4d38-a4d2-f3d7cb945fa1",
  annotations: [],
  codec: "mjpeg",
  connected: false,
};
let attachments = 0;
const sockets = [];
browser.__simviewTestBridge = { connect: async () => {}, getHostContext: () => ({}) };
browser.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
for (const key of [
  "document",
  "location",
  "navigator",
  "HTMLElement",
  "Element",
  "DOMException",
  "ResizeObserver",
])
  Object.defineProperty(globalThis, key, { configurable: true, value: browser[key] });
globalThis.window = browser;
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.fetch = async (path) => {
  if (path === "/state") return Response.json(state);
  if (path === "/devices") return Response.json({ devices: [device] });
  if (path === "/device") {
    attachments++;
    state = { ...state, device, connected: true };
    return Response.json(state);
  }
  return new Response("Unavailable in fixture", { status: 501 });
};
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url;
    sockets.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(value) {
    assert.equal(JSON.parse(value).token, "fixture-token");
  }
  close() {
    this.closed = true;
  }
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
runInThisContext(await build.outputs[0].text());
async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out: ${label}`);
}
function click(label) {
  const button = [...browser.document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label,
  );
  assert.ok(button, `Missing button: ${label}`);
  button.click();
}
try {
  await until(() => browser.document.body.textContent.includes("Choose a device"), "idle message");
  assert.equal(attachments, 0);
  await until(() => sockets.length === 1, "idle stream");
  click("Choose device");
  await until(() => browser.document.body.textContent.includes("Idle phone"), "device menu");
  click("Idle phoneiOS");
  await until(() => attachments === 1 && sockets.length > 1, "explicit attachment and new stream");
  assert.equal(
    sockets.at(-1).url,
    "ws://127.0.0.1:12345/stream?codec=mjpeg",
    "selection keeps relay origin",
  );
  state = { ...state, connected: false };
  sockets.at(-1).onclose?.();
  await until(
    () => browser.document.body.textContent.includes("Choose a device"),
    "disconnected server remains usable",
  );
  click("Choose device");
  await until(
    () => browser.document.querySelector('.device-menu [role="menuitem"]'),
    "recovery menu",
  );
  click("Idle phoneiOS");
  await until(() => attachments === 2, "same device reconnects");
  console.log("PASS: idle browser selects and reconnects the same device");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close();
  await browser.happyDOM.abort();
  process.exit(process.exitCode ?? 0);
}
