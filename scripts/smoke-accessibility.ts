#!/usr/bin/env bun
import {
  compactAccessibilityTree,
  flattenAccessibilityTree,
  SimViewClient,
  type AccessibilitySnapshot,
} from "@simview/client";

const udid = process.argv[2];
const bundleId = process.argv[3];
if (!udid) throw new Error("Usage: smoke-accessibility.ts <udid> [probe-bundle-id]");

const client = await SimViewClient.start({
  udid,
  binary: process.env.SIMVIEW_CORE_BINARY,
});
try {
  const snapshot = await client.request<AccessibilitySnapshot>("accessibility.snapshot", {
    udid,
    scope: "interactive",
  });
  console.log(JSON.stringify({
    accessibility: {
      snapshotId: snapshot.snapshotId,
      nodeCount: snapshot.stats.nodeCount,
      rootRole: snapshot.root.role,
      compact: compactAccessibilityTree(snapshot).split("\n").slice(0, 12),
    },
  }, null, 2));
  const nativeWait = await client.request("accessibility.wait", {
    udid,
    selector: { identifier: "__simview_missing_smoke_element__" },
    state: "absent",
    timeoutMs: 1_000,
  });
  console.log(JSON.stringify({ nativeWait }, null, 2));

  const tapIdentifier = process.env.SIMVIEW_SMOKE_TAP_ID;
  if (tapIdentifier) {
    const matches = flattenAccessibilityTree(snapshot.root).filter(
      node => node.identifier === tapIdentifier,
    );
    const found = { count: matches.length, matches };
    if (found.count !== 1 || !found.matches[0]?.frame) {
      throw new Error(
        `Semantic smoke selector matched ${found.count} elements: ${JSON.stringify(found.matches.slice(0, 3))}`,
      );
    }
    const frame = found.matches[0].frame.normalized;
    const point = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    const receipt = await client.request("input.tap", point);
    await Bun.sleep(350);
    const after = await client.request<AccessibilitySnapshot>("accessibility.snapshot", {
      udid,
      scope: "interactive",
    });
    console.log(JSON.stringify({
      semanticTap: {
        identifier: tapIdentifier,
        point,
        receipt,
        afterSnapshotId: after.snapshotId,
        afterNodeCount: after.stats.nodeCount,
      },
    }, null, 2));
  }

  if (bundleId) {
    const enabled = await client.request("probe.enable", { udid, bundleId });
    const context = await client.request("probe.context");
    const point = await client.request("probe.inspectPoint", { x: 0.5, y: 0.5 });
    const views = await client.request("probe.findViews", {
      filters: { point: { x: 0.5, y: 0.5 }, visibleOnly: true },
      maxNodes: 500,
    });
    const hierarchy = await client.request("probe.fullHierarchy", {
      maxDepth: 4,
      maxNodes: 500,
    });
    console.log(JSON.stringify({ enabled, context, point, views, hierarchy }, null, 2));
  }
} finally {
  await client.close();
}
