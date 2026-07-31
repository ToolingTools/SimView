# Binary redistribution gate

Opening the SimView source repository does not authorize publishing its
standalone executables. `bun build --compile` embeds the Bun runtime. Bun is MIT
licensed, but its own license documentation states that it statically links
LGPL-2 JavaScriptCore/WebKit code and requires consumers to have an opportunity
to modify and relink that library.

The release workflow therefore requires three explicit repository variables:

- `SIMVIEW_BINARY_LICENSE_REVIEWED=1`
- `SIMVIEW_SIGNING_READY=1`
- `SIMVIEW_COMPATIBILITY_VERIFIED=1`

These are acknowledgements by the release operator, not automated legal
conclusions.

## Release operator checklist

Before setting `SIMVIEW_BINARY_LICENSE_REVIEWED`:

1. Identify the exact Bun revision and its pinned WebKit revision.
2. Preserve Bun's notices for every statically linked library.
3. Publish or provide a durable written offer for the corresponding patched
   WebKit source.
4. Supply the SimView/Bun object or relinking materials and reproducible
   instructions required by the applicable LGPL terms.
5. Have the proposed archive, npm package, notices, and delivery mechanism
   reviewed by qualified counsel.

Before setting the other gates, complete Developer ID signing/notarization and
the complete real-Simulator matrix in `docs/compatibility.md`.

The repository intentionally provides no bypass or default value for these
variables. Local unsigned builds remain available for development.

