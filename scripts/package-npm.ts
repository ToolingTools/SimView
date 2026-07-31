import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createNpmPackageManifest } from "./release-config";

const root = resolve(import.meta.dir, "..");
const release = join(root, "artifacts", "release");
const stage = join(root, "artifacts", "npm", "toolingtools-simview");
const npmCache = join(root, ".simview", "npm-cache");
const rootManifest = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
};
const packageName = process.env.SIMVIEW_NPM_PACKAGE_NAME ?? "@toolingtools/simview";

await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "bin"), { recursive: true });
await mkdir(join(stage, "app"), { recursive: true });
await mkdir(release, { recursive: true });
await mkdir(npmCache, { recursive: true });

await Promise.all([
  cp(join(root, ".codex-plugin"), join(stage, ".codex-plugin"), { recursive: true }),
  cp(join(root, ".claude-plugin"), join(stage, ".claude-plugin"), { recursive: true }),
  cp(join(root, "skills"), join(stage, "skills"), { recursive: true }),
  cp(join(root, "assets"), join(stage, "assets"), { recursive: true }),
  cp(join(root, "packages/app/dist"), join(stage, "app/dist"), { recursive: true }),
  cp(join(root, ".mcp.json"), join(stage, ".mcp.json")),
  cp(join(root, "README.md"), join(stage, "README.md")),
  cp(join(root, "LICENSE"), join(stage, "LICENSE")),
  cp(join(root, "THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md")),
  cp(join(root, "packages/cli/dist/simview"), join(stage, "bin/simview")),
  cp(join(root, "packages/core/bin/simview-core"), join(stage, "bin/simview-core")),
  cp(
    join(root, "packages/core/bin/libSimViewProbe.dylib"),
    join(stage, "bin/libSimViewProbe.dylib"),
  ),
]);
await Promise.all([
  chmod(join(stage, "bin/simview"), 0o755),
  chmod(join(stage, "bin/simview-core"), 0o755),
]);
await rm(join(stage, "assets", ".DS_Store"), { force: true });

await writeFile(
  join(stage, "package.json"),
  `${JSON.stringify(createNpmPackageManifest(rootManifest.version, packageName), null, 2)}\n`,
);

const pack = Bun.spawn(
  ["npm", "pack", "--json", "--pack-destination", release, "--cache", npmCache, stage],
  {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "inherit",
  },
);
const stdout = await new Response(pack.stdout).text();
const status = await pack.exited;
if (status !== 0) process.exit(status);

const result = JSON.parse(stdout) as Array<{ filename: string }>;
const filename = result[0]?.filename;
if (!filename) throw new Error("npm pack did not report an output filename");
console.log(join(release, filename));
