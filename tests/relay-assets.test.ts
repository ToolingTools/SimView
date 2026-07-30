import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewScriptResponse, resolveAppRoot } from "../packages/mcp/src/app-assets";

describe("browser relay assets", () => {
  let fixtureRoot: string | undefined;

  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  test("serves preview.js from the packaged plugin root", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "simview-plugin-"));
    const appDist = join(fixtureRoot, "app", "dist");
    await mkdir(appDist, { recursive: true });
    await writeFile(join(appDist, "preview.js"), "document.body.dataset.simview = 'ready';");

    const response = await previewScriptResponse(fixtureRoot);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("document.body.dataset.simview = 'ready';");
  });

  test("resolves the packaged app beside a compiled executable", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "simview-plugin-"));
    await mkdir(join(fixtureRoot, "app"), { recursive: true });
    expect(resolveAppRoot(undefined, join(fixtureRoot, "bin", "simview")))
      .toBe(join(fixtureRoot, "app"));
  });
});
