import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const project = join(root, "native/SimViewXCTestProvider/SimViewXCTestProvider.xcodeproj");
const temporaryRoot = await mkdtemp(join(tmpdir(), "simview-xctest-provider-build-"));
const derivedData = join(temporaryRoot, "DerivedData");
const products = join(derivedData, "Build/Products");
const destination = join(root, "packages/core/bin/xctest-provider");

try {
  await $`xcodebuild build-for-testing -project ${project} -scheme SimViewXCTestProbe -destination ${"generic/platform=iOS Simulator"} -derivedDataPath ${derivedData} CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES`;
  const xctestrun = (await readdir(products)).find((name) => name.endsWith(".xctestrun"));
  if (!xctestrun) throw new Error("Xcode did not produce an XCTest provider xctestrun file");

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(join(products, xctestrun), join(destination, "SimViewXCTestProvider.xctestrun")),
    cp(join(products, "Debug-iphonesimulator"), join(destination, "Debug-iphonesimulator"), {
      recursive: true,
    }),
  ]);
  const entries = await Promise.all(
    [...new Bun.Glob("**/*").scanSync({ cwd: destination })].map(async (name) => ({
      name,
      details: await stat(join(destination, name)),
    })),
  );
  const files = await Promise.all(
    entries
      .filter(({ details }) => details.isFile())
      .map(async ({ name, details }) => ({
        name,
        bytes: details.size,
        sha256: new Bun.CryptoHasher("sha256")
          .update(await Bun.file(join(destination, name)).arrayBuffer())
          .digest("hex"),
      })),
  );
  const xcodeVersion = (await $`xcodebuild -version`.quiet()).stdout.toString().trim();
  await writeFile(
    join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        protocolVersion: 1,
        provider: "core-simulator-xctest",
        architectures: ["arm64"],
        xcodeVersion,
        files: files.sort((left, right) => left.name.localeCompare(right.name)),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${destination}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
