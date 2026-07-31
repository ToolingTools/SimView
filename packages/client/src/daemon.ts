import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { type Codec, PROTOCOL_VERSION, SIMVIEW_VERSION } from "@simview/contracts";
import { resolveBinary } from "@simview/core";
import { z } from "zod";
import type { AcquireOptions, SimViewClient } from "./client";

const RECORD_SCHEMA_VERSION = 1;
const STARTUP_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 15_000;

export const daemonRecordSchema = z.object({
  schemaVersion: z.literal(RECORD_SCHEMA_VERSION),
  pid: z.number().int().positive(),
  udid: z.string().min(1),
  socketPath: z.string().min(1),
  token: z.string().length(64),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  simviewVersion: z.literal(SIMVIEW_VERSION),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  instanceId: z.string().regex(/^[a-f0-9]{20}$/),
  startedAt: z.string().datetime(),
});

export type DaemonRecord = z.output<typeof daemonRecordSchema>;

export const daemonStatusSchema = z.object({
  instanceId: z.string(),
  pid: z.number().int().positive(),
  udid: z.string(),
  protocolVersion: z.number().int().positive(),
  simviewVersion: z.string(),
  binarySha256: z.string(),
  startedAt: z.string(),
  health: z.record(z.string(), z.unknown()),
});

export type DaemonStatus = z.output<typeof daemonStatusSchema>;

export interface DaemonRegistryAdapter {
  attach(socketPath: string, token: string, codec?: Codec): Promise<SimViewClient>;
}

function registryRoot(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Shared SimView backends require a numeric user ID");
  return join(tmpdir(), "simview-daemons", String(uid));
}

function registryBase(): string {
  return join(tmpdir(), "simview-daemons");
}

async function binarySha256(binary: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
}

function instanceIdFor(udid: string, binaryHash: string): string {
  return createHash("sha256")
    .update(`${udid}\0${PROTOCOL_VERSION}\0${SIMVIEW_VERSION}\0${binaryHash}`)
    .digest("hex")
    .slice(0, 20);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  const uid = process.getuid?.();
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Unsafe SimView daemon directory: ${path}`);
  }
  if (uid !== undefined && details.uid !== uid) {
    throw new Error(`SimView daemon directory is not owned by the current user: ${path}`);
  }
  if ((details.mode & 0o777) !== 0o700) {
    throw new Error(`SimView daemon directory has unsafe permissions: ${path}`);
  }
}

async function assertPrivateFile(path: string, expectedMode: number): Promise<void> {
  const details = await lstat(path);
  const uid = process.getuid?.();
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Unsafe daemon file: ${path}`);
  if (uid !== undefined && details.uid !== uid)
    throw new Error(`Daemon file has an unexpected owner: ${path}`);
  if ((details.mode & 0o777) !== expectedMode) {
    throw new Error(`Daemon file has unsafe permissions: ${path}`);
  }
}

async function assertPrivateSocket(path: string): Promise<void> {
  const details = await lstat(path);
  const uid = process.getuid?.();
  if (!details.isSocket() || details.isSymbolicLink())
    throw new Error(`Unsafe daemon socket: ${path}`);
  if (uid !== undefined && details.uid !== uid)
    throw new Error(`Daemon socket has an unexpected owner: ${path}`);
  if ((details.mode & 0o777) !== 0o600)
    throw new Error(`Daemon socket has unsafe permissions: ${path}`);
}

async function readRecord(instanceDirectory: string): Promise<DaemonRecord | undefined> {
  const recordPath = join(instanceDirectory, "record.json");
  try {
    await assertPrivateFile(recordPath, 0o600);
    const record = daemonRecordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")));
    const expectedSocket = join(instanceDirectory, "core.sock");
    if (resolve(record.socketPath) !== resolve(expectedSocket)) {
      throw new Error("Daemon record socket path escapes its instance directory");
    }
    if (record.instanceId !== basename(instanceDirectory)) {
      throw new Error("Daemon record instance ID does not match its directory");
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeDeadInstance(
  instanceDirectory: string,
  record: DaemonRecord,
): Promise<boolean> {
  if (isAlive(record.pid)) return false;
  await rm(instanceDirectory, { recursive: true, force: true });
  return true;
}

async function publishRecord(instanceDirectory: string, record: DaemonRecord): Promise<void> {
  const temporary = join(
    instanceDirectory,
    `record.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, join(instanceDirectory, "record.json"));
}

async function acquireLock(instanceDirectory: string): Promise<() => Promise<void>> {
  const lockPath = join(instanceDirectory, "startup.lock");
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
      await handle.close();
      return async () => unlink(lockPath).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const details = await lstat(lockPath).catch(() => undefined);
      if (details?.isSymbolicLink()) throw new Error(`Unsafe SimView startup lock: ${lockPath}`);
      if (details && Date.now() - details.mtimeMs > LOCK_STALE_MS) {
        const contents = await readFile(lockPath, "utf8").catch(() => "");
        const ownerPID = Number(contents.split("\n", 1)[0]);
        if (Number.isSafeInteger(ownerPID) && ownerPID > 0 && !isAlive(ownerPID)) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      }
      await Bun.sleep(25);
    }
  }
  throw new Error(
    "Timed out waiting for another SimView backend starter; run `simview daemon status`",
  );
}

async function validatedRecord(
  instanceDirectory: string,
  expected: { udid: string; binarySha256: string; instanceId: string },
): Promise<DaemonRecord | undefined> {
  const record = await readRecord(instanceDirectory);
  if (!record) return undefined;
  if (!isAlive(record.pid)) {
    await removeDeadInstance(instanceDirectory, record);
    return undefined;
  }
  if (
    record.udid !== expected.udid ||
    record.binarySha256 !== expected.binarySha256 ||
    record.instanceId !== expected.instanceId
  ) {
    throw new Error(
      "A live SimView backend has incompatible trusted metadata; run `simview daemon status`",
    );
  }
  await assertPrivateSocket(record.socketPath);
  return record;
}

async function attachAndVerify(
  adapter: DaemonRegistryAdapter,
  record: DaemonRecord,
  codec: Codec,
): Promise<SimViewClient> {
  const client = await adapter.attach(record.socketPath, record.token, codec);
  try {
    const health = await client.request("health.get", {}, { timeoutMs: 2_000 });
    assertHealthIdentity(health, record);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function assertHealthIdentity(
  health: { status: string; pid: number; instanceId: string | null; configuredUdid: string | null },
  expected: { pid: number; instanceId: string; udid: string },
): void {
  if (
    health.status !== "ok" ||
    health.pid !== expected.pid ||
    health.instanceId !== expected.instanceId ||
    health.configuredUdid !== expected.udid
  ) {
    throw new Error("Shared SimView backend identity does not match its protected record");
  }
}

async function terminateStartedChild(child: Bun.Subprocess, socketPath: string): Promise<void> {
  if (child.exitCode === null) child.kill();
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill(9);
    await child.exited;
  }
  await unlink(socketPath).catch(() => {});
}

export async function acquireDaemon(
  options: AcquireOptions,
  adapter: DaemonRegistryAdapter,
): Promise<SimViewClient> {
  const binary = resolve(options.binary ?? resolveBinary());
  const hash = await binarySha256(binary);
  const instanceId = instanceIdFor(options.udid, hash);
  const root = registryRoot();
  const instanceDirectory = join(root, instanceId);
  await ensurePrivateDirectory(registryBase());
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(instanceDirectory);
  const expected = { udid: options.udid, binarySha256: hash, instanceId };
  const existing = await validatedRecord(instanceDirectory, expected);
  if (existing) return attachAndVerify(adapter, existing, options.codec ?? "h264");
  await ensurePrivateDirectory(instanceDirectory);

  const releaseLock = await acquireLock(instanceDirectory);
  try {
    const raced = await validatedRecord(instanceDirectory, expected);
    if (raced) return attachAndVerify(adapter, raced, options.codec ?? "h264");

    const socketPath = join(instanceDirectory, "core.sock");
    if (await lstat(socketPath).catch(() => undefined)) {
      throw new Error(
        "A SimView daemon socket exists without trusted live metadata; wait for startup or remove it after confirming no backend is running",
      );
    }
    const token = randomBytes(32).toString("hex");
    const child = Bun.spawn(
      [
        binary,
        "serve",
        "--socket",
        socketPath,
        "--token-fd",
        "0",
        "--idle-timeout",
        "300",
        "--udid",
        options.udid,
        "--instance-id",
        instanceId,
      ],
      {
        stdin: new TextEncoder().encode(token),
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      },
    );
    child.unref();
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let client: SimViewClient | undefined;
    let lastError: unknown;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        await assertPrivateSocket(socketPath);
        client = await adapter.attach(socketPath, token, options.codec ?? "h264");
        const health = await client.request("health.get", {}, { timeoutMs: 2_000 });
        assertHealthIdentity(health, { pid: child.pid, instanceId, udid: options.udid });
        break;
      } catch (error) {
        lastError = error;
        await client?.close().catch(() => {});
        client = undefined;
        await Bun.sleep(25);
      }
    }
    if (!client) {
      await terminateStartedChild(child, socketPath);
      throw new Error("Unable to start the shared SimView backend", { cause: lastError });
    }
    const record: DaemonRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      pid: child.pid,
      udid: options.udid,
      socketPath,
      token,
      protocolVersion: PROTOCOL_VERSION,
      simviewVersion: SIMVIEW_VERSION,
      binarySha256: hash,
      instanceId,
      startedAt: new Date().toISOString(),
    };
    try {
      await publishRecord(instanceDirectory, record);
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      await terminateStartedChild(child, socketPath);
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

async function instanceDirectories(): Promise<string[]> {
  const root = registryRoot();
  const rootDetails = await lstat(root).catch(() => undefined);
  if (!rootDetails) return [];
  await ensurePrivateDirectory(registryBase());
  await ensurePrivateDirectory(root);
  const names = await readdir(root);
  return names.filter((name) => /^[a-f0-9]{20}$/.test(name)).map((name) => join(root, name));
}

export async function daemonStatuses(adapter: DaemonRegistryAdapter): Promise<DaemonStatus[]> {
  const statuses: DaemonStatus[] = [];
  for (const directory of await instanceDirectories()) {
    const record = await readRecord(directory);
    if (!record || !isAlive(record.pid)) continue;
    await assertPrivateSocket(record.socketPath);
    const client = await adapter.attach(record.socketPath, record.token);
    try {
      const health = await client.request("health.get", {}, { timeoutMs: 2_000 });
      assertHealthIdentity(health, record);
      statuses.push(
        daemonStatusSchema.parse({
          instanceId: record.instanceId,
          pid: record.pid,
          udid: record.udid,
          protocolVersion: record.protocolVersion,
          simviewVersion: record.simviewVersion,
          binarySha256: record.binarySha256,
          startedAt: record.startedAt,
          health,
        }),
      );
    } finally {
      await client.close();
    }
  }
  return statuses;
}

export async function stopDaemons(
  adapter: DaemonRegistryAdapter,
  target: { udid?: string | undefined; all?: boolean | undefined },
): Promise<number> {
  let stopped = 0;
  for (const directory of await instanceDirectories()) {
    const record = await readRecord(directory);
    if (!record || !isAlive(record.pid)) continue;
    if (!target.all && record.udid !== target.udid) continue;
    await assertPrivateSocket(record.socketPath);
    const client = await adapter.attach(record.socketPath, record.token);
    try {
      assertHealthIdentity(await client.request("health.get", {}, { timeoutMs: 2_000 }), record);
      await client.request("server.shutdown", {}, { timeoutMs: 2_000 });
      stopped += 1;
    } finally {
      await client.close();
    }
  }
  return stopped;
}

export async function pruneDaemons(udid?: string): Promise<number> {
  let pruned = 0;
  for (const directory of await instanceDirectories()) {
    const record = await readRecord(directory);
    if (udid && record?.udid !== udid) continue;
    if (record && (await removeDeadInstance(directory, record))) pruned += 1;
  }
  return pruned;
}

export function isPathInside(parent: string, child: string): boolean {
  const prefix = resolve(parent) + sep;
  return resolve(child).startsWith(prefix);
}
