import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const packagePath = join(root, "native/SimViewCore");
await $`swift build --package-path ${packagePath} -c release --arch arm64`;
const binPath = (
  await $`swift build --package-path ${packagePath} -c release --arch arm64 --show-bin-path`.text()
).trim();
const destination = join(root, "packages/core/bin");
await mkdir(destination, { recursive: true });
await cp(join(binPath, "simview-core"), join(destination, "simview-core"));
