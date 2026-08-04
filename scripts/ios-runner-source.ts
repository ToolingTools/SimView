import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const forbiddenDependency =
  /(?:^|[^a-z0-9])(webdriveragent|appium|quicktime_video_hack|qvh|go-ios|libimobiledevice|libusb)(?:[^a-z0-9]|$)/i;

export async function copyIOSRunnerSources(root: string, destination: string): Promise<void> {
  const source = join(root, "native", "SimViewIOSDeviceRunner");
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(join(source, "Sources"), join(destination, "Sources"), { recursive: true }),
    cp(join(source, "Tests"), join(destination, "Tests"), { recursive: true }),
    cp(
      join(source, "SimViewIOSDeviceRunner.xcodeproj"),
      join(destination, "SimViewIOSDeviceRunner.xcodeproj"),
      { recursive: true },
    ),
  ]);
  await assertOwnedIOSRunnerTree(destination);
}

export async function iosRunnerSourceFiles(root: string): Promise<string[]> {
  return await sourceFiles(join(root, "native", "SimViewIOSDeviceRunner"), [
    "Sources",
    "Tests",
    "SimViewIOSDeviceRunner.xcodeproj",
  ]);
}

export async function hashIOSRunnerSources(root: string): Promise<string> {
  const directory = join(root, "native", "SimViewIOSDeviceRunner");
  const files = await iosRunnerSourceFiles(root);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of files) {
    hasher.update(relative(directory, path));
    hasher.update(new Uint8Array([0]));
    hasher.update(await readFile(path));
  }
  return hasher.digest("hex");
}

export async function assertOwnedIOSRunnerTree(directory: string): Promise<void> {
  const files = await sourceFiles(directory, [
    "Sources",
    "Tests",
    "SimViewIOSDeviceRunner.xcodeproj",
  ]);
  if (files.length === 0) throw new Error("The packaged iOS runner source tree is empty");
  const normalizedRoot = resolve(directory) + sep;
  for (const path of files) {
    const name = relative(normalizedRoot, resolve(path));
    if (name.startsWith("..") || forbiddenDependency.test(name)) {
      throw new Error(`The packaged iOS runner contains a forbidden path: ${name}`);
    }
    const contents = await readFile(path);
    if (forbiddenDependency.test(contents.toString("utf8"))) {
      throw new Error(`The packaged iOS runner contains a forbidden dependency reference: ${name}`);
    }
  }
  const project = await readFile(
    join(directory, "SimViewIOSDeviceRunner.xcodeproj", "project.pbxproj"),
    "utf8",
  );
  if (
    /XCRemoteSwiftPackageReference|Pods\.|\.framework\/(?!UIKit|XCTest|VideoToolbox)/.test(project)
  ) {
    throw new Error("The packaged iOS runner project contains an external dependency reference");
  }
}

async function sourceFiles(directory: string, roots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    await walk(join(directory, root), files);
  }
  return files.sort();
}

async function walk(path: string, files: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`The iOS runner source tree may not contain symlinks: ${child}`);
    }
    if (entry.isDirectory()) {
      if (["build", "DerivedData", "xcuserdata"].includes(basename(child))) continue;
      await walk(child, files);
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
}
