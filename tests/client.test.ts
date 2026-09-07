import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  encodeFrame,
  FrameDecoder,
  FrameKind,
  type ProtocolRequest,
  resolveNativeEnvironment,
  SimViewClient,
} from "@simview/client";

const resources: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((cleanup) => cleanup()));
});

describe("SimViewClient", () => {
  test("authenticates and validates method-keyed results", async () => {
    await withCore(
      (request, respond) => {
        if (request.method === "hello") return respond(request.id, helloResult());
        if (request.method === "devices.list") return respond(request.id, []);
      },
      async ({ socketPath, token }) => {
        const client = await SimViewClient.attach(socketPath, token);
        resources.push(() => client.close());
        expect(await client.request("devices.list", {})).toEqual([]);
      },
    );
  });

  test("rejects a malformed native result with the method name", async () => {
    await withCore(
      (request, respond) => {
        if (request.method === "hello") return respond(request.id, helloResult());
        if (request.method === "devices.list") return respond(request.id, [{ name: "Incomplete" }]);
      },
      async ({ socketPath, token }) => {
        const client = await SimViewClient.attach(socketPath, token);
        resources.push(() => client.close());
        await expect(client.request("devices.list", {})).rejects.toThrow(
          "Invalid devices.list result from simview-core",
        );
      },
    );
  });

  test("enforces request deadlines and preflight cancellation", async () => {
    await withCore(
      (request, respond) => {
        if (request.method === "hello") respond(request.id, helloResult());
      },
      async ({ socketPath, token }) => {
        const client = await SimViewClient.attach(socketPath, token);
        resources.push(() => client.close());
        await expect(client.request("devices.list", {}, { timeoutMs: 20 })).rejects.toThrow(
          "devices.list timed out after 20ms",
        );

        const controller = new AbortController();
        controller.abort(new Error("cancelled"));
        await expect(
          client.request("devices.list", {}, { signal: controller.signal }),
        ).rejects.toThrow("cancelled");
      },
    );
  });

  test("cancels and reaps a hanging device discovery child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simview-discovery-test-"));
    const binary = join(directory, "hang.ts");
    const pidPath = join(directory, "child.pid");
    const descendantPath = join(directory, "descendant.pid");
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nconst descendant = Bun.spawn([process.execPath, '-e', ${JSON.stringify(`await Bun.write(${JSON.stringify(descendantPath)}, String(process.pid)); await Bun.sleep(60_000);`)}], { stdout: 'inherit', stderr: 'inherit' });\nawait Bun.write(${JSON.stringify(pidPath)}, String(process.pid));\nawait Bun.sleep(60_000);\n`,
      { mode: 0o700 },
    );
    await chmod(binary, 0o700);
    const controller = new AbortController();
    const discovery = SimViewClient.listDevices(binary, undefined, {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    let pid: number | undefined;
    let descendantPID: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await readFile(pidPath, "utf8").catch(() => "");
      const descendantValue = await readFile(descendantPath, "utf8").catch(() => "");
      if (value && descendantValue) {
        pid = Number(value);
        descendantPID = Number(descendantValue);
        break;
      }
      await Bun.sleep(10);
    }
    expect(pid).toBeGreaterThan(0);
    expect(descendantPID).toBeGreaterThan(0);
    controller.abort(new Error("review closed"));
    await expect(discovery).rejects.toThrow("review closed");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid as number, 0);
        process.kill(descendantPID as number, 0);
      } catch {
        await rm(directory, { recursive: true, force: true });
        return;
      }
      await Bun.sleep(10);
    }
    try {
      process.kill(pid as number, "SIGKILL");
      process.kill(descendantPID as number, "SIGKILL");
    } catch {
      // The child exited between the final probe and cleanup.
    }
    await rm(directory, { recursive: true, force: true });
    throw new Error("Cancelled discovery child was not reaped");
  });

  test("runs device discovery in its requester cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simview-discovery-cwd-test-"));
    const binary = join(directory, "cwd.ts");
    const cwdPath = join(directory, "observed-cwd");
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(cwdPath)}, process.cwd());\nconsole.log('[]');\n`,
      { mode: 0o700 },
    );
    await chmod(binary, 0o700);
    try {
      await expect(
        SimViewClient.listDevices(binary, undefined, { cwd: directory }),
      ).resolves.toEqual([]);
      expect((await readFile(cwdPath, "utf8")).trim()).toBe(await realpath(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("canonicalizes relative native paths while preserving empty overrides", () => {
    const environment = resolveNativeEnvironment(
      {
        PATH: "bin::/usr/bin",
        SIMVIEW_ADB_PATH: "",
        SIMVIEW_PROBE_DYLIB: "probe.dylib",
      },
      "/tmp/requester",
    );
    expect(environment.PATH).toBe("/tmp/requester/bin:/tmp/requester:/usr/bin");
    expect(environment.SIMVIEW_ADB_PATH).toBe("");
    expect(environment.SIMVIEW_PROBE_DYLIB).toBe("/tmp/requester/probe.dylib");
  });
});

type Respond = (id: string, result: unknown) => void;

async function withCore(
  handle: (request: ProtocolRequest, respond: Respond) => void,
  run: (connection: { socketPath: string; token: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "simview-client-test-"));
  const socketPath = join(directory, "core.sock");
  const decoders = new WeakMap<object, FrameDecoder>();
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        const decoder = decoders.get(socket) ?? new FrameDecoder();
        decoders.set(socket, decoder);
        for (const frame of decoder.push(new Uint8Array(data))) {
          if (frame.kind !== FrameKind.Request) continue;
          const request = JSON.parse(new TextDecoder().decode(frame.payload)) as ProtocolRequest;
          handle(request, (id, result) => {
            socket.write(
              encodeFrame(
                FrameKind.Response,
                new TextEncoder().encode(JSON.stringify({ id, result })),
              ),
            );
          });
        }
      },
    },
  });
  resources.push(async () => {
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  });
  await run({ socketPath, token: "a".repeat(64) });
}

function helloResult() {
  return {
    protocolVersion: 4,
    codec: "h264",
    maxFrameRate: 60,
    server: "simview-core/test",
    capabilities: {
      capture: true,
      input: true,
      accessibility: true,
      probe: false,
    },
  };
}
