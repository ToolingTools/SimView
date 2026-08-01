import { accessSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SupportedArchitecture = "arm64";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBinary(options: { architecture?: SupportedArchitecture } = {}): string {
  const architecture = options.architecture ?? process.arch;
  if (architecture !== "arm64") {
    throw new Error(`SimView supports Apple silicon only; received ${architecture}`);
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const executableRoot = dirname(process.execPath);
  const candidates = [
    process.env.SIMVIEW_CORE_BINARY,
    join(executableRoot, "simview-core"),
    join(packageRoot, "bin", `simview-core-${architecture}`),
    join(packageRoot, "bin", "simview-core"),
    resolve(packageRoot, "../../native/SimViewCore/.build/release/simview-core"),
    resolve(packageRoot, "../../native/SimViewCore/.build/debug/simview-core"),
  ].filter((path): path is string => Boolean(path));

  const binary = candidates.find(executable);
  if (!binary) {
    throw new Error(
      `SimView core binary is unavailable for ${architecture}. Checked:\n${candidates.join("\n")}`,
    );
  }
  return binary;
}
