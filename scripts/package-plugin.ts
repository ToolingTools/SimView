import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const stage = join(root, "artifacts", "plugin", "simview");
const output = join(root, "artifacts", "simview-plugin.zip");
const compiledBinaries = [
  "packages/mcp/dist/simview-mcp-arm64",
  "packages/mcp/dist/simview-mcp-x64",
  "packages/cli/dist/simview-arm64",
  "packages/cli/dist/simview-x64",
];
const compiledSourcePackages = ["client", "core", "mcp", "cli"];

const sourceFiles = compiledSourcePackages.flatMap(packageName =>
  [...new Bun.Glob("src/**/*.ts").scanSync({
    cwd: join(root, "packages", packageName),
    absolute: true,
  })]
);
const newestSource = Math.max(
  ...await Promise.all(sourceFiles.map(async path => (await stat(path)).mtimeMs)),
);
for (const relativePath of compiledBinaries) {
  const binary = join(root, relativePath);
  if ((await stat(binary)).mtimeMs < newestSource) {
    throw new Error(
      `${relativePath} is older than the TypeScript it embeds. `
      + "Run `bun scripts/build-release.ts` before packaging the plugin.",
    );
  }
}

await rm(join(root, "artifacts", "plugin"), { recursive: true, force: true });
await mkdir(join(stage, "bin"), { recursive: true });
await mkdir(join(stage, "app"), { recursive: true });
await $`cp -R ${join(root, ".codex-plugin")} ${join(root, ".claude-plugin")} ${join(root, "skills")} ${join(root, "assets")} ${stage}`;
await $`cp ${join(root, ".mcp.json")} ${join(root, "LICENSE")} ${join(root, "THIRD_PARTY_NOTICES.md")} ${stage}`;
await $`cp -R ${join(root, "packages/app/dist")} ${join(stage, "app/dist")}`;
await $`cp ${join(root, "packages/mcp/dist/simview-mcp-arm64")} ${join(stage, "bin/simview-mcp-arm64")}`;
await $`cp ${join(root, "packages/mcp/dist/simview-mcp-x64")} ${join(stage, "bin/simview-mcp-x64")}`;
await $`cp ${join(root, "packages/cli/dist/simview-arm64")} ${join(stage, "bin/simview-arm64")}`;
await $`cp ${join(root, "packages/cli/dist/simview-x64")} ${join(stage, "bin/simview-x64")}`;
await $`cp ${join(root, "packages/core/bin/simview-core")} ${join(stage, "bin/simview-core")}`;
await $`cp ${join(root, "packages/core/bin/libSimViewProbe.dylib")} ${join(stage, "bin/libSimViewProbe.dylib")}`;
await $`cp ${join(root, "scripts/launch-simview-mcp")} ${join(stage, "bin/simview-mcp")}`;
await $`chmod +x ${join(stage, "bin/simview-mcp")}`;
await rm(output, { force: true });
await $`ditto -c -k --sequesterRsrc --keepParent ${stage} ${output}`;
console.log(output);
