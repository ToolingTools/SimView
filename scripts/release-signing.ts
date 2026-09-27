import { join } from "node:path";

export type ReleaseBinary = {
  path: string;
  identifier: "com.simview.cli" | "com.simview.core" | "com.simview.probe";
};

export type ReleaseSigningMode = "adhoc" | "developer-id";

export const cliEntitlementsPath = join(import.meta.dir, "cli-entitlements.plist");

export function codesignArguments(
  binary: ReleaseBinary,
  mode: ReleaseSigningMode,
  identity: string,
): string[] {
  const args = [
    "--force",
    "--sign",
    identity,
    "--identifier",
    binary.identifier,
    "--options",
    "runtime",
  ];

  if (binary.identifier === "com.simview.cli") {
    args.push("--entitlements", cliEntitlementsPath);
  }

  if (mode === "developer-id") {
    args.push("--timestamp");
  }

  args.push(binary.path);
  return args;
}
