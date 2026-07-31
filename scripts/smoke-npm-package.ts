import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const rootManifest = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
};
const tarball = resolve(
  process.argv[2] ?? join(root, "artifacts", "release", `simview-${rootManifest.version}.tgz`),
);
const npmCache = join(root, ".simview", "npm-smoke-cache");
const bunCache = join(root, ".simview", "bun-smoke-cache");

await access(tarball);
await Promise.all([mkdir(npmCache, { recursive: true }), mkdir(bunCache, { recursive: true })]);

const commands = [
  [
    "npm",
    "exec",
    "--yes",
    `--cache=${npmCache}`,
    `--package=${tarball}`,
    "--",
    "simview",
    "doctor",
    "--json",
  ],
  ["bunx", "--package", tarball, "simview", "doctor", "--json"],
];

for (const command of commands) {
  const child = Bun.spawn(command, {
    cwd: root,
    env: {
      ...globalThis.process.env,
      BUN_INSTALL_CACHE_DIR: bunCache,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) {
    throw new Error(`${command[0]} package smoke test failed with exit code ${status}`);
  }
}
