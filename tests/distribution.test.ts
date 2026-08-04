import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertOwnedIOSRunnerTree } from "../scripts/ios-runner-source";
import {
  assertCodexPluginArchiveSize,
  createNpmPackageManifest,
  maxCodexPluginArchiveBytes,
  repositoryUrl,
} from "../scripts/release-config";

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

    expect(manifest.name).toBe("@toolingtools/simview");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.os).toEqual(["darwin"]);
    expect(manifest.cpu).toEqual(["arm64"]);
    expect(manifest.bin).toEqual({ simview: "./bin/simview" });
    expect(manifest.dependencies).toBeUndefined();
    expect((manifest as { keywords?: string[] }).keywords).toContain("android");
    expect((manifest as { keywords?: string[] }).keywords).toContain("adb");
    expect(repositoryUrl).toBe("https://github.com/ToolingTools/SimView");
    expect(manifest.repository.url).toBe(`${repositoryUrl}.git`);
  });

  test("routes plugins and MCPB through the consolidated executable", async () => {
    const mcp = (await Bun.file(join(root, ".mcp.json")).json()) as {
      mcpServers: { simview: { command: string; args: string[]; cwd: string } };
    };
    const claudePlugin = (await Bun.file(join(root, ".claude-plugin/plugin.json")).json()) as {
      mcpServers: { simview: { command: string; args: string[] } };
    };
    const codexPlugin = (await Bun.file(join(root, ".codex-plugin/plugin.json")).json()) as {
      mcpServers: string;
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
      cwd: ".",
    });
    expect(codexPlugin.mcpServers).toBe("./.mcp.json");
    expect(claudePlugin.mcpServers.simview).toEqual({
      command: "$" + "{CLAUDE_PLUGIN_ROOT}/bin/simview",
      args: ["mcp"],
    });
    expect(mcpb.server.entry_point).toBe("bin/simview");
    expect(mcpb.server.mcp_config).toEqual({
      command: "$" + "{__dirname}/bin/simview",
      args: ["mcp"],
    });
  });

  test("rejects npm archives larger than the Codex plugin limit", () => {
    expect(() =>
      assertCodexPluginArchiveSize(maxCodexPluginArchiveBytes, "simview.tgz"),
    ).not.toThrow();
    expect(() =>
      assertCodexPluginArchiveSize(maxCodexPluginArchiveBytes + 1, "simview.tgz"),
    ).toThrow("exceeding the Codex plugin archive limit");
  });

  test("packages only SimView-owned iOS runner sources", async () => {
    await expect(
      assertOwnedIOSRunnerTree(join(root, "native", "SimViewIOSDeviceRunner")),
    ).resolves.toBeUndefined();
  });
});
