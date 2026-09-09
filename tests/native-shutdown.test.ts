import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { SimViewClient } from "@simview/client";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test.skipIf(process.platform !== "darwin")(
  "native shutdown removes its socket before process exit",
  async () => {
    const binary = new URL("../packages/core/bin/simview-core", import.meta.url).pathname;
    const client = await SimViewClient.start({ binary });
    const child = client.process;
    if (!child) throw new Error("Expected an owned native fixture process");
    const deadline = setTimeout(() => child.kill(9), 5_000);
    try {
      expect(await exists(client.socketPath)).toBe(true);
      await client.request("server.shutdown", {});
      expect(await child.exited).toBe(0);
      // Check before client.close(), which also performs best-effort cleanup.
      expect(await exists(client.socketPath)).toBe(false);
    } finally {
      clearTimeout(deadline);
      await client.close();
    }
  },
  15_000,
);
