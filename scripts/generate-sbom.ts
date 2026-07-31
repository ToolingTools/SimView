import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface PackageManifest {
  name: string;
  version: string;
  license?: string;
  homepage?: string;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  packageManager?: string;
}

interface Component {
  type: "library" | "application" | "file";
  "bom-ref": string;
  name: string;
  version: string;
  hashes?: Array<{ alg: "SHA-256"; content: string }>;
  licenses?: Array<{ expression: string } | { license: { name: string } }>;
  externalReferences?: Array<{ type: "website" | "vcs"; url: string }>;
  purl?: string;
}

const root = resolve(import.meta.dir, "..");
const output = process.argv[2] ?? join(root, "artifacts/release/sbom.cdx.json");
const rootManifest = await readManifest(join(root, "package.json"));
const manifests = new Map<string, PackageManifest>();
const relationships = new Map<string, Set<string>>();
const rootRef = `pkg:generic/simview@${rootManifest.version}`;
const queue = Object.keys(rootManifest.dependencies ?? {}).map((name) => ({
  name,
  fromDirectory: root,
  parentRef: rootRef,
}));

while (queue.length > 0) {
  const entry = queue.shift();
  if (!entry || entry.name.startsWith("@simview/")) continue;
  const manifestPath = await resolveManifest(entry.name, entry.fromDirectory);
  const manifest = await readManifest(manifestPath);
  const reference = packageRef(manifest);
  addRelationship(entry.parentRef, reference);
  if (manifests.has(reference)) continue;
  manifests.set(reference, manifest);
  const dependencies = Object.keys(manifest.dependencies ?? {}).filter(
    (dependency) => !dependency.startsWith("@simview/"),
  );
  queue.push(
    ...dependencies.map((name) => ({
      name,
      fromDirectory: dirname(manifestPath),
      parentRef: reference,
    })),
  );
}

const components: Component[] = [...manifests.values()]
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((manifest) => {
    const references: NonNullable<Component["externalReferences"]> = [];
    if (manifest.homepage) references.push({ type: "website", url: manifest.homepage });
    const repository =
      typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    if (repository) references.push({ type: "vcs", url: repository });
    return {
      type: "library",
      "bom-ref": packageRef(manifest),
      name: manifest.name,
      version: manifest.version,
      ...(manifest.license ? { licenses: [licenseChoice(manifest.license)] } : {}),
      ...(references.length > 0 ? { externalReferences: references } : {}),
      purl: packageRef(manifest),
    };
  });

const bunVersion = rootManifest.packageManager?.replace(/^bun@/, "") ?? Bun.version;
const bunRef = `pkg:generic/bun@${bunVersion}`;
const webkitRef = "pkg:github/oven-sh/WebKit";
const compiledArtifacts = await Promise.all(
  [
    {
      type: "application" as const,
      name: "simview CLI",
      ref: `pkg:generic/simview-cli@${rootManifest.version}`,
      path: join(root, "packages/cli/dist/simview"),
    },
    {
      type: "application" as const,
      name: "simview-core",
      ref: `pkg:generic/simview-core@${rootManifest.version}`,
      path: join(root, "packages/core/bin/simview-core"),
    },
    {
      type: "file" as const,
      name: "libSimViewProbe.dylib",
      ref: `pkg:generic/simview-probe@${rootManifest.version}`,
      path: join(root, "packages/core/bin/libSimViewProbe.dylib"),
    },
  ].map(async (artifact) => ({
    type: artifact.type,
    "bom-ref": artifact.ref,
    name: artifact.name,
    version: rootManifest.version,
    hashes: [
      {
        alg: "SHA-256" as const,
        content: new Bun.CryptoHasher("sha256")
          .update(await Bun.file(artifact.path).arrayBuffer())
          .digest("hex"),
      },
    ],
    licenses: [{ expression: "Apache-2.0" }],
  })),
);
components.push(
  ...compiledArtifacts,
  {
    type: "application",
    "bom-ref": bunRef,
    name: "Bun runtime",
    version: bunVersion,
    licenses: [{ expression: "MIT" }],
    externalReferences: [{ type: "website", url: "https://bun.sh/docs/project/license" }],
  },
  {
    type: "library",
    "bom-ref": webkitRef,
    name: "JavaScriptCore and WebKit portions linked by Bun",
    version: "Bun-pinned revision",
    licenses: [{ expression: "LGPL-2.0-only" }],
    externalReferences: [{ type: "vcs", url: "https://github.com/oven-sh/WebKit" }],
  },
);

const dependencyEntries = [
  { ref: rootRef, dependsOn: compiledArtifacts.map((artifact) => artifact["bom-ref"]) },
  {
    ref: compiledArtifacts[0]?.["bom-ref"] ?? `pkg:generic/simview-cli@${rootManifest.version}`,
    dependsOn: [bunRef, ...(relationships.get(rootRef) ?? [])],
  },
  ...compiledArtifacts.slice(1).map((artifact) => ({
    ref: artifact["bom-ref"],
    dependsOn: [],
  })),
  { ref: bunRef, dependsOn: [webkitRef] },
  ...[...manifests.entries()].map(([reference]) => ({
    ref: reference,
    dependsOn: [...(relationships.get(reference) ?? [])],
  })),
];

await writeFile(
  output,
  `${JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          type: "application",
          "bom-ref": rootRef,
          name: "simview",
          version: rootManifest.version,
          licenses: [{ expression: "Apache-2.0" }],
        },
        tools: {
          components: [{ type: "application", name: "SimView SBOM generator", version: "1" }],
        },
      },
      components,
      dependencies: dependencyEntries,
    },
    null,
    2,
  )}\n`,
);

function packageRef(manifest: PackageManifest): string {
  const qualifiedName = manifest.name.startsWith("@")
    ? `${encodeURIComponent(manifest.name.split("/", 1)[0] ?? "")}/${manifest.name.split("/").slice(1).join("/")}`
    : encodeURIComponent(manifest.name);
  return `pkg:npm/${qualifiedName}@${manifest.version}`;
}

function licenseChoice(value: string): { expression: string } | { license: { name: string } } {
  if (/^SEE LICENSE/i.test(value) || /^UNLICENSED$/i.test(value)) {
    return { license: { name: value } };
  }
  return { expression: value };
}

function addRelationship(parent: string, child: string): void {
  const dependencies = relationships.get(parent) ?? new Set<string>();
  dependencies.add(child);
  relationships.set(parent, dependencies);
}

async function resolveManifest(name: string, fromDirectory: string): Promise<string> {
  let current = fromDirectory;
  while (true) {
    const candidate = join(current, "node_modules", name, "package.json");
    try {
      const manifest = await readManifest(candidate);
      if (manifest.name === name) return realpath(candidate);
    } catch {
      // Continue through Node's parent-directory package resolution order.
    }
    if (current === root || current === dirname(current)) break;
    current = dirname(current);
  }
  throw new Error(`Could not resolve package metadata for ${name} from ${fromDirectory}`);
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}
