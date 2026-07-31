import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const requiredAcknowledgements = [
  "SIMVIEW_BINARY_LICENSE_REVIEWED",
  "SIMVIEW_SIGNING_READY",
  "SIMVIEW_COMPATIBILITY_VERIFIED",
] as const;

const missing = requiredAcknowledgements.filter((name) => process.env[name] !== "1");
if (missing.length > 0) {
  throw new Error(
    "Binary publishing is disabled until the release operator sets these reviewed gates: " +
      missing.join(", "),
  );
}

await Promise.all([
  access(resolve(root, "LICENSE")),
  access(resolve(root, "THIRD_PARTY_NOTICES.md")),
  access(resolve(root, "docs/binary-redistribution.md")),
]);

const distribution = await readFile(resolve(root, "docs/binary-redistribution.md"), "utf8");
if (!distribution.includes("Release operator checklist")) {
  throw new Error("docs/binary-redistribution.md is missing its release operator checklist");
}

console.log("Binary release acknowledgements are present");
