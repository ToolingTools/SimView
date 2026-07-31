import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
}

const rootManifest = await readJson("package.json");
const version = rootManifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("package.json must contain a valid semantic version");
}

const manifests = [
  "manifest.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "packages/app/package.json",
  "packages/client/package.json",
  "packages/contracts/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/mcp/package.json",
];

const mismatches: string[] = [];
for (const path of manifests) {
  const manifest = await readJson(path);
  if (manifest.version !== version) {
    mismatches.push(`${path}: expected ${version}, found ${String(manifest.version)}`);
  }
}

const sourceVersions = [
  ["packages/contracts/src/version.ts", `SIMVIEW_VERSION = "${version}"`],
  ["native/SimViewCore/Sources/SimViewCore/Version.swift", `static let current = "${version}"`],
] as const;
for (const [path, expected] of sourceVersions) {
  const source = await readFile(resolve(root, path), "utf8");
  if (!source.includes(expected)) {
    mismatches.push(`${path}: missing ${expected}`);
  }
}

if (mismatches.length > 0) {
  throw new Error(`Version drift detected:\n${mismatches.join("\n")}`);
}

console.log(`SimView ${version}`);
