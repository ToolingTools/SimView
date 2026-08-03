# Distribution

SimView keeps generated executables out of Git. The public source repository is
the first distribution milestone. Binary publishing remains disabled until the
licensing, signing, and compatibility acknowledgements in
`docs/binary-redistribution.md` are explicitly satisfied.

GitHub Actions builds from source, signs the resulting Mach-O files, notarizes
the plugin archive, and then uses those same signed bytes for GitHub Releases,
npm, Codex, Claude Code, and MCPB. Raw executables are never uploaded as release
assets; permission-preserving archives and packages are the distribution unit.

The unprivileged verification job builds and smoke-tests an unsigned candidate.
Only the tag-triggered publish job has the release environment, signing
secrets, npm provenance, artifact-attestation permissions, and GitHub release
write access. `bun run check:release` fails closed when a maintainer has not
acknowledged the binary licensing, signing, and compatibility gates.

## Release contents

The generated npm package and plugin contain:

- `bin/simview`: an arm64 Bun-compiled CLI with an `mcp` subcommand.
- `bin/simview-core`: the arm64 Swift native boundary.
- `bin/libSimViewProbe.dylib`: the arm64 Simulator probe.
- the MCP App, portable skill, plugin manifests, assets, license, and notices.

Release builds minify the embedded Bun bundle and strip local Mach-O symbols
before applying either an ad-hoc development signature or the release Developer
ID signature. npm and plugin archives include only the referenced 512-pixel icon;
the larger source/MCPB artwork is not duplicated into those archives. npm
packaging fails if the resulting tarball exceeds Codex's 50 MiB plugin archive
limit.

The packaged client resolves the bundled native core before any local build
output. Shared backend instance IDs include that packaged binary's SHA-256, the
SimView version, protocol version, and Simulator UDID. Updating a plugin or npm
package therefore creates a compatible backend identity instead of attaching
to an older executable; old backends drain through their normal idle timeout.

Each release also contains `SHA256SUMS`, `release-manifest.json` (artifact names,
architectures, hashes, and signatures), and `sbom.cdx.json` (the resolved
dependency and compiled-artifact CycloneDX inventory). The manifest is the
artifact index; the SBOM is not a file-list substitute.

The internal Bun workspaces are private and are not published separately.
`scripts/package-npm.ts` generates the public `@toolingtools/simview` package under
`artifacts/` only after the release binaries exist.

## GitHub release setup

Tags must match the root package version exactly: version `0.1.12` is released
from tag `v0.1.12`.

Configure these GitHub Actions secrets:

- `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`: exported Developer ID Application
  certificate and private key in base64-encoded PKCS#12 form.
- `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`: password for the PKCS#12 file.
- `APPLE_DEVELOPER_ID_APPLICATION`: full signing identity, such as
  `Developer ID Application: Example (TEAMID)`.
- `APPLE_NOTARY_KEY_BASE64`: base64-encoded App Store Connect API `.p8` key.
- `APPLE_NOTARY_KEY_ID`: App Store Connect API key ID.
- `APPLE_NOTARY_ISSUER_ID`: App Store Connect API issuer ID.

The tag-only release workflow imports the certificate into an ephemeral keychain,
requires signing, verifies the arm64 architecture and Developer ID authority,
submits `simview-plugin.zip` with `notarytool`, smoke tests the npm tarball
through both `npx` and `bunx`, uploads the workflow artifact, publishes npm,
creates a CycloneDX dependency SBOM and release manifest, attests the artifacts,
and creates the GitHub release.

The protected `release` environment must define these repository variables as
`1` only after review:

- `SIMVIEW_BINARY_LICENSE_REVIEWED`
- `SIMVIEW_SIGNING_READY`
- `SIMVIEW_COMPATIBILITY_VERIFIED`

The probe must pass its real-Simulator injection smoke test with the Developer
ID signature before the first public release. Ad-hoc local success is not that
release gate.

## npm bootstrap

The first public publish establishes ownership of the `@toolingtools/simview`
package name.

After the first publish, configure npm trusted publishing for:

- GitHub owner: `ToolingTools`
- repository: `SimView`
- workflow: `release.yml`
- environment: `release`
- allowed action: `npm publish`

These values are case-sensitive and must match the GitHub Actions OIDC identity
exactly. The workflow's publish job uses the protected `release` environment,
so the trusted publisher must use that environment too. `npm stage publish` is
not required by the current release workflow.

The generated package has no lifecycle scripts and does not download a binary
at install time. Codex can therefore install it from an npm marketplace source
without relying on lifecycle execution.

## Marketplace repository

Keep the shared marketplace repository catalog-only. It should not contain
generated SimView or Metro MCP binaries:

```text
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
README.md
scripts/validate-catalogs
```

The Codex catalog entry can reference the npm package:

```json
{
  "name": "simview",
  "source": {
    "source": "npm",
    "package": "@toolingtools/simview",
    "version": "^0.1.12",
    "registry": "https://registry.npmjs.org"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Developer Tools"
}
```

The Claude Code catalog can reference the same package:

```json
{
  "name": "simview",
  "source": {
    "source": "npm",
    "package": "@toolingtools/simview",
    "version": "^0.1.12",
    "registry": "https://registry.npmjs.org"
  },
  "category": "Developer Tools"
}
```

Metro MCP should publish from its own source repository and appear as another
npm-backed entry in both catalogs. That keeps its cross-platform release
cadence independent of SimView's Apple signing and notarization gates.
