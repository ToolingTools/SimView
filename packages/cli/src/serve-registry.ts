import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  assertPrivatePath,
  processSnapshot,
  readHandshake,
  userTemporaryDirectory,
} from "@simview/client";
import {
  previewServerConnectionSchema,
  previewServerNameSchema,
  previewServerOptionsSchema,
  previewServerStatusSchema,
} from "@simview/contracts";
import { z } from "zod";

export const previewRecordSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  build: z.string().regex(/^[a-f0-9]{20}$/),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  options: previewServerOptionsSchema,
});
export type PreviewRecord = z.output<typeof previewRecordSchema>;

export function previewPaths(name: string) {
  previewServerNameSchema.parse(name);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Preview servers require a numeric user ID");
  const parent = join(userTemporaryDirectory(), "sv-preview");
  const root = join(parent, String(uid));
  const identity = createHash("sha256").update(name).digest("hex").slice(0, 20);
  return {
    parent,
    root,
    identity,
    record: join(root, `${identity}.json`),
    socket: join(root, `${identity}.sock`),
    lock: join(root, `${identity}.lock`),
  };
}
export async function ensurePreviewRegistry(name: string): Promise<void> {
  const paths = previewPaths(name);
  for (const path of [paths.parent, paths.root]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertPrivatePath(path, "directory");
  }
}
export async function readPreviewRecord(name: string): Promise<PreviewRecord | undefined> {
  const paths = previewPaths(name);
  try {
    await assertPrivatePath(paths.parent, "directory");
    await assertPrivatePath(paths.root, "directory");
    await assertPrivatePath(paths.record, "file");
    const record = previewRecordSchema.safeParse(JSON.parse(await readFile(paths.record, "utf8")));
    if (!record.success || record.data.options.name !== name)
      throw new Error("Invalid preview server record");
    return record.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("Invalid preview server record");
    throw error;
  }
}
export async function previewRecordAlive(record: PreviewRecord): Promise<boolean> {
  return (await processSnapshot([record.pid])).get(record.pid)?.startedAt === record.startedAt;
}
export async function publishPreviewRecord(record: PreviewRecord): Promise<void> {
  const paths = previewPaths(record.options.name);
  const temporary = `${paths.record}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  try {
    await link(temporary, paths.record);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function removePreviewRecord(record: PreviewRecord): Promise<void> {
  const current = await readPreviewRecord(record.options.name);
  if (current?.pid !== record.pid || current.token !== record.token) return;
  const paths = previewPaths(record.options.name);
  for (const path of [paths.socket, paths.record])
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
}

/** Authentication, not a saved PID, authorizes server shutdown. */
export async function requestPreviewServer(
  record: PreviewRecord,
  action: "status" | "connect" | "stop",
) {
  const paths = previewPaths(record.options.name);
  await assertPrivatePath(paths.socket, "socket");
  const socket = createConnection({ path: paths.socket });
  const response = readHandshake(socket);
  socket.write(`${JSON.stringify({ action, token: record.token })}\n`);
  try {
    const result =
      action === "connect"
        ? previewServerConnectionSchema.parse(await response)
        : previewServerStatusSchema.parse(await response);
    if (result.name !== record.options.name || (result.active && result.pid !== record.pid))
      throw new Error("Preview server identity mismatch");
    return result;
  } catch {
    throw new Error("Unable to authenticate to the preview server");
  } finally {
    socket.destroy();
  }
}
