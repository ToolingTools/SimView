# Distribution

SimView keeps generated executables out of Git. GitHub Actions builds the
release from source, signs the resulting Mach-O files, notarizes the plugin
archive, and then uses those same signed bytes for GitHub Releases, npm, Codex,
Claude Code, and MCPB.

## Release contents

The generated npm package and plugin contain:

- `bin/simview`: a universal Bun-compiled CLI with an `mcp` subcommand.
- `bin/simview-core`: the universal Swift native boundary.
- `bin/libSimViewProbe.dylib`: the universal Simulator probe.
- the MCP App, portable skill, plugin manifests, assets, license, and notices.

The internal Bun workspaces are private and are not published separately.
`scripts/package-npm.ts` generates the public `simview` package under
`artifacts/` only after the release binaries exist.

## GitHub release setup

Tags must match the root package version exactly: version `0.1.0` is released
from tag `v0.1.0`.

Configure these GitHub Actions secrets:

- `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`: exported Developer ID Application
  certificate and private key in base64-encoded PKCS#12 form.
- `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`: password for the PKCS#12 file.
- `APPLE_DEVELOPER_ID_APPLICATION`: full signing identity, such as
  `Developer ID Application: Example (TEAMID)`.
- `APPLE_NOTARY_KEY_BASE64`: base64-encoded App Store Connect API `.p8` key.
- `APPLE_NOTARY_KEY_ID`: App Store Connect API key ID.
- `APPLE_NOTARY_ISSUER_ID`: App Store Connect API issuer ID.

The release workflow imports the certificate into an ephemeral keychain,
requires signing, verifies both architectures and the Developer ID authority,
submits `simview-plugin.zip` with `notarytool`, smoke tests the npm tarball
through both `npx` and `bunx`, uploads the workflow artifact, publishes npm,
and creates the GitHub release.

The probe must pass its real-Simulator injection smoke test with the Developer
ID signature before the first public release. Ad-hoc local success is not that
release gate.

## npm bootstrap

The first public publish establishes ownership of the `simview` package name.
If that name cannot be claimed, set `SIMVIEW_NPM_PACKAGE_NAME` while packaging
and update the release workflow tarball name before publishing.

After the first publish, configure npm trusted publishing for:

- GitHub owner: `steve228uk`
- repository: `SimView`
- workflow: `release.yml`

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
    "package": "simview",
    "version": "^0.1.0",
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
    "package": "simview",
    "version": "^0.1.0",
    "registry": "https://registry.npmjs.org"
  },
  "category": "Developer Tools"
}
```

Metro MCP should publish from its own source repository and appear as another
npm-backed entry in both catalogs. That keeps its cross-platform release
cadence independent of SimView's Apple signing and notarization gates.
