import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
let temporaryProject = "";

beforeAll(async () => {
  temporaryProject = await mkdtemp(join(tmpdir(), "simview-xctest-project-test-"));
  await Promise.all([
    cp(
      join(root, "native/SimViewXCTestProvider/project.yml"),
      join(temporaryProject, "project.yml"),
    ),
    mkdir(join(temporaryProject, "Sources"), { recursive: true }).then(() =>
      cp(join(root, "native/SimViewXCTestProvider/Sources"), join(temporaryProject, "Sources"), {
        recursive: true,
      }),
    ),
  ]);
});

afterAll(async () => {
  if (temporaryProject) await rm(temporaryProject, { recursive: true, force: true });
});

describe("XCTest provider project generation", () => {
  test("generates every required Xcode artifact from tracked sources", async () => {
    const process = Bun.spawn(
      [
        "xcodegen",
        "generate",
        "--spec",
        join(temporaryProject, "project.yml"),
        "--project",
        temporaryProject,
        "--quiet",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [status, standardError] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(status, standardError).toBe(0);
    await Promise.all([
      access(join(temporaryProject, "SimViewXCTestProvider.xcodeproj/project.pbxproj")),
      access(
        join(
          temporaryProject,
          "SimViewXCTestProvider.xcodeproj/xcshareddata/xcschemes/SimViewXCTestProbe.xcscheme",
        ),
      ),
    ]);
  });
});
