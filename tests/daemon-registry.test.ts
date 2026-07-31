import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  daemonRecordSchema,
  daemonStatuses,
  daemonStatusSchema,
  isPathInside,
  pruneDaemons,
  SimViewClient,
  stopDaemons,
} from "@simview/client";
import { PROTOCOL_VERSION, SIMVIEW_VERSION } from "@simview/contracts";

describe("shared backend registry contracts", () => {
  const record = {
    schemaVersion: 1 as const,
    pid: 123,
    udid: "0C0D99C2-D3ED-4C06-A7D1-6E197A8B214C",
    socketPath: "/tmp/simview-daemons/501/0123456789abcdef0123/core.sock",
    token: "a".repeat(64),
    protocolVersion: PROTOCOL_VERSION,
    simviewVersion: SIMVIEW_VERSION,
    binarySha256: "b".repeat(64),
    instanceId: "0123456789abcdef0123",
    startedAt: "2026-07-31T10:00:00.000Z",
  };

  test("validates private records and excludes their token from status", () => {
    expect(daemonRecordSchema.parse(record).token).toHaveLength(64);
    const status = daemonStatusSchema.parse({
      instanceId: record.instanceId,
      pid: record.pid,
      udid: record.udid,
      protocolVersion: record.protocolVersion,
      simviewVersion: record.simviewVersion,
      binarySha256: record.binarySha256,
      startedAt: record.startedAt,
      health: { status: "ok" },
    });
    expect(JSON.stringify(status)).not.toContain(record.token);
  });

  test("rejects malformed compatibility metadata and path escapes", () => {
    expect(daemonRecordSchema.safeParse({ ...record, binarySha256: "short" }).success).toBe(false);
    expect(daemonRecordSchema.safeParse({ ...record, simviewVersion: "" }).success).toBe(false);
    expect(isPathInside("/tmp/registry/instance", "/tmp/registry/instance/core.sock")).toBe(true);
    expect(isPathInside("/tmp/registry/instance", "/tmp/registry/other/core.sock")).toBe(false);
  });

  test("can inspect trusted records from an earlier SimView version", () => {
    const historical = daemonRecordSchema.parse({ ...record, simviewVersion: "0.1.0" });
    expect(historical.simviewVersion).toBe("0.1.0");
  });

  test("serializes simultaneous starters and keeps the backend alive for remaining clients", async () => {
    const binary = fileURLToPath(new URL("fixtures/fake-simview-core.ts", import.meta.url));
    await chmod(binary, 0o755);
    const udid = randomUUID().toUpperCase();
    let first: SimViewClient | undefined;
    let second: SimViewClient | undefined;
    try {
      [first, second] = await Promise.all([
        SimViewClient.acquire({ udid, binary }),
        SimViewClient.acquire({ udid, binary }),
      ]);
      expect(first.socketPath).toBe(second.socketPath);
      const health = await second.request("health.get", {});
      expect(health.clients).toBe(2);
      await first.close();
      first = undefined;
      expect((await second.request("health.get", {})).clients).toBe(1);
      const statuses = await daemonStatuses(SimViewClient);
      expect(statuses.filter((item) => item.udid === udid)).toHaveLength(1);
    } finally {
      await first?.close();
      await second?.close();
      await stopDaemons(SimViewClient, { udid }).catch(() => {});
      await waitForDaemonExit(udid);
      await pruneDaemons(udid);
    }
  });

  test("uses distinct backend identities for different binary hashes", async () => {
    const binary = fileURLToPath(new URL("fixtures/fake-simview-core.ts", import.meta.url));
    const wrapper = fileURLToPath(
      new URL("fixtures/fake-simview-core-wrapper.sh", import.meta.url),
    );
    await Promise.all([chmod(binary, 0o755), chmod(wrapper, 0o755)]);
    const udid = randomUUID().toUpperCase();
    let first: SimViewClient | undefined;
    let second: SimViewClient | undefined;
    try {
      first = await SimViewClient.acquire({ udid, binary });
      second = await SimViewClient.acquire({ udid, binary: wrapper });
      expect(first.socketPath).not.toBe(second.socketPath);
      expect(
        (await daemonStatuses(SimViewClient)).filter((item) => item.udid === udid),
      ).toHaveLength(2);
    } finally {
      await Promise.all([first?.close(), second?.close()]);
      await stopDaemons(SimViewClient, { udid }).catch(() => {});
      await waitForDaemonExit(udid);
      await pruneDaemons(udid);
    }
  });
});

async function waitForDaemonExit(udid: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const statuses = await daemonStatuses(SimViewClient).catch(() => []);
    if (!statuses.some((item) => item.udid === udid)) return;
    await Bun.sleep(20);
  }
}
