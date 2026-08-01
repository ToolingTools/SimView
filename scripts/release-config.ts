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
    description: "Control and review a local iOS Simulator from the command line or an MCP host.",
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
    keywords: ["ios", "simulator", "cli", "mcp", "codex", "claude-code"],
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
