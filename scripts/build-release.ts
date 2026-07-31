import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const artifacts = join(root, "artifacts", "release");
const archiveRoot = join(root, "artifacts", "archive");
const rootManifest = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
};
const { version } = rootManifest;

await rm(artifacts, { recursive: true, force: true });
await rm(archiveRoot, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

await $`bun run check`;
await $`bun run build:app`;
await $`bun run build:packages`;
await $`bun run build:probe`;
await $`swift build --disable-sandbox --package-path ${join(root, "native/SimViewCore")} -c release --arch arm64 --arch x86_64`;
await $`bun run --cwd ${join(root, "packages/cli")} compile`;

const nativeBinary = join(root, "native/SimViewCore/.build/apple/Products/Release/simview-core");
const probeBinary = join(root, "native/SimViewProbe/build/libSimViewProbe.dylib");
const cliBinary = join(root, "packages/cli/dist/simview");
const packagedCore = join(root, "packages/core/bin/simview-core");
const packagedProbe = join(root, "packages/core/bin/libSimViewProbe.dylib");
await mkdir(join(root, "packages/core/bin"), { recursive: true });
await cp(nativeBinary, packagedCore);
await cp(probeBinary, packagedProbe);

if (process.env.SIMVIEW_SIGNING_IDENTITY) {
  await $`bun run release:sign`;
} else if (process.env.SIMVIEW_REQUIRE_SIGNING === "1") {
  throw new Error("SIMVIEW_REQUIRE_SIGNING=1 but SIMVIEW_SIGNING_IDENTITY was not provided");
} else {
  console.warn("Building unsigned release artifacts; set SIMVIEW_SIGNING_IDENTITY to sign them.");
}

await $`bun run package:plugin`;
await $`bun run package:mcpb`;
await $`bun run package:npm`;

await Promise.all([
  cp(join(root, "artifacts/simview-plugin.zip"), join(artifacts, "simview-plugin.zip")),
  cp(join(root, "artifacts/simview.mcpb"), join(artifacts, "simview.mcpb")),
]);

const archiveStage = join(archiveRoot, `simview-${version}`);
await mkdir(join(archiveStage, "bin"), { recursive: true });
await Promise.all([
  cp(cliBinary, join(archiveStage, "bin/simview")),
  cp(packagedCore, join(archiveStage, "bin/simview-core")),
  cp(packagedProbe, join(archiveStage, "bin/libSimViewProbe.dylib")),
  cp(join(root, "README.md"), join(archiveStage, "README.md")),
  cp(join(root, "LICENSE"), join(archiveStage, "LICENSE")),
  cp(join(root, "THIRD_PARTY_NOTICES.md"), join(archiveStage, "THIRD_PARTY_NOTICES.md")),
]);
await $`ditto -c -k --norsrc --keepParent ${archiveStage} ${join(artifacts, `simview-${version}-macos.zip`)}`;

await $`bun ${join(root, "scripts/generate-sbom.ts")} ${join(artifacts, "sbom.cdx.json")}`;

const files = [...new Bun.Glob("*").scanSync({ cwd: artifacts })]
  .filter((name) => name !== "SHA256SUMS" && name !== "release-manifest.json")
  .sort();
const releaseFiles = await Promise.all(
  files.map(async (name) => ({
    name,
    bytes: (await stat(join(artifacts, name))).size,
    sha256: new Bun.CryptoHasher("sha256")
      .update(await Bun.file(join(artifacts, name)).arrayBuffer())
      .digest("hex"),
  })),
);
await writeFile(
  join(artifacts, "release-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      name: "simview",
      version,
      sourceRevision: process.env.GITHUB_SHA ?? null,
      architectures: ["arm64", "x86_64"],
      signed: Boolean(process.env.SIMVIEW_SIGNING_IDENTITY),
      files: releaseFiles,
    },
    null,
    2,
  )}\n`,
);

const checksumFiles = [...files, "release-manifest.json"];
const sums = (
  await Promise.all(
    checksumFiles.map(async (name) => {
      const hash = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(join(artifacts, name)).arrayBuffer())
        .digest("hex");
      return `${hash}  ${name}`;
    }),
  )
).join("\n");
await writeFile(join(artifacts, "SHA256SUMS"), `${sums}\n`);
console.log(artifacts);
