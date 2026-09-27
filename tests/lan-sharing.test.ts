import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FrameKind, SimViewClient } from "@simview/client";
import {
  lanSharingInputSchema,
  lanSharingStartedSchema,
  lanSharingStatusSchema,
  parseDeviceDescription,
} from "@simview/contracts";
import { previewLanOptions } from "../packages/cli/src/commands";
import * as lan from "../packages/mcp/src/lan";
import { isPrivateIPv4, lanAddresses, selectLanAddress } from "../packages/mcp/src/lan";
import { createServer } from "../packages/mcp/src/server";
import { SimViewSession } from "../packages/mcp/src/session";

const sessions: SimViewSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe("LAN configuration", () => {
  const addresses = [
    { name: "en0", address: "192.168.1.2" },
    { name: "en1", address: "10.0.0.2" },
  ];
  test("selects the preferred interface, a sole address, or an explicit override", () => {
    expect(selectLanAddress(addresses, "en0")).toBe("192.168.1.2");
    expect(selectLanAddress(addresses.slice(1))).toBe("10.0.0.2");
    expect(selectLanAddress(addresses, "en0", "10.0.0.2")).toBe("10.0.0.2");
    expect(() => selectLanAddress(addresses)).toThrow("en0: 192.168.1.2");
    expect(() => selectLanAddress([])).toThrow("No private LAN");
  });
  test("rejects wildcard, public, malformed, loopback, and unassigned addresses", () => {
    for (const host of [
      "0.0.0.0",
      "127.0.0.1",
      "8.8.8.8",
      "169.254.1.2",
      "192.168.1.999",
      "192.168.01.2",
      "::1",
    ]) {
      expect(isPrivateIPv4(host)).toBe(false);
      expect(() => selectLanAddress(addresses, undefined, host)).toThrow();
    }
    expect(() => selectLanAddress(addresses, undefined, "192.168.1.3")).toThrow();
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.255")).toBe(true);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false);
  });
  test("CLI remains opt-in and validates overrides before connecting", () => {
    expect(previewLanOptions({})).toBeUndefined();
    expect(previewLanOptions({ lan: true })).toEqual({});
    expect(previewLanOptions({ lan: true, "lan-host": "10.0.0.2", "lan-port": "1234" })).toEqual({
      host: "10.0.0.2",
      port: 1234,
    });
    expect(() => previewLanOptions({ "lan-host": "10.0.0.2" })).toThrow("require --lan");
    expect(() => previewLanOptions({ "lan-port": "1234" })).toThrow("require --lan");
    for (const port of ["-1", "65536", "1.5", "", "1e3"]) {
      expect(() => previewLanOptions({ lan: true, "lan-port": port })).toThrow();
    }
    expect(lanSharingInputSchema.safeParse({ port: 65536 }).success).toBe(false);
  });
  test("requires a connected review and does not start a listener implicitly", async () => {
    const session = new SimViewSession();
    sessions.push(session);
    expect(session.lanSharingStatus()).toEqual({ active: false });
    expect(() => session.startLanSharing()).toThrow("connect_device");
    expect(await session.stopLanSharing()).toEqual({ active: false });
  });
});

// Exercise actual HTTP/WebSocket handlers over loopback in the default suite.
// SIMVIEW_TEST_LAN=1 additionally uses the real network selector and LAN interface.
const realLan = process.env.SIMVIEW_TEST_LAN === "1";
const host = realLan ? lanAddresses()[0]?.address : "127.0.0.1";
const lanTest = host ? test : test.skip;
let addressResolver: ReturnType<typeof spyOn<typeof lan, "resolveLanAddress">> | undefined;
beforeEach(() => {
  if (!realLan) addressResolver = spyOn(lan, "resolveLanAddress").mockReturnValue("127.0.0.1");
});
afterEach(() => addressResolver?.mockRestore());

function fixture() {
  const session = new SimViewSession();
  sessions.push(session);
  session.device = parseDeviceDescription({
    udid: "LAN-TEST",
    name: "LAN test",
    state: "Booted",
    runtime: "iOS",
  });
  const capture: boolean[] = [];
  const inputs: string[] = [];
  session.client = {
    connected: true,
    request: async (method: string, params: { enabled?: boolean }) => {
      if (method === "capture.preview") capture.push(params.enabled === true);
      if (method.startsWith("input.")) inputs.push(method);
      return {};
    },
    close: async () => {},
  } as unknown as SimViewSession["client"];
  session.refreshDevice = async () => session.state();
  session.startRelay();
  return { session, capture, inputs };
}

function auth(url: string) {
  const parsed = new URL(url);
  return {
    origin: parsed.origin,
    headers: { authorization: `Bearer ${parsed.hash.slice(7)}` },
    token: parsed.hash.slice(7),
  };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for viewer state");
}

async function viewer(url: string, token: string, codec = "h264") {
  const socket = new WebSocket(
    `${new URL(url).origin.replace("http", "ws")}/stream?codec=${codec}`,
  );
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "authenticate", token }));
      resolve();
    };
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
  });
  return socket;
}

lanTest(
  "LAN capabilities are separate, revocable, and share review input and annotations",
  async () => {
    const { session, inputs } = fixture();
    const localUrl = session.browserUrl();
    const sharing = session.startLanSharing({ host });
    const remote = auth(sharing.url);
    expect(session.startLanSharing({ host }).url === sharing.url).toBe(true);
    expect(() => session.startLanSharing({ host, port: sharing.port })).toThrow("Stop LAN sharing");
    expect(JSON.stringify(session.lanSharingStatus()).includes(remote.token)).toBe(false);
    expect(JSON.stringify(session.state()).includes(remote.token)).toBe(false);
    expect((await fetch(`${remote.origin}/state`)).status).toBe(401);
    expect(
      (
        await fetch(`${remote.origin}/state`, {
          headers: { authorization: `Bearer ${session.relayToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(`${new URL(localUrl ?? "").origin}/state`, { headers: remote.headers })).status,
    ).toBe(401);
    const state = await (await fetch(`${remote.origin}/state`, { headers: remote.headers })).json();
    expect(state.reviewId).toBe(session.reviewId);
    expect(state.codec).toBe("mjpeg");
    for (const headers of [
      { ...remote.headers, origin: "http://evil.example" },
      { ...remote.headers, host: "evil.example" },
    ]) {
      expect((await fetch(`${remote.origin}/state`, { headers })).status).toBe(403);
    }
    const html = await fetch(remote.origin);
    expect(html.headers.get("content-security-policy")).toContain(
      `ws://${sharing.host}:${sharing.port}`,
    );
    expect(
      (
        await fetch(`${remote.origin}/annotation`, {
          method: "POST",
          headers: remote.headers,
          body: JSON.stringify({
            action: "add",
            geometry: { kind: "point", x: 0.5, y: 0.5 },
            note: "Shared note",
          }),
        })
      ).ok,
    ).toBe(true);
    expect(session.state().annotations[0]?.note).toBe("Shared note");
    expect(
      (
        await fetch(`${remote.origin}/input`, {
          method: "POST",
          headers: remote.headers,
          body: JSON.stringify({ method: "input.tap", params: { x: 0.5, y: 0.5 } }),
        })
      ).ok,
    ).toBe(true);
    expect(inputs).toEqual(["input.tap"]);
    await session.stopLanSharing();
    expect(session.browserUrl() === localUrl).toBe(true);
    expect(session.state().annotations).toHaveLength(1);
    const next = session.startLanSharing({ host, port: sharing.port });
    expect(next.url === sharing.url).toBe(false);
    expect((await fetch(`${remote.origin}/state`, { headers: remote.headers })).status).toBe(401);
    await session.stopLanSharing();
    expect(await session.stopLanSharing()).toEqual({ active: false });
  },
);

lanTest("LAN bind failure preserves the local review", async () => {
  const { session } = fixture();
  const occupied = Bun.serve({
    hostname: host ?? "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  try {
    expect(() => session.startLanSharing({ host, port: occupied.port })).toThrow(
      "Unable to listen",
    );
    expect(session.lanSharingStatus()).toEqual({ active: false });
    expect(session.browserUrl()).toBeDefined();
  } finally {
    occupied.stop(true);
  }
});

lanTest(
  "remote viewers force MJPEG, release it on stop, and preserve local and embedded capture",
  async () => {
    const { session, capture } = fixture();
    let released = 0;
    let enabled = false;
    let emitFrame: ((payload: Uint8Array) => void) | undefined;
    const attachment = spyOn(SimViewClient, "attach").mockResolvedValue({
      on: (kind: FrameKind, handler: (payload: Uint8Array) => void) => {
        expect(kind).toBe(FrameKind.JpegFrame);
        emitFrame = handler;
        return () => {
          emitFrame = undefined;
        };
      },
      request: async (method: string, params: { enabled: boolean }) => {
        expect(method).toBe("capture.preview");
        enabled = params.enabled;
        return {};
      },
      close: async () => {
        released += 1;
      },
    } as unknown as SimViewClient);
    let local: WebSocket | undefined;
    try {
      await session.previewPackets(undefined, 1, 50);
      local = await viewer(session.browserUrl() ?? "", session.relayToken);
      await waitFor(() => session.viewers.size === 1);
      const sharing = session.startLanSharing({ host });
      const remoteAuth = auth(sharing.url);
      const remote = await viewer(sharing.url, remoteAuth.token);
      await waitFor(() => session.viewers.size === 2 && attachment.mock.calls.length === 1);
      expect([...session.viewers].filter((entry) => entry.data.codec === "mjpeg")).toHaveLength(1);
      expect(enabled).toBe(true);
      const received = new Promise<ArrayBuffer>((resolve) => {
        remote.binaryType = "arraybuffer";
        remote.onmessage = (event) => resolve(event.data as ArrayBuffer);
      });
      emitFrame?.(new Uint8Array([1, 2, 3]));
      expect(new Uint8Array(await received)).toEqual(
        new Uint8Array([FrameKind.JpegFrame, 1, 2, 3]),
      );
      const closed = new Promise<void>((resolve) => {
        remote.onclose = () => resolve();
      });
      await session.stopLanSharing();
      await closed;
      expect(released).toBe(1);
      expect(session.viewers.size).toBe(1);
      expect(capture.at(-1)).toBe(true);
      local.close();
      await waitFor(() => session.viewers.size === 0);
      expect(capture.at(-1)).toBe(true);
      await Bun.sleep(5_050);
      await waitFor(() => capture.at(-1) === false);
    } finally {
      local?.close();
      attachment.mockRestore();
    }
  },
  7_000,
);

lanTest("closes a LAN viewer when MJPEG cannot resume after switching devices", async () => {
  const { session } = fixture();
  const nextDevice = parseDeviceDescription({
    udid: "LAN-NEXT",
    name: "Next device",
    state: "Booted",
    runtime: "iOS",
  });
  session.devices = async () => [nextDevice];
  const nextClient = {
    connected: true,
    on: () => () => {},
    onDisconnect: () => () => {},
    close: async () => {},
    request: async (method: string) => {
      if (method === "capture.start") return { device: nextDevice };
      if (method === "accessibility.providerStatus") {
        return { schemaVersion: 1, status: "native-ready", activeProvider: "core-simulator-ax" };
      }
      return {};
    },
  } as unknown as SimViewClient;
  const acquire = spyOn(SimViewClient, "acquire").mockResolvedValue(nextClient);
  const attachment = spyOn(SimViewClient, "attach")
    .mockResolvedValueOnce({
      on: () => () => {},
      request: async () => ({}),
      close: async () => {},
    } as unknown as SimViewClient)
    .mockRejectedValue(new Error("MJPEG attachment failed"));
  let remote: WebSocket | undefined;
  try {
    const sharing = session.startLanSharing({ host });
    remote = await viewer(sharing.url, auth(sharing.url).token);
    await waitFor(() => session.mjpegClient !== undefined);
    const closed = new Promise<CloseEvent>((resolve) => {
      if (remote) remote.onclose = resolve;
    });
    await session.selectDevice(nextDevice.id);
    expect((await closed).code).toBe(1011);
    expect(session.viewers.size).toBe(0);
    expect(session.client).toBe(nextClient);
    expect(session.lanSharingStatus().active).toBe(true);
  } finally {
    remote?.close();
    acquire.mockRestore();
    attachment.mockRestore();
  }
});

lanTest(
  "MCP exposes explicit sharing operations with validated status and revocation",
  async () => {
    const { session } = fixture();
    const server = createServer(session);
    const client = new Client({ name: "lan-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "start_lan_sharing", arguments: { host } });
      expect(result.isError).not.toBe(true);
      const sharing = lanSharingStartedSchema.parse(result.structuredContent);
      const status = await client.callTool({ name: "get_lan_sharing_status", arguments: {} });
      expect(lanSharingStatusSchema.parse(status.structuredContent).active).toBe(true);
      expect(JSON.stringify(status).includes(auth(sharing.url).token)).toBe(false);
      const stopped = await client.callTool({ name: "stop_lan_sharing", arguments: {} });
      expect(lanSharingStatusSchema.parse(stopped.structuredContent).active).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

lanTest(
  "rejects a local token on the LAN WebSocket and invalidates sharing on session close",
  async () => {
    const { session } = fixture();
    const sharing = session.startLanSharing({ host });
    const socket = await viewer(sharing.url, session.relayToken);
    const closed = await new Promise<CloseEvent>((resolve) => {
      socket.onclose = resolve;
    });
    expect(closed.code).toBe(1008);
    expect(session.viewers.size).toBe(0);
    await session.close();
    expect(session.lanSharingStatus()).toEqual({ active: false });
    expect(session.browserUrl()).toBeUndefined();
    expect(() => session.startLanSharing({ host })).toThrow();
  },
);

lanTest("stopping sharing while MJPEG attaches closes the late attachment", async () => {
  const { session } = fixture();
  let resolveAttachment: ((value: SimViewClient) => void) | undefined;
  let closed = false;
  const attachment = spyOn(SimViewClient, "attach").mockImplementation(
    () =>
      new Promise<SimViewClient>((resolve) => {
        resolveAttachment = resolve;
      }),
  );
  try {
    const sharing = session.startLanSharing({ host });
    const socket = await viewer(sharing.url, auth(sharing.url).token);
    await waitFor(() => resolveAttachment !== undefined);
    await session.stopLanSharing();
    resolveAttachment?.({
      close: async () => {
        closed = true;
      },
    } as unknown as SimViewClient);
    await waitFor(() => closed);
    expect(session.mjpegClient).toBeUndefined();
    expect(session.viewers.size).toBe(0);
    socket.close();
  } finally {
    attachment.mockRestore();
  }
});
