import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
  packageManager?: string;
};
const expected = manifest.packageManager?.match(/^bun@(.+)$/)?.[1];

if (!expected) {
  throw new Error("package.json must declare packageManager as bun@<version>");
}

if (Bun.version !== expected) {
  throw new Error(
    `SimView requires Bun ${expected}; found ${Bun.version}. Install the declared version before continuing.`,
  );
}

console.log(`Bun ${Bun.version}`);

const sdkCandidates = [
  process.env.SIMVIEW_ANDROID_SDK_ROOT,
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  join(homedir(), "Library", "Android", "sdk"),
].filter((value): value is string => Boolean(value));
const sdkRoot = sdkCandidates.find(
  (candidate) =>
    Bun.file(join(candidate, "platforms/android-35/android.jar")).size > 0 &&
    Bun.file(join(candidate, "build-tools/35.0.0/d8")).size > 0,
);
if (!sdkRoot) {
  throw new Error(
    "SimView requires Android SDK platform 35 and build-tools 35.0.0 to build its Android agent.",
  );
}

const javaHomeProcess = Bun.spawn(["/usr/libexec/java_home", "-v", "17"], {
  stdout: "pipe",
  stderr: "pipe",
});
const [javaHome, javaStatus] = await Promise.all([
  new Response(javaHomeProcess.stdout).text(),
  javaHomeProcess.exited,
]);
if (javaStatus !== 0 || !javaHome.trim()) throw new Error("SimView requires JDK 17");

console.log(`Android SDK ${sdkRoot}`);
console.log(`JDK 17 ${javaHome.trim()}`);
