import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ANDROID_AGENT_PROTOCOL_VERSION,
  validateAndroidAgentProtocol,
} from "./android-agent-config";

const root = resolve(import.meta.dir, "..");
const sourceRoot = join(root, "native", "SimViewAndroid", "src");
const buildRoot = join(root, "native", "SimViewAndroid", "build");
const classesRoot = join(buildRoot, "classes");
const dexRoot = join(buildRoot, "dex");
const classesJar = join(buildRoot, "simview-android-agent-classes.jar");
const output = join(buildRoot, "simview-android-agent.jar");
const manifest = join(buildRoot, "MANIFEST.MF");
const packaged = join(root, "packages", "core", "bin", "simview-android-agent.jar");
const packageManifest = (await Bun.file(join(root, "package.json")).json()) as {
  version: string;
};
await validateAndroidAgentProtocol(root);

const sdkRoot = await resolveAndroidSdk();
const androidJar = join(sdkRoot, "platforms", "android-35", "android.jar");
const d8 = join(sdkRoot, "build-tools", "35.0.0", "d8");
const javaHome = await resolveJava17();
const javac = join(javaHome, "bin", "javac");
const jar = join(javaHome, "bin", "jar");
const sources = [...new Bun.Glob("**/*.java").scanSync({ cwd: sourceRoot, absolute: true })].sort();

if (!sources.length) throw new Error(`No Android agent Java sources found under ${sourceRoot}`);
for (const required of [androidJar, d8, javac, jar]) {
  if (!(await Bun.file(required).exists()))
    throw new Error(`Android agent tool is missing: ${required}`);
}

await rm(buildRoot, { recursive: true, force: true });
await mkdir(classesRoot, { recursive: true });
await mkdir(dexRoot, { recursive: true });
await run([
  javac,
  "-encoding",
  "UTF-8",
  "-source",
  "8",
  "-target",
  "8",
  "-classpath",
  androidJar,
  "-d",
  classesRoot,
  ...sources,
]);
const archiveDate = "2000-01-01T00:00:00Z";
await run([jar, "--create", "--file", classesJar, `--date=${archiveDate}`, "-C", classesRoot, "."]);
await run([d8, "--min-api", "26", "--output", dexRoot, classesJar]);
await writeFile(
  manifest,
  [
    "Manifest-Version: 1.0",
    "Implementation-Title: SimView Android Agent",
    `Implementation-Version: ${packageManifest.version}`,
    `SimView-Agent-Protocol: ${ANDROID_AGENT_PROTOCOL_VERSION}`,
    "",
  ].join("\n"),
);
await run([
  jar,
  "--create",
  "--file",
  output,
  "--manifest",
  manifest,
  `--date=${archiveDate}`,
  "-C",
  dexRoot,
  "classes.dex",
]);
await mkdir(join(root, "packages", "core", "bin"), { recursive: true });
await cp(output, packaged);
console.log(packaged);

async function resolveAndroidSdk(): Promise<string> {
  const candidates = [
    process.env.SIMVIEW_ANDROID_SDK_ROOT,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    join(homedir(), "Library", "Android", "sdk"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const entries = await readdir(join(candidate, "platforms"));
      if (entries.includes("android-35")) return candidate;
    } catch {
      // Try the next deterministic SDK location.
    }
  }
  throw new Error(
    "Android SDK platform 35 was not found. Set SIMVIEW_ANDROID_SDK_ROOT, ANDROID_SDK_ROOT, or ANDROID_HOME.",
  );
}

async function resolveJava17(): Promise<string> {
  if (process.env.JAVA_HOME) {
    const version = await commandOutput([join(process.env.JAVA_HOME, "bin", "javac"), "-version"]);
    if (/\b17(?:\.|\s)/.test(version)) return process.env.JAVA_HOME;
  }
  const javaHome = (await commandOutput(["/usr/libexec/java_home", "-v", "17"])).trim();
  if (!javaHome) throw new Error("JDK 17 is required to build the Android agent");
  return javaHome;
}

async function commandOutput(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(stderr.trim() || `${command[0]} exited with ${status}`);
  return `${stdout}\n${stderr}`;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${command[0]} exited with ${status}`);
}
