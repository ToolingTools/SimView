import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { previewServerConnectionSchema } from "../packages/contracts/src/preview-server";

/** Exercise the installed command without a checkout, device, or plugin-root override. */
export async function smokePreviewPackage(binary: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "simview-preview-smoke-"));
  const name = `smoke-${randomUUID()}`;
  const command = async (action: "start" | "stop") => {
    const child = Bun.spawn([binary, "serve", action, "--name", name, "--json"], {
      cwd: directory,
      env: { ...process.env, SIMVIEW_PLUGIN_ROOT: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    await new Response(child.stderr).text();
    if (code !== 0) throw new Error(`Packaged preview ${action} failed`);
    return JSON.parse(stdout) as unknown;
  };
  try {
    const connection = previewServerConnectionSchema.parse(await command("start"));
    const url = new URL(connection.url);
    for (const [path, contentType] of [
      ["/", "text/html"],
      ["/preview.js", "text/javascript"],
    ]) {
      const response = await fetch(`${url.origin}${path}`);
      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.startsWith(contentType ?? "") ||
        !(await response.text()).trim()
      )
        throw new Error(`Packaged preview asset ${path} is unavailable`);
    }
    if ((await fetch(`${url.origin}/state`)).status !== 401)
      throw new Error("Packaged preview allowed unauthenticated state access");
    const state = await fetch(`${url.origin}/state`, {
      headers: { authorization: `Bearer ${url.hash.slice(7)}` },
    });
    if (!state.ok || (await state.json()).connected !== false)
      throw new Error("Packaged preview did not start idle");
  } finally {
    try {
      await command("stop");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const binary = process.argv[2];
  if (!binary) throw new Error("Usage: bun scripts/smoke-preview-package.ts <simview-binary>");
  await smokePreviewPackage(resolve(binary));
  console.log("Packaged idle preview assets and authentication passed");
}
