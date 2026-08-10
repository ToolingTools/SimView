# SimView XCTest accessibility probe

This is an evidence gate for the proposed `core-simulator-xctest` provider. It
uses a real UI-testing session and `XCUIApplication(bundleIdentifier:)` to
capture `XCUIElementSnapshot.dictionaryRepresentation` for an arbitrary app.
It does not change `ApplicationAccessibilityEnabled` and activates an existing
app instead of terminating it.

Run it against a booted Simulator and an installed application:

```sh
bun scripts/probe-xctest-accessibility.ts \
  --udid ED63A17F-F1EC-4B95-B2B6-C78450FD3AE9 \
  --bundle-id studio.churro.spenny \
  --output /tmp/spenny-xctest-tree.json
```

The script copies this project to a temporary directory and substitutes the
bundle identifier there. Repository files are never rewritten. It captures
twice by default in the same testmanagerd session; pass `--captures 1` through
`--captures 10` to change that diagnostic count. It exits non-zero if the test
fails or no marked snapshot is emitted.

`project.yml` is the source of truth. Build and probe scripts generate the
ignored Xcode project in their private temporary directories, so clean
checkouts never depend on local generated project files.

This probe is deliberately not a production provider. Productization is gated
on proving, on every supported runtime, that the snapshot exposes controls
missing from AXP, does not require the guest accessibility preference, and can
be held in one bounded persistent testmanagerd session. Until that evidence
exists, SimView must continue to fail closed rather than silently selecting
this provider.
