import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const rootManifest = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
};
const tarball = resolve(
  process.argv[2] ??
    join(root, "artifacts", "release", `toolingtools-simview-${rootManifest.version}.tgz`),
);
const smokeDirectory = await mkdtemp(join(tmpdir(), "simview-package-smoke-"));
const npmCache = join(smokeDirectory, "npm-cache");
const bunCache = join(smokeDirectory, "bun-cache");
const isolatedTarball = join(smokeDirectory, `toolingtools-simview-${rootManifest.version}.tgz`);

await access(tarball);
await Promise.all([
  copyFile(tarball, isolatedTarball),
  mkdir(npmCache, { recursive: true }),
  mkdir(bunCache, { recursive: true }),
]);

const commands = [
  [
    "npm",
    "exec",
    "--yes",
    `--cache=${npmCache}`,
    `--package=${isolatedTarball}`,
    "--",
    "simview",
    "doctor",
    "--json",
  ],
  ["bunx", "--package", isolatedTarball, "simview", "doctor", "--json"],
];

try {
  for (const command of commands) {
    const child = Bun.spawn(command, {
      cwd: root,
      env: {
        ...globalThis.process.env,
        BUN_INSTALL_CACHE_DIR: bunCache,
      },
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) {
      throw new Error(
        `${command[0]} package smoke test failed with exit code ${status}: ${stderr.trim()}`,
      );
    }
    const line = stdout.trim().split("\n").at(-1);
    const diagnostics = JSON.parse(line ?? "null") as {
      protocolVersion?: number;
      android?: { agent?: { packaged?: boolean } };
    } | null;
    if (diagnostics?.protocolVersion !== 3 || diagnostics.android?.agent?.packaged !== true) {
      throw new Error(
        `${command[0]} package smoke resolved stale or incomplete contents: ${stdout.trim()}`,
      );
    }
    console.log(stdout.trim());
  }
} finally {
  await rm(smokeDirectory, { recursive: true, force: true });
}
