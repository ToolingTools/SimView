import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { compactAccessibilityTree } from "@simview/client";
import {
  accessibilityNodeSchema,
  accessibilityObservationStrategySchema,
  accessibilityResourceSchema,
  accessibilitySelectorSchema,
  accessibilitySnapshotSchema,
  annotationContextSchema,
  annotationGeometrySchema,
  annotationSchema,
  type DeviceDescription,
  deviceListSchema,
  ELEMENT_TREE_PAGE_RAW_BYTES,
  ELEMENT_TREE_TRANSFER_MAX_BYTES,
  type ElementSearchMatch,
  type ElementTreeOutput,
  type ElementTreePage,
  elementSearchMatchSchema,
  elementSearchQuerySchema,
  elementSnapshotSchema,
  elementTreeOutputSchema,
  elementTreePageSchema,
  flattenAccessibilityTree,
  gestureTracksSchema,
  inspectPointOutputSchema,
  jsonObjectSchema,
  jsonValueSchema,
  normalizedPointSchema,
  previewPacketBatchSchema,
  relayInputSchema,
  type SessionState,
  SIMVIEW_VERSION,
  saveReviewImagesInputSchema,
  saveReviewImagesOutputSchema,
  screenContextSchema,
  semanticErrorSchema,
  semanticNodeSummarySchema,
  sessionStateSchema,
  stableAccessibilityEntries,
  summarizeAccessibilityNode,
  uiContextSchema,
} from "@simview/contracts";
import { z } from "zod";
import { resolveAppRoot } from "./app-assets";
import { inlineAppModule } from "./app-html";
import {
  type AccessibilityObservation,
  type DestinationVerification,
  SimViewSession,
  type WarmObservation,
} from "./session";

const VERSION = process.env.SIMVIEW_RESOURCE_VERSION ?? SIMVIEW_VERSION;
const ELEMENT_TREE_TRANSFER_TTL_MS = 30_000;
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const BROWSER_FALLBACK_DELAY_MS = 5_000;
const DEVICE_PAGE_LIMIT = 25;
const DEVICE_INVENTORY_SNAPSHOT_TTL_MS = 30_000;
const DEVICE_INVENTORY_SNAPSHOT_LIMIT = 4;
const DEVICE_INVENTORY_RETAINED_LIMIT = 250;
const UNAMBIGUOUS_SEARCH_SCORE_GAP = 0.1;

export interface DeviceListOptions {
  availableOnly?: boolean | undefined;
  platform?: "ios" | "android" | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

type DeviceInventorySnapshot = {
  devices: DeviceDescription[];
  inventoryTotal: number;
  total: number;
  limit: number;
  offset: number;
  expiresAt: number;
  truncated: boolean;
};

class DeviceInventorySnapshotCache {
  readonly #entries = new Map<string, DeviceInventorySnapshot>();

  constructor(
    private readonly ttlMilliseconds: number,
    private readonly now: () => number,
  ) {}

  clear() {
    this.#entries.clear();
  }

  create(snapshot: Omit<DeviceInventorySnapshot, "expiresAt">): string {
    this.#pruneExpired();
    while (this.#entries.size >= DEVICE_INVENTORY_SNAPSHOT_LIMIT) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const cursor = randomBytes(32).toString("base64url");
    this.#entries.set(cursor, {
      ...snapshot,
      expiresAt: this.now() + this.ttlMilliseconds,
    });
    return cursor;
  }

  continue(cursor: string): DeviceInventorySnapshot {
    this.#pruneExpired();
    const snapshot = this.#entries.get(cursor);
    if (!snapshot) throw new Error("Device inventory cursor is invalid or expired");
    this.#entries.delete(cursor);
    return snapshot;
  }

  #pruneExpired() {
    const now = this.now();
    for (const [cursor, snapshot] of this.#entries) {
      if (snapshot.expiresAt <= now) this.#entries.delete(cursor);
    }
  }
}

export function deviceListPage(inventory: DeviceDescription[], options: DeviceListOptions = {}) {
  const availableOnly = options.availableOnly ?? true;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(DEVICE_PAGE_LIMIT, options.limit ?? 10));
  const filtered = inventory
    .filter((device) => !availableOnly || device.available)
    .filter((device) => !options.platform || device.platform === options.platform)
    .toSorted(
      (left, right) =>
        Number(right.available) - Number(left.available) ||
        left.platform.localeCompare(right.platform) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  const devices = filtered.slice(offset, offset + limit);
  return {
    devices,
    inventoryTotal: inventory.length,
    total: filtered.length,
    returned: devices.length,
    offset,
    limit,
    hasMore: offset + devices.length < filtered.length,
  };
}

function sortedDeviceInventory(inventory: DeviceDescription[], options: DeviceListOptions) {
  const availableOnly = options.availableOnly ?? true;
  return inventory
    .filter((device) => !availableOnly || device.available)
    .filter((device) => !options.platform || device.platform === options.platform)
    .toSorted(
      (left, right) =>
        Number(right.available) - Number(left.available) ||
        left.platform.localeCompare(right.platform) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

function resourceMetadata(reviewId: string) {
  const resourceUri = `ui://simview/${VERSION}/reviews/${reviewId}/preview.html`;
  return {
    resourceUri,
    openPreview: {
      ui: { resourceUri, visibility: ["model"] as const },
      "ui/resourceUri": resourceUri,
      "openai/outputTemplate": resourceUri,
      "openai/widgetAccessible": true,
    },
    modelOnly: {
      ui: { visibility: ["model"] as const },
    },
    appOnly: {
      ui: { resourceUri, visibility: ["app"] as const },
      "ui/resourceUri": resourceUri,
      "openai/widgetAccessible": true,
    },
  };
}

type ResourceMetadata = ReturnType<typeof resourceMetadata>;

function unambiguousSearchMatch({
  matches,
  total,
}: {
  matches: ElementSearchMatch[];
  total: number;
}): ElementSearchMatch | undefined {
  const winner = matches[0];
  if (!winner) return undefined;
  if (total === 1) return winner;
  const runnerUp = matches[1];
  if (!runnerUp) return undefined;
  if (winner.exact && !runnerUp.exact) return winner;
  return winner.score - runnerUp.score >= UNAMBIGUOUS_SEARCH_SCORE_GAP ? winner : undefined;
}

function unambiguousInteractionSearchMatch(search: {
  matches: ElementSearchMatch[];
  total: number;
}): ElementSearchMatch | undefined {
  const nativeMatches = search.matches.filter((match) => match.source !== "react-native-fiber");
  if (nativeMatches.length > 0) {
    return unambiguousSearchMatch({ matches: nativeMatches, total: nativeMatches.length });
  }
  return unambiguousSearchMatch(search);
}

type ObservationBaseline = {
  afterRevision: string | undefined;
  beforeSemanticHash: string | undefined;
  afterVisualRevision: number | undefined;
};

async function captureObservationBaseline(session: SimViewSession): Promise<ObservationBaseline> {
  if (!session.accessibilityRevision) await session.accessibilityObserve({ maxWaitMs: 0 });
  return {
    afterRevision: session.accessibilityRevision,
    beforeSemanticHash: session.lastAccessibility
      ? semanticHashForSnapshot(session.lastAccessibility)
      : undefined,
    afterVisualRevision: session.latestObservation?.changeRevision,
  };
}

type ElementTreePageCache = {
  transferId: string;
  deviceId: string | undefined;
  connectionGeneration: number;
  expiresAt: number;
  bytes: Buffer;
  sha256: string;
  cursors: string[];
};

const fallbackMessages = {
  "metro-target-unavailable": "No matching React Native Metro target was found.",
  "metro-fiber-unavailable": "The matching React Native target exposed no Fiber root.",
  "metro-inspection-failed": "React Native inspection failed; retrying can reconnect Hermes.",
} as const;

function compactElementTree(
  result: ElementTreeOutput,
  preferredSnapshot?: z.output<typeof accessibilitySnapshotSchema>,
): string {
  const context = result.screenContext;
  const usesPreferredSnapshot = Boolean(
    preferredSnapshot &&
      preferredSnapshot.stats.quality !== "degraded" &&
      preferredSnapshot.stats.nodeCount > 1,
  );
  const snapshot = usesPreferredSnapshot ? (preferredSnapshot ?? result.snapshot) : result.snapshot;
  const summary =
    context.kind === "react-native"
      ? [
          usesPreferredSnapshot
            ? `context=react-native-fiber renderer=${context.renderer} elements=${snapshot.source}`
            : `source=react-native-fiber renderer=${context.renderer}`,
          context.navigationPath?.length
            ? `screen=${context.navigationPath.join(" > ")}`
            : context.route
              ? `screen=${context.route}`
              : undefined,
          context.screenComponent ? `component=${context.screenComponent}` : undefined,
        ]
          .filter(Boolean)
          .join(" ")
      : `source=${result.snapshot.source}${result.fallback ? ` fallback=${result.fallback.reason}` : ""}`;
  const fallback = result.fallback ? fallbackMessages[result.fallback.reason] : undefined;
  return [summary, fallback, compactAccessibilityTree(snapshot)].filter(Boolean).join("\n");
}

type SemanticIndex = Map<string, { hash: string; ref: string }>;

function indexSemantics(snapshot: z.output<typeof accessibilitySnapshotSchema>): SemanticIndex {
  return new Map(
    stableAccessibilityEntries(snapshot.root).map(({ key, ref, value }) => [
      key,
      { ref, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") },
    ]),
  );
}

function semanticHash(index: SemanticIndex): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...index]
          .map(([key, entry]) => [key, entry.hash] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

function semanticHashForSnapshot(snapshot: z.output<typeof accessibilitySnapshotSchema>): string {
  return semanticHash(indexSemantics(snapshot));
}

function semanticDelta(previous: SemanticIndex, current: SemanticIndex) {
  const added = [...current.keys()].filter((ref) => !previous.has(ref));
  const removed = [...previous].filter(([key]) => !current.has(key)).map(([, entry]) => entry.ref);
  const changed = [...current]
    .filter(([key, entry]) => previous.get(key)?.hash !== entry.hash && previous.has(key))
    .map(([, entry]) => entry.ref);
  return {
    added: added.map((key) => current.get(key)?.ref ?? key),
    removed,
    changed,
  };
}

function elementTreePage(cache: ElementTreePageCache, pageIndex: number): ElementTreePage {
  const pageCount = Math.ceil(cache.bytes.byteLength / ELEMENT_TREE_PAGE_RAW_BYTES);
  if (pageIndex < 0 || pageIndex >= pageCount) {
    throw new Error("Element tree page cursor is invalid or expired");
  }
  const start = pageIndex * ELEMENT_TREE_PAGE_RAW_BYTES;
  const chunk = cache.bytes.subarray(start, start + ELEMENT_TREE_PAGE_RAW_BYTES);
  return {
    schemaVersion: 1 as const,
    transferId: cache.transferId,
    encoding: "base64-json",
    pageIndex,
    pageCount,
    chunk: chunk.toString("base64"),
    chunkBytes: chunk.byteLength,
    totalBytes: cache.bytes.byteLength,
    sha256: cache.sha256,
    ...(pageIndex + 1 < pageCount ? { nextCursor: cache.cursors[pageIndex + 1] } : {}),
  };
}

const acceptedOutputSchema = z.object({ accepted: z.literal(true) }).passthrough();
const genericObjectOutputSchema = z.object({}).catchall(jsonValueSchema);
const findElementsOutputSchema = z.object({
  snapshotId: z.string(),
  selector: accessibilitySelectorSchema,
  matches: z.array(accessibilityNodeSchema),
  count: z.number().int().nonnegative(),
});
const searchElementsOutputSchema = z.object({
  snapshotId: z.string(),
  query: elementSearchQuerySchema,
  matches: z.array(elementSearchMatchSchema),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  excludedExactMatchCount: z.number().int().nonnegative(),
  excludedCandidateCount: z.number().int().nonnegative(),
  excludedCandidates: z.array(
    z.object({
      match: elementSearchMatchSchema,
      reasons: z.array(z.enum(["visibility", "actionability"])),
      scrollRequired: z.boolean(),
      suggestedScrollDirection: z.enum(["up", "down", "left", "right"]).optional(),
    }),
  ),
  sources: z.array(
    z.object({
      source: z.string(),
      snapshotId: z.string(),
      quality: z.enum(["complete", "partial", "degraded"]),
      reason: z.string().optional(),
      truncated: z.boolean(),
      nodeCount: z.number().int().nonnegative(),
      capturedBudget: z.number().int().positive().optional(),
      exactMatchCount: z.number().int().nonnegative(),
      excludedExactMatchCount: z.number().int().nonnegative(),
      excludedExactMatches: z.object({
        visibility: z.number().int().nonnegative(),
        actionability: z.number().int().nonnegative(),
      }),
    }),
  ),
});
const waitOutputSchema = z.object({
  durationMs: z.number().nonnegative(),
  schemaVersion: z.literal(1),
  state: z.enum(["visible", "hidden"]),
  satisfied: z.literal(true),
  count: z.number().int().nonnegative(),
  snapshotId: z.string(),
  matches: z.array(accessibilityNodeSchema),
});
const screenshotOutputSchema = z.object({
  frameId: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const postActionAccessibilitySchema = z.object({
  event: z.enum(["changed", "timed_out", "unavailable"]),
  semantic: z.enum(["changed", "unchanged", "unconfirmed", "unavailable"]),
  revision: z.string().optional(),
  strategy: accessibilityObservationStrategySchema.optional(),
  stable: z.boolean(),
  forcedRetry: z.boolean(),
  visualChanged: z.boolean().optional(),
  fallbackUsed: z.boolean().optional(),
  captureCount: z.number().int().nonnegative().optional(),
  changeSource: z.enum(["event", "snapshot-diff", "none"]).optional(),
  resourceUri: z.string().optional(),
});
const postActionObservationSchema = z.object({ accessibility: postActionAccessibilitySchema });
const observeOutputSchema = z.object({
  observationId: z.string(),
  frameId: z.string(),
  sourceRevisions: z.object({
    frame: z.number().int().nonnegative(),
    visualChange: z.number().int().nonnegative(),
    image: z.number().int().nonnegative(),
    accessibility: z.string().optional(),
    fiber: z.string().optional(),
  }),
  timestamps: z.object({
    frameCapturedAt: z.string(),
    settledAt: z.string(),
    accessibilityReadyAt: z.string().optional(),
    fiberReadyAt: z.string().optional(),
    imageReadyAt: z.string().optional(),
    mcpReturnedAt: z.string(),
  }),
  stability: z.object({ stable: z.boolean(), ageMs: z.number().nonnegative() }),
  cache: z.object({ imageHit: z.boolean(), fiberHit: z.boolean() }),
  semantic: z.object({
    hash: z.string().optional(),
    status: z.enum(["full", "delta", "unchanged", "unavailable"]),
    nodeCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    added: z.array(z.string()).optional(),
    removed: z.array(z.string()).optional(),
    changed: z.array(z.string()).optional(),
    nodes: z.array(semanticNodeSummarySchema).optional(),
  }),
  vision: z.object({
    included: z.boolean(),
    reason: z.string(),
    mimeType: z.literal("image/jpeg").optional(),
    returnedBytes: z.number().int().nonnegative(),
  }),
  snapshot: accessibilitySnapshotSchema.optional(),
  elements: elementSnapshotSchema.optional(),
  screenContext: screenContextSchema.optional(),
  fallback: elementTreeOutputSchema.shape.fallback.optional(),
  semanticError: semanticErrorSchema.optional(),
  postAction: postActionObservationSchema.optional(),
});

function reconcileObservationWithDestination(
  observation: z.output<typeof observeOutputSchema>,
  verification: DestinationVerification | undefined,
): z.output<typeof observeOutputSchema> {
  if (!verification?.stable) return observation;
  const postAction = observation.postAction?.accessibility;
  return {
    ...observation,
    sourceRevisions: {
      ...observation.sourceRevisions,
      ...(verification.revision ? { accessibility: verification.revision } : {}),
    },
    timestamps: {
      ...observation.timestamps,
      ...(verification.settledAt
        ? {
            settledAt: verification.settledAt,
            accessibilityReadyAt: verification.settledAt,
          }
        : {}),
    },
    stability: { ...observation.stability, stable: true },
    ...(postAction
      ? {
          postAction: {
            accessibility: {
              ...postAction,
              event: postAction.semantic === "changed" ? "changed" : postAction.event,
              stable: true,
              ...(verification.revision ? { revision: verification.revision } : {}),
              ...(verification.strategy ? { strategy: verification.strategy } : {}),
              ...(verification.fallbackUsed !== undefined
                ? { fallbackUsed: verification.fallbackUsed }
                : {}),
              ...(verification.captureCount !== undefined
                ? { captureCount: verification.captureCount }
                : {}),
              ...(verification.changeSource ? { changeSource: verification.changeSource } : {}),
            },
          },
        }
      : {}),
  };
}

const destinationSelectorSchema = z
  .object({
    identifier: z
      .string()
      .min(1)
      .describe("Stable native AX identifier expected on the destination screen.")
      .optional(),
    role: z
      .string()
      .min(1)
      .describe("Native AX role used to narrow another destination field; avoid using role alone.")
      .optional(),
    name: z
      .string()
      .min(1)
      .describe(
        "Native accessible label expected on the destination. Prefer a distinctive complete label; avoid generic labels such as Card.",
      )
      .optional(),
    value: z
      .string()
      .min(1)
      .describe(
        "Native AX value expected on the destination. Use only when observe/search exposed it as a value; visible text is often an accessible name instead.",
      )
      .optional(),
    exact: z
      .boolean()
      .default(true)
      .describe(
        "Exact matching is the default. Set false only for a known fragment of a composite native label, such as #30363063 within Invoice #30363063.",
      ),
  })
  .refine(
    (selector) => Boolean(selector.identifier || selector.role || selector.name || selector.value),
    { message: "A destination selector requires identifier, role, name, or value" },
  );

const destinationVerificationInputSchema = z.object({
  identity: destinationSelectorSchema.describe(
    "The stable native destination identity. It must match exactly one node; prefer a unique identifier or complete entity label.",
  ),
  assertions: z
    .array(destinationSelectorSchema)
    .max(4)
    .default([])
    .describe(
      "Up to four supporting destination conditions such as amount or status. Each must be present, but may legitimately match multiple nodes.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(5_000)
    .default(1_000)
    .describe("Verification timeout in milliseconds: 100-5000 inclusive; maximum 5000."),
});

function destinationVerificationWarnings(
  verification: DestinationVerification | undefined,
): string[] {
  const broadChecks =
    verification?.checks.filter((check) => check.kind === "identity" && check.count > 1) ?? [];
  return broadChecks.length
    ? [
        "The destination identity matched multiple native nodes. Use a distinctive identifier or complete entity label; supporting assertions cannot disambiguate identity.",
      ]
    : [];
}

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("long_press"),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    durationMs: z.number().int().min(100).max(5_000).default(600),
  }),
  z.object({
    type: z.literal("swipe"),
    from: normalizedPointSchema,
    to: normalizedPointSchema,
    durationMs: z.number().int().min(50).max(5_000).default(350),
  }),
  z.object({ type: z.literal("type_text"), text: z.string().max(10_000) }),
  z.object({
    type: z.literal("press_button"),
    button: z.enum(["home", "back", "overview", "lock", "volume-up", "volume-down", "action"]),
  }),
  z.object({
    type: z.literal("set_orientation"),
    orientation: z.enum(["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]),
  }),
  z.object({
    type: z.literal("gesture"),
    tracks: gestureTracksSchema,
  }),
  z.object({
    type: z.literal("tap_element"),
    ref: z.string().optional(),
    identifier: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    exact: z.boolean().default(true),
    index: z.number().int().min(0).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    verifyDestination: destinationVerificationInputSchema.optional(),
  }),
  z.object({
    type: z.literal("wait_for_element"),
    ref: z.string().optional(),
    identifier: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    exact: z.boolean().default(true),
    index: z.number().int().min(0).optional(),
    state: z.enum(["visible", "hidden"]).default("visible"),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  }),
]);

export function createServer(
  session = new SimViewSession(),
  {
    browserFallbackDelayMs = BROWSER_FALLBACK_DELAY_MS,
    environment = process.env,
    deviceProvider = () =>
      import("@simview/client").then(({ SimViewClient }) => SimViewClient.listDevices()),
    deviceInventorySnapshotTTLMS = DEVICE_INVENTORY_SNAPSHOT_TTL_MS,
    now = Date.now,
  }: {
    browserFallbackDelayMs?: number;
    environment?: Readonly<Record<string, string | undefined>>;
    deviceProvider?: () => Promise<DeviceDescription[]>;
    deviceInventorySnapshotTTLMS?: number;
    now?: () => number;
  } = {},
): McpServer {
  const server = new McpServer(
    { name: "simview", version: VERSION },
    { capabilities: { resources: { subscribe: true } } },
  );
  const metadata = resourceMetadata(session.reviewId);
  let accessibilityResourceSubscribed = false;
  server.server.setRequestHandler(
    "resources/subscribe",
    { params: z.object({ uri: z.string() }), result: z.object({}) },
    async ({ uri }) => {
      accessibilityResourceSubscribed = uri === session.accessibilityResourceUri;
      return {};
    },
  );
  server.server.setRequestHandler(
    "resources/unsubscribe",
    { params: z.object({ uri: z.string() }), result: z.object({}) },
    async ({ uri }) => {
      if (uri === session.accessibilityResourceUri) accessibilityResourceSubscribed = false;
      return {};
    },
  );
  const unsubscribeAccessibilityResource = session.onAccessibilityResourceUpdate(() => {
    if (!accessibilityResourceSubscribed) return;
    void server.server.sendResourceUpdated({ uri: session.accessibilityResourceUri });
  });
  // Standard MCP Apps clients advertise support. Older HTML app hosts do not,
  // so their resource read is the only reliable acknowledgement before fallback.
  let embeddedAppObserved = false;
  let browserFallback: ReturnType<typeof setTimeout> | undefined;
  const inventorySnapshots = new DeviceInventorySnapshotCache(deviceInventorySnapshotTTLMS, now);
  const cancelBrowserFallback = () => {
    if (browserFallback) clearTimeout(browserFallback);
    browserFallback = undefined;
  };
  const observeEmbeddedApp = () => {
    embeddedAppObserved = true;
    cancelBrowserFallback();
  };
  const scheduleBrowserFallback = () => {
    cancelBrowserFallback();
    if (embeddedAppObserved) return;
    browserFallback = setTimeout(() => {
      browserFallback = undefined;
      try {
        session.startRelay();
        session.openBrowser();
      } catch (error) {
        console.error(
          `Unable to open the SimView browser fallback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, browserFallbackDelayMs);
    browserFallback.unref?.();
  };
  server.server.onclose = () => {
    cancelBrowserFallback();
    inventorySnapshots.clear();
    unsubscribeAccessibilityResource();
  };
  const connectDevice = async (
    deviceId?: string,
    observationMode: "hybrid" | "semantic" = "semantic",
  ) => {
    const state = await session.open(deviceId, { startRelay: false, observationMode });
    return toolResult(`SimView is connected to ${state.device?.name}.`, state);
  };
  const listDevices = async (options: DeviceListOptions = {}) => {
    if (options.cursor) {
      if (
        options.availableOnly !== undefined ||
        options.platform !== undefined ||
        options.offset !== undefined ||
        options.limit !== undefined
      ) {
        throw new Error("Continuing device inventory requires only its cursor");
      }
      const snapshot = inventorySnapshots.continue(options.cursor);
      const devices = snapshot.devices.slice(snapshot.offset, snapshot.offset + snapshot.limit);
      const nextOffset = snapshot.offset + devices.length;
      const hasMore = nextOffset < snapshot.devices.length;
      const nextCursor = hasMore
        ? inventorySnapshots.create({ ...snapshot, offset: nextOffset })
        : undefined;
      const page = {
        devices,
        inventoryTotal: snapshot.inventoryTotal,
        total: snapshot.total,
        returned: devices.length,
        offset: snapshot.offset,
        limit: snapshot.limit,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        ...(snapshot.truncated ? { snapshotTruncated: true } : {}),
      };
      return toolResult(
        `Found ${page.total} matching device${page.total === 1 ? "" : "s"}; returned ${page.returned}.`,
        page,
      );
    }
    const inventory = await deviceProvider();
    if ((options.offset ?? 0) > 0) {
      const page = deviceListPage(inventory, options);
      const label = options.availableOnly === false ? "matching" : "available";
      return toolResult(
        `Found ${page.total} ${label} device${page.total === 1 ? "" : "s"}; returned ${page.returned}.`,
        page,
      );
    }
    const sorted = sortedDeviceInventory(inventory, options);
    const retained = sorted.slice(0, DEVICE_INVENTORY_RETAINED_LIMIT);
    const limit = Math.max(1, Math.min(DEVICE_PAGE_LIMIT, options.limit ?? 10));
    const devices = retained.slice(0, limit);
    const nextOffset = devices.length;
    const hasMore = nextOffset < retained.length;
    const snapshotTruncated = retained.length < sorted.length;
    const nextCursor = hasMore
      ? inventorySnapshots.create({
          devices: retained,
          inventoryTotal: inventory.length,
          total: sorted.length,
          limit,
          offset: nextOffset,
          truncated: snapshotTruncated,
        })
      : undefined;
    const page = {
      devices,
      inventoryTotal: inventory.length,
      total: sorted.length,
      returned: devices.length,
      offset: 0,
      limit,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      ...(snapshotTruncated ? { snapshotTruncated: true } : {}),
    };
    const label = options.availableOnly === false ? "matching" : "available";
    return toolResult(
      `Found ${page.total} ${label} device${page.total === 1 ? "" : "s"}; returned ${page.returned}.`,
      page,
    );
  };
  const takeScreenshot = async () => {
    const screenshot = await session.screenshot();
    return {
      content: [
        {
          type: "image" as const,
          data: Buffer.from(screenshot.bytes).toString("base64"),
          mimeType: "image/png" as const,
        },
        {
          type: "text" as const,
          text: `Captured frame ${screenshot.frameId} at ${screenshot.width}×${screenshot.height}.`,
        },
      ],
      structuredContent: {
        frameId: screenshot.frameId,
        width: screenshot.width,
        height: screenshot.height,
      },
    };
  };
  const observationHistory = new Map<
    string,
    { hash: string; index: SemanticIndex; sessionKey: string }
  >();
  const observe = async ({
    mode = "semantic",
    sinceObservationId,
    afterRevision,
    afterVisualRevision,
    postAction,
    settleQuietMs = 75,
    maxWaitMs = 500,
  }: {
    mode?: "auto" | "semantic" | "visual" | undefined;
    sinceObservationId?: string | undefined;
    afterRevision?: string | undefined;
    afterVisualRevision?: number | undefined;
    postAction?: { beforeSemanticHash?: string | undefined };
    settleQuietMs?: number | undefined;
    maxWaitMs?: number | undefined;
  }) => {
    const includeVision = mode === "visual";
    const accessibilityPromise = session
      .accessibilityObserve({
        afterRevision,
        scope: "interactive",
        maxNodes: 1_200,
        settleQuietMs,
        maxWaitMs,
      })
      .then((value) => ({ value }))
      .catch((error: unknown) => ({ error }));
    const visualPromise = includeVision
      ? session.warmObservation({
          visual: true,
          afterRevision: afterVisualRevision,
          settleQuietMs,
          maxWaitMs,
        })
      : Promise.resolve(undefined);
    const [accessibilityOutcome, visualResult] = await Promise.all([
      accessibilityPromise,
      visualPromise,
    ]);
    let visualObservation = visualResult;
    const firstAccessibility =
      "value" in accessibilityOutcome ? accessibilityOutcome.value : undefined;
    const accessibilityError =
      "error" in accessibilityOutcome ? accessibilityOutcome.error : undefined;
    if (!includeVision && accessibilityError) {
      visualObservation = await session
        .warmObservation({ visual: false, maxWaitMs: 0 })
        .catch(() => undefined);
    }
    let accessibilityObservation: AccessibilityObservation | undefined = firstAccessibility;
    let forcedRetry = false;
    const visualChanged =
      afterVisualRevision !== undefined &&
      visualObservation !== undefined &&
      visualObservation.changeRevision > afterVisualRevision;
    if (
      postAction?.beforeSemanticHash &&
      accessibilityObservation &&
      semanticHashForSnapshot(accessibilityObservation.snapshot) ===
        postAction.beforeSemanticHash &&
      (accessibilityObservation.eventChanged || visualChanged)
    ) {
      forcedRetry = true;
      try {
        accessibilityObservation = await session.accessibilityObserve({
          scope: "interactive",
          maxNodes: 1_200,
          settleQuietMs,
          maxWaitMs: 0,
        });
      } catch {
        // Keep the first bounded result when the forced retry is unavailable.
      }
    }
    if (!accessibilityObservation && session.lastAccessibility) {
      accessibilityObservation = {
        snapshot: session.lastAccessibility,
        revision: session.accessibilityRevision ?? session.lastAccessibility.snapshotId,
        eventChanged: false,
        stable: true,
        timedOut: false,
        strategy:
          session.lastAccessibility.source === "android-agent-shell"
            ? "android-shell-dump"
            : "snapshot-diff",
        settledAt: session.lastAccessibility.capturedAt,
      };
    }
    const warm: WarmObservation =
      visualObservation ??
      ({
        observationId: `accessibility-${accessibilityObservation?.revision ?? "unavailable"}`,
        frameId: session.frameId ?? "accessibility",
        frameRevision: 0,
        changeRevision: 0,
        imageRevision: 0,
        capturedAt: accessibilityObservation?.snapshot.capturedAt ?? new Date().toISOString(),
        settledAt: accessibilityObservation?.settledAt ?? new Date().toISOString(),
        stable: accessibilityObservation?.stable ?? false,
        ageMs: 0,
        width: accessibilityObservation?.snapshot.screen.width ?? 0,
        height: accessibilityObservation?.snapshot.screen.height ?? 0,
        byteLength: 0,
        imageIncluded: false,
        cacheHit: false,
      } satisfies WarmObservation);
    let result: ElementTreeOutput | undefined;
    let snapshot: z.output<typeof accessibilitySnapshotSchema> | undefined;
    let semanticError: z.output<typeof semanticErrorSchema> | undefined;
    let index: SemanticIndex = new Map();
    let hash: string | undefined;
    try {
      result = await session.preparedElementSnapshot(240);
      if (!accessibilityObservation) {
        throw accessibilityError ?? new Error("Accessibility observation is unavailable");
      }
      snapshot = accessibilityObservation.snapshot;
      if (!snapshot) throw new Error("Semantic observation did not produce accessibility state");
      index = indexSemantics(snapshot);
      hash = semanticHash(index);
    } catch (error) {
      semanticError = {
        code: "semantic_inspection_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      };
    }

    const sessionKey = `${session.connectionGeneration}:${session.device?.id ?? "disconnected"}`;
    const candidatePrevious = sinceObservationId
      ? observationHistory.get(sinceObservationId)
      : undefined;
    const previous = candidatePrevious?.sessionKey === sessionKey ? candidatePrevious : undefined;
    const delta = previous && hash ? semanticDelta(previous.index, index) : undefined;
    const semanticStatus = !hash
      ? ("unavailable" as const)
      : !previous
        ? ("full" as const)
        : previous.hash === hash
          ? ("unchanged" as const)
          : ("delta" as const);
    let postActionEvent: "changed" | "timed_out" | "unavailable" | undefined;
    if (postAction) {
      if (!accessibilityObservation) postActionEvent = "unavailable";
      else if (accessibilityObservation.timedOut) postActionEvent = "timed_out";
      else if (accessibilityObservation.eventChanged) postActionEvent = "changed";
      else postActionEvent = "timed_out";
    }
    let postActionSemantic: "changed" | "unchanged" | "unconfirmed" | "unavailable" | undefined;
    if (postAction) {
      if (!hash) postActionSemantic = "unavailable";
      else if (postAction.beforeSemanticHash === undefined) postActionSemantic = "changed";
      else if (hash !== postAction.beforeSemanticHash) postActionSemantic = "changed";
      else if (forcedRetry || visualChanged || accessibilityObservation?.eventChanged) {
        postActionSemantic = "unconfirmed";
      } else {
        postActionSemantic = "unchanged";
      }
    }
    const observationId = randomUUID();
    if (hash) {
      observationHistory.set(observationId, { hash, index, sessionKey });
      while (observationHistory.size > 8) {
        const oldest = observationHistory.keys().next().value;
        if (oldest === undefined) break;
        observationHistory.delete(oldest);
      }
    }
    const visionReason = includeVision
      ? "explicit-visual-mode"
      : semanticError
        ? "semantic-unavailable-vision-not-requested"
        : "semantic-mode";
    const text = semanticError
      ? `Semantic inspection unavailable: ${semanticError.message}`
      : semanticStatus === "unchanged"
        ? `Semantic state unchanged (${hash?.slice(0, 12)}).`
        : semanticStatus === "delta"
          ? `Semantic delta: +${delta?.added.length ?? 0} -${delta?.removed.length ?? 0} ~${delta?.changed.length ?? 0}.`
          : result
            ? compactElementTree(result, snapshot)
            : "No semantic state is available.";
    const changedRefs = new Set([...(delta?.added ?? []), ...(delta?.changed ?? [])]);
    const semanticNodes = snapshot
      ? flattenAccessibilityTree(snapshot.root)
          .filter(
            (node) =>
              semanticStatus === "full" ||
              (semanticStatus === "delta" && changedRefs.has(node.ref)),
          )
          .map(summarizeAccessibilityNode)
      : undefined;
    const structuredContent = {
      observationId,
      frameId: warm.frameId,
      sourceRevisions: {
        frame: warm.frameRevision,
        visualChange: warm.changeRevision,
        image: warm.imageRevision,
        accessibility: accessibilityObservation?.revision,
        fiber: result?.snapshot.snapshotId,
      },
      timestamps: {
        frameCapturedAt: warm.capturedAt,
        settledAt: warm.settledAt,
        accessibilityReadyAt: accessibilityObservation?.settledAt,
        fiberReadyAt: result?.snapshot.capturedAt,
        imageReadyAt: warm.imageReadyAt,
        mcpReturnedAt: new Date().toISOString(),
      },
      stability: {
        stable: warm.stable && (accessibilityObservation?.stable ?? false),
        ageMs: warm.ageMs,
      },
      cache: { imageHit: warm.cacheHit, fiberHit: false },
      semantic: {
        hash,
        status: semanticStatus,
        nodeCount: index.size,
        truncated: snapshot?.stats.truncated ?? false,
        ...(semanticStatus === "delta" ? delta : {}),
        ...(semanticStatus === "full" || semanticStatus === "delta"
          ? { nodes: semanticNodes }
          : {}),
      },
      vision: {
        included: Boolean(includeVision && warm.image),
        reason: visionReason,
        mimeType: includeVision && warm.image ? ("image/jpeg" as const) : undefined,
        returnedBytes: includeVision ? (warm.image?.byteLength ?? 0) : 0,
      },
      screenContext: result?.screenContext,
      fallback: result?.fallback,
      semanticError,
      ...(postAction
        ? {
            postAction: {
              accessibility: {
                event: postActionEvent,
                semantic: postActionSemantic,
                revision: accessibilityObservation?.revision,
                strategy: accessibilityObservation?.strategy,
                stable: accessibilityObservation?.stable ?? false,
                forcedRetry,
                ...(visualChanged ? { visualChanged: true } : {}),
                ...(accessibilityObservation?.fallbackUsed !== undefined
                  ? { fallbackUsed: accessibilityObservation.fallbackUsed }
                  : {}),
                ...(accessibilityObservation?.captureCount !== undefined
                  ? { captureCount: accessibilityObservation.captureCount }
                  : {}),
                ...(accessibilityObservation?.changeSource
                  ? { changeSource: accessibilityObservation.changeSource }
                  : {}),
                ...(hash ? { resourceUri: session.accessibilityResourceUri } : {}),
              },
            },
          }
        : {}),
    };
    return {
      content: [
        ...(includeVision && warm.image
          ? [
              {
                type: "image" as const,
                data: Buffer.from(warm.image).toString("base64"),
                mimeType: "image/jpeg" as const,
              },
            ]
          : []),
        { type: "text" as const, text },
      ],
      structuredContent,
    };
  };
  const dispatchAction = async (action: z.output<typeof actionSchema>) => {
    switch (action.type) {
      case "tap":
        return session.dispatchInput({
          method: "input.tap",
          params: { x: action.x, y: action.y },
        });
      case "long_press":
        return session.dispatchInput({
          method: "input.longPress",
          params: { x: action.x, y: action.y, durationMs: action.durationMs },
        });
      case "swipe":
        return session.dispatchInput({
          method: "input.swipe",
          params: { from: action.from, to: action.to, durationMs: action.durationMs },
        });
      case "type_text":
        return session.dispatchInput({ method: "input.typeText", params: { text: action.text } });
      case "press_button":
        return session.dispatchInput({
          method: "input.button",
          params: { button: action.button },
        });
      case "set_orientation":
        session.requireCapability("orientation", "Orientation changes");
        return session.requireClient().request("device.orientation.set", {
          orientation: action.orientation,
        });
      case "gesture":
        return session.dispatchInput({
          method: "input.gesture",
          params: { tracks: action.tracks },
        });
      case "tap_element": {
        let selector: z.output<typeof accessibilitySelectorSchema>;
        if (action.query) {
          const search = await session.searchElements({
            query: action.query,
            actionableOnly: true,
            visibleOnly: true,
            limit: 5,
          });
          const winner = unambiguousInteractionSearchMatch(search);
          if (!winner) {
            return {
              accepted: false,
              code: "ambiguous_target",
              retryable: false,
              candidates: search.matches,
              excludedExactMatchCount: search.excludedExactMatchCount,
              excludedCandidateCount: search.excludedCandidateCount,
              excludedCandidates: search.excludedCandidates,
            };
          }
          selector = accessibilitySelectorSchema.parse({
            ref: winner.element.ref,
          });
        } else {
          selector = accessibilitySelectorSchema.parse(action);
        }
        const resolution = await session.resolveNativeTap(selector);
        if (!resolution.accepted || !resolution.point) {
          return { ...resolution, interaction: resolution };
        }
        const verificationBaseline = action.verifyDestination
          ? await captureObservationBaseline(session)
          : undefined;
        const receipt = await session.dispatchInput({
          method: "input.tap",
          params: resolution.point,
        });
        const destinationVerification = action.verifyDestination
          ? await session.verifyNativeDestination(action.verifyDestination, {
              afterRevision: verificationBaseline?.afterRevision,
              maxWaitMs: action.verifyDestination.timeoutMs,
            })
          : undefined;
        const verificationWarnings = destinationVerificationWarnings(destinationVerification);
        return {
          ...receipt,
          accepted: destinationVerification ? destinationVerification.verified : true,
          safeToContinue: destinationVerification ? destinationVerification.verified : true,
          inputDispatched: true,
          ...(destinationVerification && !destinationVerification.verified
            ? {
                code:
                  destinationVerification.status === "mismatch"
                    ? "destination_mismatch"
                    : destinationVerification.status === "ambiguous"
                      ? "destination_ambiguous"
                      : "destination_unconfirmed",
                retryable:
                  destinationVerification.status === "unstable" ||
                  destinationVerification.status === "unavailable",
              }
            : {}),
          interaction: resolution,
          ...(destinationVerification ? { destinationVerification } : {}),
          ...(verificationWarnings.length ? { verificationWarnings } : {}),
        };
      }
      case "wait_for_element": {
        const selector = accessibilitySelectorSchema.parse(action);
        const result = await session.requireClient().request("accessibility.wait", {
          ...(session.device?.id ? { deviceId: session.device.id } : {}),
          ...(session.device?.udid ? { udid: session.device.udid } : {}),
          selector,
          state: action.state,
          timeoutMs: action.timeoutMs,
        });
        // Refresh once so the match becomes the current semantic cache for the next action.
        await session.accessibilitySnapshot();
        return result;
      }
    }
  };

  server.registerTool(
    "open_simview",
    {
      title: "Open SimView",
      description:
        "Open the interactive preview for an already-connected device session. " +
        "Call connect_device first and continue only when it succeeds.",
      inputSchema: {
        deviceId: z.string().min(1).optional(),
        udid: z.string().min(1).optional(),
      },
      outputSchema: sessionStateSchema,
      _meta: metadata.openPreview,
    },
    async ({ deviceId, udid }, context) => {
      const appCapable = supportsMcpApps(server, context, environment);
      const requestedDevice = deviceId ?? udid;
      if (!session.client || session.client.connected === false || !session.device) {
        throw new Error(
          "No healthy device session is connected; call connect_device before opening the preview",
        );
      }
      if (
        requestedDevice &&
        requestedDevice !== session.device.id &&
        requestedDevice !== session.device.udid
      ) {
        throw new Error("open_simview cannot switch devices; call connect_device first");
      }
      const state = session.state();
      await session.enablePreview(true);
      if (appCapable) observeEmbeddedApp();
      else scheduleBrowserFallback();
      return toolResult(`SimView is connected to ${state.device?.name}.`, state);
    },
  );

  server.registerTool(
    "connect_device",
    {
      title: "Connect device",
      description: "Start or select a device session without opening the interactive preview.",
      inputSchema: {
        deviceId: z.string().min(1).optional(),
        observationMode: z.enum(["hybrid", "semantic"]).default("semantic"),
      },
      outputSchema: sessionStateSchema,
      _meta: metadata.modelOnly,
    },
    ({ deviceId, observationMode }) => connectDevice(deviceId, observationMode),
  );

  server.registerTool(
    "app_connect_device",
    {
      title: "Switch device",
      description: "Switch the device used by the open SimView preview.",
      inputSchema: { deviceId: z.string().min(1).optional() },
      outputSchema: sessionStateSchema,
      _meta: metadata.appOnly,
    },
    ({ deviceId }) => connectDevice(deviceId),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description:
        "List available local devices by default. Continue a stable first-page snapshot with nextCursor; offset remains available for compatibility.",
      inputSchema: {
        availableOnly: z.boolean().optional(),
        platform: z.enum(["ios", "android"]).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(DEVICE_PAGE_LIMIT).optional(),
        cursor: z.string().min(1).max(128).optional(),
      },
      outputSchema: deviceListSchema,
      _meta: metadata.modelOnly,
    },
    (options) => listDevices(options),
  );

  server.registerTool(
    "app_list_devices",
    {
      title: "List devices",
      description:
        "List one bounded snapshot page of devices for the open SimView preview and continue with its cursor.",
      inputSchema: {
        availableOnly: z.boolean().optional(),
        platform: z.enum(["ios", "android"]).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(DEVICE_PAGE_LIMIT).optional(),
        cursor: z.string().min(1).max(128).optional(),
      },
      outputSchema: deviceListSchema,
      _meta: metadata.appOnly,
    },
    (options) =>
      listDevices(
        options.cursor ? options : { ...options, availableOnly: options.availableOnly ?? false },
      ),
  );

  registerInputTools(server, session);
  server.registerTool(
    "observe_screen",
    {
      title: "Observe screen",
      description:
        "Read prepared semantic state without waiting for an image. Use visual mode only when the user explicitly requests visual inspection.",
      inputSchema: {
        mode: z.enum(["auto", "semantic", "visual"]).default("semantic"),
        sinceObservationId: z.string().uuid().optional(),
      },
      outputSchema: observeOutputSchema,
    },
    ({ mode, sinceObservationId }) => observe({ mode, sinceObservationId }),
  );
  server.registerTool(
    "perform_actions",
    {
      title: "Perform actions",
      description:
        "Execute up to 20 ordered device actions, wait for post-action stability, and return one prepared observation. For entity-sensitive tap_element actions, verifyDestination requires one unique native identity and accepts up to four supporting assertions plus a 100-5000 ms timeout (maximum 5000). Assertions must be present but may match more than one node; an ambiguous identity hard-stops later actions.",
      inputSchema: {
        actions: z.array(actionSchema).min(1).max(20),
        observe: z.enum(["auto", "semantic", "visual", "none"]).default("semantic"),
        settleQuietMs: z.number().int().min(20).max(500).default(75),
        maxWaitMs: z.number().int().min(0).max(5_000).default(500),
      },
      outputSchema: z.object({
        actionCount: z.number().int().min(1).max(20),
        completedActionCount: z.number().int().min(0).max(20),
        failedActionIndex: z.number().int().min(0).max(19).optional(),
        durationMs: z.number().nonnegative(),
        receipts: z.array(genericObjectOutputSchema),
        observation: observeOutputSchema.optional(),
      }),
    },
    async ({ actions, observe: observationMode, settleQuietMs, maxWaitMs }) => {
      const started = performance.now();
      const baseline =
        observationMode === "none" ? undefined : await captureObservationBaseline(session);
      const receipts: unknown[] = [];
      let failedActionIndex: number | undefined;
      for (const [index, action] of actions.entries()) {
        try {
          const receipt = await dispatchAction(action);
          receipts.push(receipt);
          if (
            receipt !== null &&
            typeof receipt === "object" &&
            "accepted" in receipt &&
            receipt.accepted === false
          ) {
            failedActionIndex = index;
            break;
          }
        } catch (error) {
          failedActionIndex = index;
          receipts.push({
            accepted: false,
            code: error instanceof Error ? error.message : "action_rejected",
            retryable: false,
          });
          break;
        }
      }
      const hardStop = receipts.some(
        (receipt) =>
          receipt !== null &&
          typeof receipt === "object" &&
          "safeToContinue" in receipt &&
          receipt.safeToContinue === false,
      );
      if (observationMode === "none") {
        return toolResult(
          failedActionIndex === undefined
            ? "Ordered actions completed."
            : "Action batch stopped after a rejected action.",
          {
            actionCount: actions.length,
            completedActionCount: failedActionIndex ?? receipts.length,
            ...(failedActionIndex !== undefined ? { failedActionIndex } : {}),
            durationMs: performance.now() - started,
            receipts,
          },
          hardStop,
        );
      }
      const observed = await observe({
        mode: observationMode,
        afterRevision: baseline?.afterRevision,
        afterVisualRevision: baseline?.afterVisualRevision,
        postAction: { beforeSemanticHash: baseline?.beforeSemanticHash },
        settleQuietMs,
        maxWaitMs,
      });
      const finalReceipt = receipts.at(-1);
      const finalVerification =
        finalReceipt !== null &&
        typeof finalReceipt === "object" &&
        "destinationVerification" in finalReceipt
          ? (finalReceipt.destinationVerification as DestinationVerification)
          : undefined;
      const reconciledObservation = reconcileObservationWithDestination(
        observeOutputSchema.parse(observed.structuredContent),
        finalVerification,
      );
      return toolResultWithContent(
        observed.content,
        {
          actionCount: actions.length,
          completedActionCount: failedActionIndex ?? receipts.length,
          ...(failedActionIndex !== undefined ? { failedActionIndex } : {}),
          durationMs: performance.now() - started,
          receipts,
          observation: reconciledObservation,
        },
        hardStop,
      );
    },
  );
  registerAppBridgeTools(server, session, metadata);
  registerAccessibilityTools(server, session, metadata, observe);
  registerAnnotationTools(server, session, metadata);

  server.registerTool(
    "take_screenshot",
    {
      title: "Take screenshot",
      description:
        "Observe the selected device as a PNG. Use its pixel positions to choose normalized coordinates for tap, swipe, or long_press, then observe again.",
      inputSchema: {},
      outputSchema: screenshotOutputSchema,
      _meta: metadata.modelOnly,
    },
    takeScreenshot,
  );

  server.registerTool(
    "app_take_screenshot",
    {
      title: "Capture preview screenshot",
      description: "Capture a screenshot from the open SimView preview.",
      inputSchema: {},
      outputSchema: screenshotOutputSchema,
      _meta: metadata.appOnly,
    },
    takeScreenshot,
  );

  server.registerTool(
    "get_simview_state",
    {
      title: "Get SimView state",
      description: "Get the current device, stream, frame, route context, and annotation count.",
      inputSchema: {},
      outputSchema: sessionStateSchema,
      _meta: metadata.modelOnly,
    },
    async () => toolResult("Current SimView state.", session.state()),
  );

  server.registerTool(
    "set_orientation",
    {
      title: "Set orientation",
      description: "Rotate the selected device when its capabilities allow orientation changes.",
      inputSchema: {
        orientation: z.enum([
          "portrait",
          "portrait-upside-down",
          "landscape-left",
          "landscape-right",
        ]),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ orientation }) => {
      session.requireCapability("orientation", "Orientation changes");
      const result = session.requireClient().request("device.orientation.set", { orientation });
      return result.then((value) => toolResult("Device orientation accepted.", value));
    },
  );

  const readPreviewResource = async (uri = new URL(metadata.resourceUri)) => {
    observeEmbeddedApp();
    const html = await appHtml(session.state());
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            "openai/widgetMinFrameHeight": 600,
            "openai/widgetPrefersBorder": false,
          },
        },
      ],
    };
  };

  server.registerResource(
    "SimView preview",
    metadata.resourceUri,
    {
      description: "Interactive local iOS Simulator or Android device preview and review surface.",
    },
    readPreviewResource,
  );

  server.registerResource(
    "SimView review preview",
    new ResourceTemplate(`ui://simview/${VERSION}/reviews/{reviewId}/preview.html`, {
      list: undefined,
    }),
    {
      description: "Interactive local iOS Simulator or Android device preview and review surface.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri, variables) => {
      z.string().uuid().parse(variables.reviewId);
      return readPreviewResource(uri);
    },
  );

  server.registerResource(
    "SimView accessibility tree",
    session.accessibilityResourceUri,
    {
      description: "The latest settled accessibility tree for this SimView review.",
      mimeType: "application/json",
    },
    async (uri) => {
      const resource = accessibilityResourceSchema.parse(await session.accessibilityResource());
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(resource),
          },
        ],
      };
    },
  );

  return server;
}

function registerAccessibilityTools(
  server: McpServer,
  session: SimViewSession,
  metadata: ResourceMetadata,
  observe: (input: {
    mode?: "auto" | "semantic" | "visual" | undefined;
    afterRevision?: string | undefined;
    afterVisualRevision?: number | undefined;
    postAction?: { beforeSemanticHash?: string | undefined };
    settleQuietMs?: number | undefined;
    maxWaitMs?: number | undefined;
  }) => Promise<{
    content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" }
    >;
    structuredContent: Record<string, unknown>;
  }>,
): void {
  const selectorSchema = {
    ref: z.string().optional(),
    identifier: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    exact: z.boolean().default(true),
    index: z.number().int().min(0).optional(),
  };
  const tapElementInputSchema = {
    ...selectorSchema,
    query: z.string().trim().min(1).max(200).optional(),
    verifyDestination: destinationVerificationInputSchema.optional(),
    observe: z.enum(["semantic", "visual", "none"]).default("semantic"),
    settleQuietMs: z.number().int().min(20).max(500).default(75),
    maxWaitMs: z.number().int().min(0).max(5_000).default(500),
  };
  const getAccessibilityTree = async (
    scope: "interactive" | "visible" | "full",
    maxNodes: number,
  ) => {
    const snapshot = await session.accessibilitySnapshot(scope, maxNodes);
    return toolResult(compactAccessibilityTree(snapshot), snapshot);
  };
  const getElementTree = async (scope: "interactive" | "visible" | "full", maxNodes: number) => {
    const result = await session.elementSnapshot(scope, maxNodes);
    return toolResult(compactElementTree(result), result);
  };
  let pageCache: ElementTreePageCache | undefined;
  server.registerTool(
    "app_get_element_tree_page",
    {
      title: "Get preview element tree page",
      description:
        "Read one bounded page of the React Native Fiber or accessibility hierarchy for the open SimView preview.",
      inputSchema: {
        action: z.enum(["start", "continue"]),
        source: z.enum(["elements", "accessibility"]).optional(),
        scope: z.enum(["interactive", "visible", "full"]).optional(),
        maxNodes: z.number().int().min(1).max(5_000).optional(),
        cursor: z.string().max(128).optional(),
      },
      outputSchema: elementTreePageSchema,
      _meta: metadata.appOnly,
    },
    async ({ action, source, scope, maxNodes, cursor }) => {
      let pageIndex = 0;
      if (action === "continue") {
        if (!cursor || source || scope || maxNodes !== undefined) {
          throw new Error("Continuing an element tree transfer requires only its cursor");
        }
        if (
          !pageCache ||
          Date.now() >= pageCache.expiresAt ||
          pageCache.deviceId !== session.device?.id ||
          pageCache.connectionGeneration !== session.connectionGeneration
        ) {
          pageCache = undefined;
          throw new Error("Element tree page cursor is invalid or expired");
        }
        pageIndex = pageCache.cursors.indexOf(cursor);
        if (pageIndex <= 0) throw new Error("Element tree page cursor is invalid or expired");
      } else {
        if (cursor) throw new Error("Starting an element tree transfer does not accept a cursor");
        const captureScope = scope ?? "full";
        const nodeLimit = maxNodes ?? 1_200;
        const result =
          source === "accessibility"
            ? await session.accessibilityElementSnapshot(captureScope, nodeLimit)
            : await session.elementSnapshot(captureScope, nodeLimit);
        const validated = elementTreeOutputSchema.parse(result);
        const bytes = Buffer.from(JSON.stringify(validated), "utf8");
        if (bytes.byteLength > ELEMENT_TREE_TRANSFER_MAX_BYTES) {
          throw new Error(
            `Element tree is ${bytes.byteLength} bytes; the preview limit is ${ELEMENT_TREE_TRANSFER_MAX_BYTES}`,
          );
        }
        const pageCount = Math.ceil(bytes.byteLength / ELEMENT_TREE_PAGE_RAW_BYTES);
        pageCache = {
          transferId: randomUUID(),
          deviceId: session.device?.id,
          connectionGeneration: session.connectionGeneration,
          expiresAt: Date.now() + ELEMENT_TREE_TRANSFER_TTL_MS,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          cursors: Array.from({ length: pageCount }, () => randomBytes(32).toString("base64url")),
        };
      }
      if (!pageCache) throw new Error("Element tree page cache is unavailable");
      const page = elementTreePage(pageCache, pageIndex);
      return toolResult(
        `Element tree transfer page ${page.pageIndex + 1} of ${page.pageCount}.`,
        page,
      );
    },
  );
  const tapElement = async (selector: unknown) => {
    const input = z.object(tapElementInputSchema).parse(selector);
    let parsedSelector: z.output<typeof accessibilitySelectorSchema>;
    if (input.query) {
      const search = await session.searchElements({
        query: input.query,
        actionableOnly: true,
        visibleOnly: true,
        limit: 5,
      });
      const winner = unambiguousInteractionSearchMatch(search);
      if (!winner) {
        return toolResult("The semantic query is ambiguous; no tap was sent.", {
          candidates: search.matches,
          count: search.total,
          excludedExactMatchCount: search.excludedExactMatchCount,
          excludedCandidateCount: search.excludedCandidateCount,
          excludedCandidates: search.excludedCandidates,
          tapped: false,
        });
      }
      parsedSelector = accessibilitySelectorSchema.parse({
        ref: winner.element.ref,
      });
    } else {
      parsedSelector = accessibilitySelectorSchema.parse(input);
    }
    const resolution = await session.resolveNativeTap(parsedSelector);
    if (!resolution.accepted || !resolution.point || !resolution.target) {
      const message =
        resolution.code === "target_offscreen"
          ? `The target is offscreen. Scroll ${resolution.suggestedScrollDirection ?? "toward it"}, then search and resolve it again; no tap was sent.`
          : "The semantic target was not confirmed natively; no tap was sent.";
      return toolResult(message, { ...resolution, selector: parsedSelector });
    }
    if (!session.device?.capabilities.input.touch) {
      throw new Error("Tap is not supported by the selected device");
    }
    const baseline =
      input.observe === "none" && !input.verifyDestination
        ? undefined
        : await captureObservationBaseline(session);
    const receipt = await session.dispatchInput({ method: "input.tap", params: resolution.point });
    const observed =
      input.observe === "none"
        ? undefined
        : await observe({
            mode: input.observe,
            afterRevision: baseline?.afterRevision,
            afterVisualRevision: baseline?.afterVisualRevision,
            postAction: { beforeSemanticHash: baseline?.beforeSemanticHash },
            settleQuietMs: input.settleQuietMs,
            maxWaitMs: input.maxWaitMs,
          });
    const destinationVerification = input.verifyDestination
      ? await session.verifyNativeDestination(input.verifyDestination, {
          afterRevision: baseline?.afterRevision,
          settleQuietMs: input.settleQuietMs,
          maxWaitMs: input.verifyDestination.timeoutMs,
        })
      : undefined;
    const verificationFailed = destinationVerification && !destinationVerification.verified;
    const verificationWarnings = destinationVerificationWarnings(destinationVerification);
    const verificationCode =
      destinationVerification?.status === "mismatch"
        ? "destination_mismatch"
        : destinationVerification?.status === "ambiguous"
          ? "destination_ambiguous"
          : "destination_unconfirmed";
    const reconciledObservation = observed
      ? reconcileObservationWithDestination(
          observeOutputSchema.parse(observed.structuredContent),
          destinationVerification,
        )
      : undefined;
    const structured = {
      ...resolution,
      accepted: !verificationFailed,
      code: verificationFailed ? verificationCode : resolution.code,
      retryable: verificationFailed
        ? destinationVerification?.status === "unstable" ||
          destinationVerification?.status === "unavailable"
        : false,
      inputDispatched: true,
      safeToContinue: !verificationFailed,
      interaction: resolution,
      selector: parsedSelector,
      receipt,
      ...(reconciledObservation ? { observation: reconciledObservation } : {}),
      ...(destinationVerification ? { destinationVerification } : {}),
      ...(verificationWarnings.length ? { verificationWarnings } : {}),
    };
    const text = destinationVerification
      ? destinationVerification.verified
        ? "Physical element tap accepted and destination identity verified."
        : destinationVerification.status === "ambiguous"
          ? `Physical element tap was sent, but destination verification was ambiguous. ${verificationWarnings[0] ?? "Use a more specific selector."} Do not continue with consequential actions.`
          : "Physical element tap was sent, but the requested destination identity was not verified. Do not continue with consequential actions."
      : "Physical element tap accepted.";
    return observed
      ? toolResultWithContent(
          [
            ...observed.content.filter((item) => item.type !== "text"),
            { type: "text" as const, text },
          ],
          structured,
          Boolean(verificationFailed),
        )
      : toolResult(text, structured, Boolean(verificationFailed));
  };
  const inspectPoint = async (x: number, y: number) => {
    const accessibility = await session.inspectPoint(x, y);
    const status = session.device?.capabilities.uikitProbe
      ? await session.probeStatus()
      : undefined;
    const native = status?.connected ? await session.probeInspectPoint(x, y) : undefined;
    return toolResult("Element context at the requested point.", {
      element: accessibility,
      native,
      probe: status,
    });
  };
  const getUiContext = async () => {
    session.requireCapability("uikitProbe", "UIKit probe");
    const status = await session.probeStatus();
    const target = status.connected ? undefined : await session.probeTarget();
    const context = status.connected ? await session.probeContext() : undefined;
    return toolResult(
      status.connected
        ? "UIKit probe context."
        : "UIKit probe is not enabled; accessibility remains available.",
      { status, context, target },
    );
  };
  const enableUiProbe = async (bundleId: string) =>
    toolResult(
      "The target app relaunched and connected to the UIKit probe.",
      await session.enableProbe(bundleId),
    );

  server.registerTool(
    "get_element_tree",
    {
      title: "Get element tree",
      description:
        "Read the React Native visual Fiber tree when a matching Metro target is available, otherwise return the native device accessibility tree.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: elementTreeOutputSchema,
      _meta: metadata.modelOnly,
    },
    ({ scope, maxNodes }) => getElementTree(scope, maxNodes),
  );

  server.registerTool(
    "app_get_element_tree",
    {
      title: "Get preview element tree",
      description:
        "Read the React Native Fiber or accessibility hierarchy for the open SimView preview.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: elementTreeOutputSchema,
      _meta: metadata.appOnly,
    },
    ({ scope, maxNodes }) => getElementTree(scope, maxNodes),
  );

  server.registerTool(
    "get_accessibility_tree",
    {
      title: "Get accessibility tree",
      description:
        "Read the selected device accessibility hierarchy without taking another screenshot.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: accessibilitySnapshotSchema,
      _meta: metadata.modelOnly,
    },
    ({ scope, maxNodes }) => getAccessibilityTree(scope, maxNodes),
  );

  server.registerTool(
    "app_get_accessibility_tree",
    {
      title: "Get preview accessibility tree",
      description: "Read the accessibility hierarchy for the open SimView preview.",
      inputSchema: {
        scope: z.enum(["interactive", "visible", "full"]).default("interactive"),
        maxNodes: z.number().int().min(1).max(1_200).default(1_200),
      },
      outputSchema: accessibilitySnapshotSchema,
      _meta: metadata.appOnly,
    },
    ({ scope, maxNodes }) => getAccessibilityTree(scope, maxNodes),
  );

  server.registerTool(
    "find_elements",
    {
      title: "Find elements",
      description:
        "Find React Native or accessible elements by identifier, role, name, value, or a generation-scoped ref.",
      inputSchema: selectorSchema,
      outputSchema: findElementsOutputSchema,
    },
    async (selector) => {
      const result = await session.findElements(accessibilitySelectorSchema.parse(selector));
      return toolResult(`Matched ${result.count} accessible element(s).`, result);
    },
  );
  server.registerTool(
    "search_elements",
    {
      title: "Search elements",
      description:
        "Search the current semantic tree with a natural-language query and return bounded ranked matches. Use the winning ref with tap_element; this tool never captures or returns an image.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        roles: z.array(z.string().trim().min(1)).max(10).optional(),
        actionableOnly: z.boolean().default(true),
        visibleOnly: z.boolean().default(true),
        limit: z.number().int().min(1).max(20).default(10),
      },
      outputSchema: searchElementsOutputSchema,
      _meta: metadata.modelOnly,
    },
    async (query) => {
      const result = await session.searchElements(elementSearchQuerySchema.parse(query));
      return toolResult(
        `Matched ${result.total} semantic element(s); returned ${result.count} ranked result(s).`,
        result,
      );
    },
  );

  server.registerTool(
    "tap_element",
    {
      title: "Tap element",
      description:
        "Re-resolve one React Native or accessible element, validate it, and physically tap its visible center through native device input. For entity-sensitive navigation, verifyDestination requires a unique native identity, accepts up to four supporting assertions, and has a 100-5000 ms timeout (maximum 5000). Assertions such as amount/status must be present but may match multiple nodes. Prefer a stable identifier or complete entity label for identity, and use exact:false only for a known composite-label fragment.",
      inputSchema: tapElementInputSchema,
      outputSchema: genericObjectOutputSchema,
      _meta: metadata.modelOnly,
    },
    tapElement,
  );

  server.registerTool(
    "app_tap_element",
    {
      title: "Tap preview element",
      description: "Re-resolve and physically tap an element selected in the open preview.",
      inputSchema: tapElementInputSchema,
      outputSchema: genericObjectOutputSchema,
      _meta: metadata.appOnly,
    },
    tapElement,
  );

  server.registerTool(
    "inspect_point",
    {
      title: "Inspect point",
      description: "Return the deepest accessible element at a normalized device coordinate.",
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      },
      outputSchema: inspectPointOutputSchema,
      _meta: metadata.modelOnly,
    },
    ({ x, y }) => inspectPoint(x, y),
  );

  server.registerTool(
    "app_inspect_point",
    {
      title: "Inspect preview point",
      description: "Return element context at a point selected in the open preview.",
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      },
      outputSchema: inspectPointOutputSchema,
      _meta: metadata.appOnly,
    },
    ({ x, y }) => inspectPoint(x, y),
  );

  server.registerTool(
    "get_ui_context",
    {
      title: "Get UI context",
      description:
        "Get the optional UIKit probe status and active scene, window, and controller hierarchy.",
      inputSchema: {},
      outputSchema: uiContextSchema,
      _meta: metadata.modelOnly,
    },
    getUiContext,
  );

  server.registerTool(
    "app_get_ui_context",
    {
      title: "Get preview UI context",
      description: "Get optional UIKit probe context for the open preview.",
      inputSchema: {},
      outputSchema: uiContextSchema,
      _meta: metadata.appOnly,
    },
    getUiContext,
  );

  server.registerTool(
    "enable_ui_probe",
    {
      title: "Enable UIKit probe",
      description:
        "Explicitly terminate and relaunch one third-party Simulator app with SimView's bundled read-only UIKit probe.",
      inputSchema: {
        bundleId: z
          .string()
          .min(3)
          .max(255)
          .refine((value) => !value.startsWith("com.apple."), {
            message: "Apple platform applications cannot load the UIKit probe",
          }),
      },
      outputSchema: genericObjectOutputSchema,
      _meta: metadata.modelOnly,
    },
    ({ bundleId }) => enableUiProbe(bundleId),
  );

  server.registerTool(
    "app_enable_ui_probe",
    {
      title: "Enable preview UIKit probe",
      description: "Enable the optional UIKit probe from the open preview.",
      inputSchema: {
        bundleId: z
          .string()
          .min(3)
          .max(255)
          .refine((value) => !value.startsWith("com.apple."), {
            message: "Apple platform applications cannot load the UIKit probe",
          }),
      },
      outputSchema: genericObjectOutputSchema,
      _meta: metadata.appOnly,
    },
    ({ bundleId }) => enableUiProbe(bundleId),
  );

  server.registerTool(
    "wait_for_element",
    {
      title: "Wait for element",
      description: "Wait for a semantic element to appear or disappear without model-side polling.",
      inputSchema: {
        ...selectorSchema,
        state: z.enum(["visible", "hidden"]).default("visible"),
        timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
      },
      outputSchema: waitOutputSchema,
    },
    async ({ state, timeoutMs, ...selector }) => {
      const started = performance.now();
      const parsedSelector = accessibilitySelectorSchema.parse(selector);
      const result = await session.requireClient().request("accessibility.wait", {
        deviceId: session.device?.id,
        udid: session.device?.udid,
        selector: parsedSelector,
        state,
        timeoutMs,
      });
      return toolResult(`Element is ${state}.`, {
        durationMs: performance.now() - started,
        ...result,
      });
    },
  );
}

function registerInputTools(server: McpServer, session: SimViewSession): void {
  const input = async (value: unknown) => {
    const parsed = relayInputSchema.parse(value);
    const result = await session.dispatchInput(parsed);
    return toolResult("Device input accepted.", result);
  };
  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: "Tap a normalized device coordinate.",
      inputSchema: { x: z.number().min(0).max(1), y: z.number().min(0).max(1) },
      outputSchema: acceptedOutputSchema,
    },
    ({ x, y }) => input({ method: "input.tap", params: { x, y } }),
  );
  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: "Swipe between normalized device coordinates.",
      inputSchema: {
        from: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
        to: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
        durationMs: z.number().int().min(50).max(10_000).default(350),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ from, to, durationMs }) =>
      input({ method: "input.swipe", params: { from, to, durationMs } }),
  );
  server.registerTool(
    "perform_gesture",
    {
      title: "Perform gesture",
      description:
        "Perform one or two normalized timestamped pointer tracks (up to five seconds and 120 total samples).",
      inputSchema: { tracks: gestureTracksSchema },
      outputSchema: acceptedOutputSchema,
    },
    ({ tracks }) => input({ method: "input.gesture", params: { tracks } }),
  );
  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description: "Hold a normalized device coordinate.",
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        durationMs: z.number().int().min(100).max(10_000).default(600),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ x, y, durationMs }) => input({ method: "input.longPress", params: { x, y, durationMs } }),
  );
  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Type text at the selected device's declared ASCII or Unicode capability level.",
      inputSchema: { text: z.string().max(10_000) },
      outputSchema: acceptedOutputSchema,
    },
    ({ text }) => input({ method: "input.typeText", params: { text } }),
  );
  server.registerTool(
    "press_button",
    {
      title: "Press button",
      description: "Press a supported device hardware or navigation button.",
      inputSchema: {
        button: z.enum(["home", "back", "overview", "lock", "volume-up", "volume-down", "action"]),
      },
      outputSchema: acceptedOutputSchema,
    },
    ({ button }) => input({ method: "input.button", params: { button } }),
  );
}

function registerAppBridgeTools(
  server: McpServer,
  session: SimViewSession,
  metadata: ResourceMetadata,
): void {
  server.registerTool(
    "save_review_images",
    {
      title: "Save review images",
      description:
        "Persist the frozen frame and annotation crops in a session-owned temporary directory.",
      inputSchema: saveReviewImagesInputSchema,
      outputSchema: saveReviewImagesOutputSchema,
      _meta: metadata.appOnly,
    },
    async (input) => ({
      content: [],
      structuredContent: await session.saveReviewImages(input),
    }),
  );

  server.registerTool(
    "get_preview_packets",
    {
      title: "Read preview packets",
      description: "Read a bounded batch of H.264 preview packets for the embedded SimView app.",
      inputSchema: {
        afterSequence: z.number().int().min(0).optional(),
        maxPackets: z.number().int().min(1).max(30).default(12),
        timeoutMs: z.number().int().min(50).max(5_000).default(1_500),
      },
      outputSchema: previewPacketBatchSchema,
      _meta: metadata.appOnly,
    },
    async ({ afterSequence, maxPackets, timeoutMs }) => {
      const batch = await session.previewPackets(afterSequence, maxPackets, timeoutMs);
      return {
        content: [],
        structuredContent: {
          reset: batch.reset,
          configuration: batch.configuration
            ? Buffer.from(batch.configuration).toString("base64")
            : undefined,
          packets: batch.packets.map((packet) => ({
            sequence: packet.sequence,
            kind: packet.kind,
            data: Buffer.from(packet.payload).toString("base64"),
          })),
          nextSequence: batch.nextSequence,
        },
      };
    },
  );

  const registerDeviceInput = (name: "device_input" | "simulator_input", legacy: boolean) =>
    server.registerTool(
      name,
      {
        title: legacy ? "Send simulator input" : "Send device input",
        description: legacy
          ? "Compatibility alias for device_input."
          : "Forward an input event from the embedded SimView app to the selected device.",
        inputSchema: {
          method: z.enum([
            "input.touch",
            "input.tap",
            "input.longPress",
            "input.swipe",
            "input.gesture",
            "input.button",
            "input.typeText",
          ]),
          params: z.record(z.string(), z.unknown()),
        },
        outputSchema: acceptedOutputSchema,
        _meta: metadata.appOnly,
      },
      async ({ method, params }) => {
        const parsed = relayInputSchema.parse({ method, params });
        const result = await session.dispatchInput(parsed);
        return {
          content: [],
          structuredContent: result,
        };
      },
    );
  registerDeviceInput("device_input", false);
  registerDeviceInput("simulator_input", true);
}

function registerAnnotationTools(
  server: McpServer,
  session: SimViewSession,
  metadata: ResourceMetadata,
): void {
  server.registerTool(
    "add_annotation",
    {
      title: "Add annotation",
      description:
        "Add a comment at a normalized point or rectangular region on the current simulator frame.",
      inputSchema: {
        geometry: annotationGeometrySchema,
        note: z.string().min(1).max(2_000),
        frameId: z.string().optional(),
        route: z.string().optional(),
        component: z
          .object({
            testID: z.string().optional(),
            label: z.string().optional(),
            source: z.string().optional(),
          })
          .optional(),
        context: annotationContextSchema.optional(),
      },
      outputSchema: annotationSchema,
      _meta: metadata.modelOnly,
    },
    async (input) => {
      const annotation = session.addAnnotation(input);
      return toolResult("Added screen annotation.", annotation);
    },
  );

  server.registerTool(
    "update_annotation",
    {
      title: "Update annotation",
      description: "Edit an existing annotation in the current review.",
      inputSchema: {
        id: z.string().uuid(),
        note: z.string().min(1).max(2_000).optional(),
        geometry: annotationGeometrySchema.optional(),
      },
      outputSchema: annotationSchema,
      _meta: metadata.appOnly,
    },
    async ({ id, ...patch }) =>
      toolResult("Annotation updated.", session.updateAnnotation(id, patch)),
  );

  server.registerTool(
    "delete_annotation",
    {
      title: "Delete annotation",
      description: "Delete an annotation from the current review.",
      inputSchema: { id: z.string().uuid() },
      outputSchema: z.object({ deleted: z.boolean(), id: z.string().uuid() }),
      _meta: metadata.appOnly,
    },
    async ({ id }) =>
      toolResult("Annotation deleted.", { deleted: session.deleteAnnotation(id), id }),
  );
}

async function appHtml(initialState: SessionState): Promise<string> {
  const root = resolveAppRoot();
  const templatePath = join(root, "dist", "preview.html");
  const scriptPath = join(root, "dist", "preview.js");
  const [template, script] = await Promise.all([
    readFile(templatePath, "utf8"),
    readFile(scriptPath, "utf8"),
  ]);
  return inlineAppModule(template, script, initialState);
}

function structuredJson(structuredContent: unknown) {
  const json = jsonObjectSchema.parse(JSON.parse(JSON.stringify(structuredContent)));
  return json;
}

function toolResultWithContent<T>(content: T, structuredContent: unknown, isError = false) {
  return {
    content,
    structuredContent: structuredJson(structuredContent),
    ...(isError ? { isError: true } : {}),
  };
}

function toolResult(text: string, structuredContent: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structuredJson(structuredContent),
    ...(isError ? { isError: true } : {}),
  };
}

export async function runServer(): Promise<void> {
  const parentPID = process.ppid;
  const sessions = new Set<SimViewSession>();
  let handle: ReturnType<typeof serveStdio> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const terminate = () => {
    void shutdown().then(() => process.exit(0));
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      clearInterval(parentWatchdog);
      process.stdin.off("end", shutdown);
      process.stdin.off("close", shutdown);
      process.off("SIGINT", terminate);
      process.off("SIGTERM", terminate);
      process.off("disconnect", terminate);
      await Promise.all([...sessions].map((session) => session.close().catch(() => {})));
      await handle?.close().catch(() => {});
    })();
    return shutdownPromise;
  };
  const parentWatchdog = setInterval(() => {
    if (parentPID <= 1) {
      void shutdown();
      return;
    }
    try {
      process.kill(parentPID, 0);
    } catch {
      void shutdown();
    }
  }, 2_000);
  parentWatchdog.unref();
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  process.once("disconnect", terminate);
  handle = serveStdio(
    () => {
      const session = new SimViewSession();
      sessions.add(session);
      const server = createServer(session);
      const onclose = server.server.onclose;
      server.server.onclose = () => {
        onclose?.();
        sessions.delete(session);
        void session.close();
      };
      return server;
    },
    {
      onerror: () => void shutdown(),
    },
  );
}

function supportsMcpApps(
  server: McpServer,
  context: { mcpReq: { envelope?: unknown } },
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const envelope = asRecord(context.mcpReq.envelope);
  return (
    [
      envelope?.clientCapabilities,
      envelope?.[CLIENT_CAPABILITIES_META_KEY],
      server.server.getClientCapabilities(),
    ].some(hasMcpUiCapability) || isDesktopMcpAppHost(environment)
  );
}

export function hasMcpUiCapability(capabilities: unknown): boolean {
  const record = asRecord(capabilities);
  if (!record) return false;
  return [record, asRecord(record.extensions), asRecord(record.experimental)].some(
    (candidate) => candidate && "io.modelcontextprotocol/ui" in candidate,
  );
}

export function isDesktopMcpAppHost(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  // Claude Desktop currently launches plugin MCP servers through Claude Code without
  // forwarding its outer MCP Apps capability. The entrypoint is inherited by the
  // child server and distinguishes that path from terminal Claude Code.
  return environment.CLAUDE_CODE_ENTRYPOINT === "claude-desktop";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
