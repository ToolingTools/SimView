# Third-party notices

SimView is Apache-2.0 licensed. Its source and binary distributions also use
the software and adapted techniques listed below. The release SBOM records the
complete resolved production dependency graph for each binary build.

## Runtime libraries

- **Model Context Protocol TypeScript SDK 1.30.0**, copyright Anthropic, PBC,
  licensed under the MIT License.
- **MCP Apps SDK 1.7.5**, copyright Model Context Protocol, a Series of LF
  Projects, LLC and its contributors. Its distributed license identifies
  applicable Apache-2.0, MIT, and CC-BY-4.0 material during the project's
  licensing transition.
- **Preact 10.29.7**, copyright the Preact authors, licensed under the MIT
  License.
- **Zod 4.4.3**, copyright Colin McDonnell, licensed under the MIT License.
- **metro-bridge 0.2.10**, licensed under the MIT License.
- **ws 8.21.1**, copyright Einar Otto Stangvik, licensed under the MIT License.

The compiled command includes the Bun runtime. Bun itself is MIT licensed and
statically links additional libraries documented by the Bun project. In
particular, its JavaScriptCore, WebKit, and applicable WebCore portions are
LGPL-2 licensed. SimView does not publish a Bun-containing executable until
the checklist in `docs/binary-redistribution.md` is satisfied.

## Adapted compatibility work

### serve-sim

Portions of SimView's SimulatorKit framebuffer and Indigo HID compatibility
work are adapted from [serve-sim](https://github.com/EvanBacon/serve-sim),
copyright Evan Bacon and contributors, licensed under Apache-2.0.

The adapted concepts and selector declarations are isolated under
`native/SimViewCore/Sources/SimViewCore/Compatibility`.

### IDB

Portions of SimView's host-side CoreSimulator accessibility translation flow
are adapted from [IDB](https://github.com/facebook/idb), copyright Meta
Platforms, Inc. and affiliates, licensed under the MIT License.

The adapted bridge is isolated in
`native/SimViewCore/Sources/SimViewAXShim`. SimView's injected UIKit probe is an
independent implementation and contains no proprietary code.

## Release records

Every binary release must include this file, the Apache-2.0 `LICENSE`, a
CycloneDX `sbom.cdx.json`, `release-manifest.json`, and `SHA256SUMS`. The SBOM
is authoritative for exact transitive package versions in that release.
