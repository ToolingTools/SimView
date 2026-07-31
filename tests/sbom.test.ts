import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("release SBOM", () => {
  test("describes the resolved dependency graph with CycloneDX license and purl shapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simview-sbom-test-"));
    const output = join(directory, "sbom.cdx.json");
    try {
      const child = Bun.spawn([process.execPath, "scripts/generate-sbom.ts", output], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(status, stderr).toBe(0);
      const sbom = (await Bun.file(output).json()) as {
        bomFormat: string;
        specVersion: string;
        metadata: { component: { licenses: Array<{ expression?: string }> } };
        components: Array<{
          name: string;
          purl?: string;
          hashes?: Array<{ alg: string; content: string }>;
          licenses?: Array<{ expression?: string; license?: { name?: string } }>;
        }>;
        dependencies: Array<{ ref: string; dependsOn: string[] }>;
      };
      expect(sbom.bomFormat).toBe("CycloneDX");
      expect(sbom.specVersion).toBe("1.6");
      expect(sbom.metadata.component.licenses).toEqual([{ expression: "Apache-2.0" }]);
      expect(sbom.components.length).toBeGreaterThan(10);
      expect(sbom.dependencies.length).toBe(sbom.components.length);
      expect(sbom.components.some((component) => component.purl?.startsWith("pkg:npm/%40"))).toBe(
        true,
      );
      expect(
        sbom.components
          .filter((component) =>
            ["simview CLI", "simview-core", "libSimViewProbe.dylib"].includes(component.name),
          )
          .every((component) => component.hashes?.[0]?.alg === "SHA-256"),
      ).toBe(true);
      expect(
        sbom.components.every((component) =>
          (component.licenses ?? []).every(
            (license) => Boolean(license.expression) || Boolean(license.license?.name),
          ),
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
