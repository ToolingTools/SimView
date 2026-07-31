import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
  packageManager?: string;
};
const expected = manifest.packageManager?.match(/^bun@(.+)$/)?.[1];

if (!expected) {
  throw new Error("package.json must declare packageManager as bun@<version>");
}

if (Bun.version !== expected) {
  throw new Error(
    `SimView requires Bun ${expected}; found ${Bun.version}. Install the declared version before continuing.`,
  );
}

console.log(`Bun ${Bun.version}`);
