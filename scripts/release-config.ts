export const repositoryUrl = "https://github.com/steve228uk/SimView";

export function createNpmPackageManifest(
  version: string,
  name = "simview",
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
    keywords: [
      "ios",
      "simulator",
      "cli",
      "mcp",
      "codex",
      "claude-code",
    ],
    os: ["darwin"],
    cpu: ["arm64", "x64"],
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
