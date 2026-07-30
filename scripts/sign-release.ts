import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const identity = process.env.SIMVIEW_SIGNING_IDENTITY;
if (!identity) {
  throw new Error("SIMVIEW_SIGNING_IDENTITY is required to sign release binaries");
}

const binaries = [
  {
    path: join(root, "packages/cli/dist/simview"),
    identifier: "com.simview.cli",
  },
  {
    path: join(root, "packages/core/bin/simview-core"),
    identifier: "com.simview.core",
  },
  {
    path: join(root, "packages/core/bin/libSimViewProbe.dylib"),
    identifier: "com.simview.probe",
  },
];

for (const binary of binaries) {
  await access(binary.path);
  await $`/usr/bin/codesign --force --sign ${identity} --identifier ${binary.identifier} --options runtime --timestamp ${binary.path}`;
  await $`/usr/bin/codesign --verify --strict --verbose=2 ${binary.path}`;
}
