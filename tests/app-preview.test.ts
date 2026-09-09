import { expect, test } from "bun:test";

for (const transport of ["embedded", "relay"]) {
  test(`rendered ${transport} preview preserves intentional pauses across tree transfers`, async () => {
    const result = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/app-preview-pauses.mjs", import.meta.url).pathname,
        ...(transport === "relay" ? ["--relay"] : []),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      result.exited,
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("PASS: rendered preview pauses");
  }, 20_000);
}
