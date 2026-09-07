import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const stage = join(root, "artifacts", "mcpb");
const output = join(root, "artifacts", "simview.mcpb");
await rm(stage, { recursive: true, force: true });
await rm(output, { force: true });
await mkdir(stage, { recursive: true });
await $`cp ${join(root, "manifest.json")} ${stage}`;
await mkdir(join(stage, "assets"), { recursive: true });
await $`cp ${join(root, "assets/icon-512.png")} ${join(stage, "assets/icon.png")}`;
await $`cp -R ${join(root, "artifacts/plugin/simview/bin")} ${stage}`;
await $`cp -R ${join(root, "artifacts/plugin/simview/app")} ${stage}`;
await $`bunx mcpb pack ${stage} ${output}`;
