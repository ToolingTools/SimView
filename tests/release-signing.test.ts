import { expect, test } from "bun:test";
import {
  cliEntitlementsPath,
  codesignArguments,
  type ReleaseBinary,
} from "../scripts/release-signing";

const cli: ReleaseBinary = { path: "/tmp/simview", identifier: "com.simview.cli" };
const core: ReleaseBinary = { path: "/tmp/simview-core", identifier: "com.simview.core" };
const probe: ReleaseBinary = {
  path: "/tmp/libSimViewProbe.dylib",
  identifier: "com.simview.probe",
};

test("uses hardened runtime and JIT entitlement only for the CLI", () => {
  const binaries = [cli, core, probe];
  const adhoc = binaries.map((binary) => codesignArguments(binary, "adhoc", "-"));
  const developerId = binaries.map((binary) =>
    codesignArguments(binary, "developer-id", "Developer ID Application"),
  );

  for (const args of [...adhoc, ...developerId]) {
    expect(args).toContain("--options");
    expect(args[args.indexOf("--options") + 1]).toBe("runtime");
  }

  expect(adhoc[0]).toContain("--entitlements");
  expect(adhoc[0]).toContain(cliEntitlementsPath);
  expect(developerId[0]).toContain("--entitlements");
  expect(developerId[0]).toContain(cliEntitlementsPath);
  expect(adhoc[0]).not.toContain("--timestamp");
  expect(developerId[0]).toContain("--timestamp");

  for (const args of [...adhoc.slice(1), ...developerId.slice(1)]) {
    expect(args).not.toContain("--entitlements");
  }
});

test("the CLI entitlement plist grants only JIT", async () => {
  const result = Bun.spawnSync([
    "/usr/bin/plutil",
    "-convert",
    "json",
    "-o",
    "-",
    cliEntitlementsPath,
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    "com.apple.security.cs.allow-jit": true,
  });
});
