#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "native", "SimViewProbe", "SimViewProbe.m");
const outputDir = join(root, "native", "SimViewProbe", "build");
const output = join(outputDir, "libSimViewProbe.dylib");
await mkdir(outputDir, { recursive: true });

const sdk = (await Bun.$`xcrun --sdk iphonesimulator --show-sdk-path`.text()).trim();
const deployment = "14.0";
const command = [
  "/usr/bin/xcrun",
  "clang",
  "-fobjc-arc",
  "-dynamiclib",
  "-arch",
  "arm64",
  "-arch",
  "x86_64",
  "-isysroot",
  sdk,
  `-mios-simulator-version-min=${deployment}`,
  "-framework",
  "Foundation",
  "-framework",
  "CoreGraphics",
  "-framework",
  "UIKit",
  "-install_name",
  "@rpath/libSimViewProbe.dylib",
  source,
  "-o",
  output,
];
const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
const status = await child.exited;
if (status !== 0) process.exit(status);
console.log(output);
