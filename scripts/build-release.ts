import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const artifacts = join(root, "artifacts", "release");
const version = JSON.parse(await Bun.file(join(root, "package.json")).text()).version as string;

await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

await $`bun run check`;
await $`bun run build:app`;
await $`bun run build:packages`;
await $`bun run build:probe`;
await $`swift build --disable-sandbox --package-path ${join(root, "native/SimViewCore")} -c release --arch arm64 --arch x86_64`;
await $`bun run --cwd ${join(root, "packages/mcp")} compile`;
await $`bun run --cwd ${join(root, "packages/cli")} compile`;

const nativeBinary = join(root, "native/SimViewCore/.build/apple/Products/Release/simview-core");
const probeBinary = join(root, "native/SimViewProbe/build/libSimViewProbe.dylib");
await mkdir(join(root, "packages/core/bin"), { recursive: true });
await $`cp ${nativeBinary} ${join(root, "packages/core/bin/simview-core")}`;
await $`cp ${probeBinary} ${join(root, "packages/core/bin/libSimViewProbe.dylib")}`;
await $`cp ${nativeBinary} ${join(artifacts, "simview-core")}`;
await $`cp ${probeBinary} ${join(artifacts, "libSimViewProbe.dylib")}`;
await $`cp ${join(root, "packages/mcp/dist/simview-mcp-arm64")} ${join(artifacts, "simview-mcp-arm64")}`;
await $`cp ${join(root, "packages/mcp/dist/simview-mcp-x64")} ${join(artifacts, "simview-mcp-x64")}`;
await $`cp ${join(root, "packages/cli/dist/simview-arm64")} ${join(artifacts, "simview-arm64")}`;
await $`cp ${join(root, "packages/cli/dist/simview-x64")} ${join(artifacts, "simview-x64")}`;
await $`bun run package:plugin`;
await $`bun run package:mcpb`;
await $`cp ${join(root, "artifacts/simview-plugin.zip")} ${artifacts}`;
await $`cp ${join(root, "artifacts/simview.mcpb")} ${artifacts}`;

const files = [...new Bun.Glob("*").scanSync({ cwd: artifacts })].sort();
const components = await Promise.all(files.map(async name => ({
  type: "file",
  name,
  version,
  hashes: [{
    alg: "SHA-256",
    content: new Bun.CryptoHasher("sha256").update(await Bun.file(join(artifacts, name)).arrayBuffer()).digest("hex"),
  }],
})));
await writeFile(join(artifacts, "sbom.cdx.json"), `${JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: { component: { type: "application", name: "simview", version } },
  components,
}, null, 2)}\n`);
const sums = components
  .map(component => `${component.hashes[0]!.content}  ${component.name}`)
  .join("\n");
await writeFile(join(artifacts, "SHA256SUMS"), `${sums}\n`);
console.log(artifacts);
