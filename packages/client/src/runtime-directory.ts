import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

let directory: string | undefined;

/** macOS hosts may omit or replace TMPDIR. Registries must still rendezvous per user. */
export function userTemporaryDirectory(): string {
  if (directory) return directory;
  if (process.platform !== "darwin") return tmpdir();
  const value = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
    timeout: 1_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!isAbsolute(value)) throw new Error("Unable to resolve the user's runtime directory");
  directory = value;
  return value;
}
