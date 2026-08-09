import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { $ } from "bun";
import { decodeXCTestProbeLog } from "./xctest-probe-result";

interface Options {
  udid: string;
  bundleId: string;
  output: string;
  captures: number;
}

function usage(): never {
  throw new Error(
    "Usage: bun scripts/probe-xctest-accessibility.ts --udid <udid> --bundle-id <id> --output <path> [--captures <1-10>]",
  );
}

function parseOptions(arguments_: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    values.set(key, value);
  }
  const udid = values.get("--udid");
  const bundleId = values.get("--bundle-id");
  const output = values.get("--output");
  const captures = Number.parseInt(values.get("--captures") ?? "2", 10);
  if (!udid || !bundleId || !output) usage();
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) {
    throw new Error(`Invalid bundle identifier: ${bundleId}`);
  }
  if (!Number.isInteger(captures) || captures < 1 || captures > 10) {
    throw new Error("--captures must be an integer between 1 and 10");
  }
  return { udid, bundleId, output: resolve(output), captures };
}

const options = parseOptions(process.argv.slice(2));
const root = resolve(import.meta.dir, "..");
const sourceProject = join(root, "native/SimViewXCTestProvider");
const temporaryRoot = await mkdtemp(join(tmpdir(), "simview-xctest-probe-"));
const temporaryProject = join(temporaryRoot, basename(sourceProject));

try {
  await cp(sourceProject, temporaryProject, { recursive: true });
  await $`xcodegen generate --spec ${join(temporaryProject, "project.yml")} --project ${temporaryProject} --quiet`;
  const scheme = join(
    temporaryProject,
    "SimViewXCTestProvider.xcodeproj/xcshareddata/xcschemes/SimViewXCTestProbe.xcscheme",
  );
  const source = await readFile(scheme, "utf8");
  await writeFile(
    scheme,
    source
      .replace("__SIMVIEW_TARGET_BUNDLE_ID__", options.bundleId)
      .replace("__SIMVIEW_CAPTURE_COUNT__", String(options.captures)),
  );

  const result =
    await $`xcodebuild test -project ${join(temporaryProject, "SimViewXCTestProvider.xcodeproj")} -scheme SimViewXCTestProbe -destination ${`platform=iOS Simulator,id=${options.udid}`} -derivedDataPath ${join(temporaryRoot, "DerivedData")} CODE_SIGNING_ALLOWED=NO`
      .nothrow()
      .quiet();
  const log = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  if (result.exitCode !== 0) {
    process.stderr.write(log);
    throw new Error(`XCTest accessibility probe failed with exit code ${result.exitCode}`);
  }

  const snapshot = decodeXCTestProbeLog(log);
  await writeFile(options.output, `${JSON.stringify(snapshot)}\n`);
  process.stdout.write(`${options.output}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
