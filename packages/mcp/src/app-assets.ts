import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveAppRoot(
  pluginRoot = process.env.SIMVIEW_PLUGIN_ROOT,
  executablePath = process.execPath,
): string {
  if (pluginRoot) return join(pluginRoot, "app");
  const packagedRoot = resolve(executablePath, "..", "..");
  if (existsSync(join(packagedRoot, "app"))) return join(packagedRoot, "app");
  return resolve(import.meta.dir, "..", "..", "app");
}

export async function previewScriptResponse(
  pluginRoot = process.env.SIMVIEW_PLUGIN_ROOT,
  appRoot = resolveAppRoot(pluginRoot),
): Promise<Response> {
  const script = Bun.file(join(appRoot, "dist", "preview.js"));
  if (!(await script.exists())) {
    return new Response("Build the preview app first", { status: 503 });
  }
  return new Response(script, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
