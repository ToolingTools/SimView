import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const stage = join(root, "artifacts", "plugin", "simview");
const output = join(root, "artifacts", "simview-plugin.zip");
const compiledArtifacts = [
  "packages/cli/dist/simview",
  "packages/core/bin/simview-core",
  "packages/core/bin/libSimViewProbe.dylib",
  "packages/core/bin/simview-android-agent.jar",
];
const compiledSourcePackages = ["app", "client", "contracts", "core", "mcp", "cli"];

const sourceFiles = compiledSourcePackages.flatMap((packageName) => [
  ...new Bun.Glob("src/**/*.ts").scanSync({
    cwd: join(root, "packages", packageName),
    absolute: true,
  }),
  ...new Bun.Glob("src/**/*.tsx").scanSync({
    cwd: join(root, "packages", packageName),
    absolute: true,
  }),
]);
sourceFiles.push(
  ...new Bun.Glob("Sources/**/*.{swift,m,h}").scanSync({
    cwd: join(root, "native", "SimViewCore"),
    absolute: true,
  }),
  ...new Bun.Glob("**/*.{m,h}").scanSync({
    cwd: join(root, "native", "SimViewProbe"),
    absolute: true,
  }),
  ...new Bun.Glob("src/**/*.java").scanSync({
    cwd: join(root, "native", "SimViewAndroid"),
    absolute: true,
  }),
  join(root, "native", "SimViewCore", "Package.swift"),
  join(root, "packages", "app", "src", "preview.html"),
  join(root, "package.json"),
  join(root, "manifest.json"),
  join(root, ".codex-plugin", "plugin.json"),
);
const newestSource = Math.max(
  ...(await Promise.all(sourceFiles.map(async (path) => (await stat(path)).mtimeMs))),
);
for (const relativePath of compiledArtifacts) {
  const binary = join(root, relativePath);
  if ((await stat(binary)).mtimeMs < newestSource) {
    throw new Error(
      `${relativePath} is older than the source used to build the release. ` +
        "Run `bun scripts/build-release.ts` before packaging the plugin.",
    );
  }
}

await rm(join(root, "artifacts", "plugin"), { recursive: true, force: true });
await mkdir(join(stage, "bin"), { recursive: true });
await mkdir(join(stage, "app"), { recursive: true });
await mkdir(join(stage, "assets"), { recursive: true });
await $`cp -R ${join(root, ".codex-plugin")} ${join(root, ".claude-plugin")} ${join(root, "skills")} ${stage}`;
await $`cp ${join(root, "assets/icon-512.png")} ${join(stage, "assets/icon-512.png")}`;
await $`cp ${join(root, ".mcp.json")} ${join(root, "README.md")} ${join(root, "LICENSE")} ${join(root, "THIRD_PARTY_NOTICES.md")} ${stage}`;
await $`cp -R ${join(root, "packages/app/dist")} ${join(stage, "app/dist")}`;
await $`cp ${join(root, "packages/cli/dist/simview")} ${join(stage, "bin/simview")}`;
await $`cp ${join(root, "packages/core/bin/simview-core")} ${join(stage, "bin/simview-core")}`;
await $`cp ${join(root, "packages/core/bin/libSimViewProbe.dylib")} ${join(stage, "bin/libSimViewProbe.dylib")}`;
await $`cp ${join(root, "packages/core/bin/simview-android-agent.jar")} ${join(stage, "bin/simview-android-agent.jar")}`;
await $`chmod +x ${join(stage, "bin/simview")} ${join(stage, "bin/simview-core")}`;
for (const path of new Bun.Glob("**/.DS_Store").scanSync({ cwd: stage, absolute: true })) {
  await rm(path, { force: true });
}
await rm(output, { force: true });
await $`ditto -c -k --norsrc --keepParent ${stage} ${output}`;
console.log(output);
