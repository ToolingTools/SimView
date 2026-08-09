import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCodexPluginArchiveSize,
  assertNoRepowiseArtifacts,
  createNpmPackageManifest,
  createPackagedMcpConfig,
  maxCodexPluginArchiveBytes,
  repositoryUrl,
} from "../scripts/release-config";

const root = join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

  test("keeps generic navigation out of destination verification guidance", async () => {
    const skill = await Bun.file(join(root, "skills/simview/SKILL.md")).text();

    expect(skill).toContain("`verifyDestination` is optional");
    expect(skill).toContain("For generic section/menu navigation");
    expect(skill).toContain("Never copy the tapped control's label");
    expect(skill).toContain("`Invoices`, `Orders`, `Card`, or `Pay`");
  });

  test("keeps rendered-list exploration guidance in the packaged skill", async () => {
    const skill = await Bun.file("skills/simview/SKILL.md").text();
    expect(skill).toContain("Semantic search covers the currently rendered tree only");
    expect(skill).toContain("never batch speculative swipes");
    expect(skill).toContain("eight exploratory swipes");
    expect(skill).toContain("report discovery as inconclusive");
  });

  test("rejects npm archives larger than the Codex plugin limit", () => {
    expect(() =>
      assertCodexPluginArchiveSize(maxCodexPluginArchiveBytes, "simview.tgz"),
    ).not.toThrow();
    expect(() =>
      assertCodexPluginArchiveSize(maxCodexPluginArchiveBytes + 1, "simview.tgz"),
    ).toThrow("exceeding the Codex plugin archive limit");
  });

  test("packages only the SimView MCP server and rejects Repowise state", async () => {
    const packaged = createPackagedMcpConfig({
      mcpServers: {
        simview: { command: "./bin/simview", args: ["mcp"] },
        repowise: { command: "repowise", args: ["mcp", "/local/repository"] },
      },
    });
    expect(packaged).toEqual({
      mcpServers: { simview: { command: "./bin/simview", args: ["mcp"] } },
    });

    const stage = await mkdtemp(join(tmpdir(), "simview-release-stage-"));
    temporaryDirectories.push(stage);
    await writeFile(join(stage, ".mcp.json"), `${JSON.stringify(packaged)}\n`);
    await expect(assertNoRepowiseArtifacts(stage)).resolves.toBeUndefined();

    await mkdir(join(stage, ".repowise"));
    await expect(assertNoRepowiseArtifacts(stage)).rejects.toThrow(
      "Release artifact contains Repowise state",
    );
  });
});
