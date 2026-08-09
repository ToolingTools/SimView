import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { SimViewSession } from "../packages/mcp/src/session";

const sessions: SimViewSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe("browser relay authentication", () => {
  test("protects HTTP state with a Bearer token and never returns the capability", async () => {
    const session = relaySession();
    const origin = relayOrigin(session);

    expect((await fetch(`${origin}/state`)).status).toBe(401);

    const response = await fetch(`${origin}/state`, {
      headers: { authorization: `Bearer ${session.relayToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      reviewId: session.reviewId,
      annotations: [],
      codec: "h264",
      connected: false,
    });
    expect(JSON.stringify(body)).not.toContain(session.relayToken);
  });

  test("upgrades WebSockets without an HTTP token and rejects a bad first message", async () => {
    const session = relaySession();
    const origin = relayOrigin(session).replace(/^http/, "ws");
    const close = new Promise<CloseEvent>((resolve, reject) => {
      const socket = new WebSocket(`${origin}/stream?codec=h264`);
      socket.addEventListener("open", () => socket.send("not-json"));
      socket.addEventListener("error", () => reject(new Error("WebSocket upgrade failed")));
      socket.addEventListener("close", resolve);
    });

    const event = await close;
    expect(event.code).toBe(1008);
  });

  test("gates a newly authenticated H.264 viewer until a bootstrapped keyframe", async () => {
    const session = relaySession();
    session.client = {
      connected: true,
      request: async () => undefined,
      close: async () => undefined,
    } as unknown as SimViewSession["client"];
    const origin = relayOrigin(session).replace(/^http/, "ws");
    const socket = new WebSocket(`${origin}/stream?codec=h264`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "authenticate", token: session.relayToken }));
        resolve();
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket upgrade failed")));
    });

    for (let attempt = 0; attempt < 20 && session.viewers.size === 0; attempt += 1) {
      await Bun.sleep(5);
    }

    expect(session.viewers.size).toBe(1);
    expect([...session.viewers][0]?.data.waitingForKeyframe).toBe(true);
    socket.close();
  });

  test("returns a client error for malformed authenticated relay input", async () => {
    const session = relaySession();
    const response = await fetch(`${relayOrigin(session)}/input`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.relayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "input.tap", params: { x: 4, y: 0 } }),
    });
    expect(response.status).toBe(400);
  });

  test("exports each browser review bundle privately without replacing earlier copies", async () => {
    const session = relaySession();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==";
    const annotationId = "e7787f9d-cfd8-4f52-b136-f16d02d30d30";
    const exportReview = () =>
      fetch(`${relayOrigin(session)}/review-images`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.relayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          screenshot: png,
          annotations: [{ id: annotationId, screenshot: png }],
        }),
      });

    const first = await exportReview();
    const firstBundle = await first.json();
    const second = await exportReview();
    const secondBundle = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBundle.directory).not.toBe(secondBundle.directory);
    expect((await stat(firstBundle.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(firstBundle.screenshotPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(firstBundle.screenshotPath).exists()).toBe(true);
    expect(await Bun.file(firstBundle.annotations[0].screenshotPath).exists()).toBe(true);
    expect(await Bun.file(secondBundle.screenshotPath).exists()).toBe(true);
  });
});

function relaySession(): SimViewSession {
  const session = new SimViewSession();
  let started = false;
  for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
    try {
      session.startRelay(40_000 + Math.floor(Math.random() * 20_000));
      started = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  if (!started) throw new Error("Could not allocate a relay test port");
  sessions.push(session);
  return session;
}

function relayOrigin(session: SimViewSession): string {
  if (!session.relay) throw new Error("Relay did not start");
  return `http://${session.relay.hostname}:${session.relay.port}`;
}
