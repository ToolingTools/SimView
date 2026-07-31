import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createNpmPackageManifest, repositoryUrl } from "../scripts/release-config";

const root = join(import.meta.dir, "..");

describe("release distribution", () => {
  test("publishes one standalone macOS command", () => {
    const manifest = createNpmPackageManifest("1.2.3") as {
      name: string;
      version: string;
      os: string[];
      cpu: string[];
      bin: Record<string, string>;
      dependencies?: Record<string, string>;
      repository: { url: string };
    };

    expect(manifest.name).toBe("simview");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.os).toEqual(["darwin"]);
    expect(manifest.cpu).toEqual(["arm64", "x64"]);
    expect(manifest.bin).toEqual({ simview: "./bin/simview" });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.repository.url).toBe(`${repositoryUrl}.git`);
  });

  test("routes Codex and MCPB through the consolidated executable", async () => {
    const mcp = (await Bun.file(join(root, ".mcp.json")).json()) as {
      mcpServers: { simview: { command: string; args: string[] } };
    };
    const mcpb = (await Bun.file(join(root, "manifest.json")).json()) as {
      server: {
        entry_point: string;
        mcp_config: { command: string; args: string[] };
      };
    };

    expect(mcp.mcpServers.simview).toMatchObject({
      command: "./bin/simview",
      args: ["mcp"],
    });
    expect(mcpb.server.entry_point).toBe("bin/simview");
    expect(mcpb.server.mcp_config).toEqual({
      command: "$" + "{__dirname}/bin/simview",
      args: ["mcp"],
    });
  });
});
