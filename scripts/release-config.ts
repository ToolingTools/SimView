import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const repositoryUrl = "https://github.com/ToolingTools/SimView";
export const maxCodexPluginArchiveBytes = 50 * 1024 * 1024;

export function assertCodexPluginArchiveSize(bytes: number, path: string): void {
  if (bytes > maxCodexPluginArchiveBytes) {
    throw new Error(
      `${path} is ${bytes} bytes, exceeding the Codex plugin archive limit of ${maxCodexPluginArchiveBytes} bytes`,
    );
  }
}

export function createNpmPackageManifest(
  version: string,
  name = "@toolingtools/simview",
): Record<string, unknown> {
  return {
    name,
    version,
    description:
      "Control and review local iOS Simulators and Android devices from the command line or an MCP host.",
    license: "Apache-2.0",
    author: {
      name: "SimView contributors",
      url: repositoryUrl,
    },
    homepage: `${repositoryUrl}#readme`,
    repository: {
      type: "git",
      url: `${repositoryUrl}.git`,
    },
    bugs: {
      url: `${repositoryUrl}/issues`,
    },
    keywords: [
      "ios",
      "android",
      "simulator",
      "emulator",
      "adb",
      "cli",
      "mcp",
      "codex",
      "claude-code",
    ],
    os: ["darwin"],
    cpu: ["arm64"],
    bin: {
      simview: "./bin/simview",
    },
    files: [
      "bin/",
      "app/",
      "assets/",
      "skills/",
      ".codex-plugin/",
      ".claude-plugin/",
      ".mcp.json",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ],
    publishConfig: {
      access: "public",
      provenance: true,
    },
  };
}

export function createPackagedMcpConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object") {
    throw new Error("The project MCP configuration must be an object");
  }
  const servers = (config as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object") {
    throw new Error("The project MCP configuration has no mcpServers object");
  }
  const simview = (servers as Record<string, unknown>).simview;
  if (!simview || typeof simview !== "object") {
    throw new Error("The project MCP configuration has no SimView server");
  }
  return { mcpServers: { simview } };
}

export async function assertNoRepowiseArtifacts(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.toLowerCase().includes("repowise")) {
        throw new Error(`Release artifact contains Repowise state: ${join(directory, entry.name)}`);
      }
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  };
  await visit(root);

  const mcpPath = join(root, ".mcp.json");
  const mcp = await readFile(mcpPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (mcp?.toLowerCase().includes("repowise")) {
    throw new Error(`Release artifact contains Repowise MCP configuration: ${mcpPath}`);
  }
}
