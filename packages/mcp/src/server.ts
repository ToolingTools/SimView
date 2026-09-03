import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { compactAccessibilityTree } from "@simview/client";
import {
  accessibilityNodeSchema,
  accessibilityObservationStrategySchema,
  accessibilityResourceSchema,
  accessibilitySelectorSchema,
  accessibilitySnapshotSchema,
  accessibilitySnapshotSourceSchema,
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
  inputKeyModifierSchema,
  inputKeySchema,
  inputReceiptSchema,
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
  semanticSearchTextSchema,
  sessionStateSchema,
  summarizeAccessibilityNode,
  uiContextSchema,
} from "@simview/contracts";
import { z } from "zod";
import { inlineAppModule } from "./app-html";
import { dispatchSemanticTextAction } from "./semantic-interactions";
import {
  indexSemanticSnapshot,
  type SemanticSnapshotIndex,
  semanticObservationHash,
  semanticSnapshotDelta,
} from "./semantic-state";
import {
  type AccessibilityObservation,
  type DestinationVerification,
  inputReceiptFromError,
  type NativeTapResolution,
  nativeTapRecovery,
  rejectedInputReceipt,
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

function resourceMetadata(reviewId: string, version = VERSION) {
  const resourceUri = `ui://simview/${version}/reviews/${reviewId}/preview.html`;
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
      ? semanticObservationHash(indexSemanticSnapshot(session.lastAccessibility))
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

const fallbackDetailMessages = {
  "metro-unreachable": "Metro was not reachable on the packaged bridge's discovery ports.",
  "metro-running-no-debug-targets": "Metro is running, but it exposed no compatible debug targets.",
  "metro-target-mismatch": "Metro targets were found, but none matched the connected device.",
  "metro-fiber-root-missing": "The matching debug target exposed no React Native Fiber root.",
  "metro-connect-or-evaluate-failed":
    "The matching debug target could not be connected to or inspected.",
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
      : `context=${context.kind} elements=${snapshot.source}${result.fallback ? ` fallback=${result.fallback.reason}${result.fallback.detail ? ` detail=${result.fallback.detail}` : ""}` : ""}`;
  const fallback = result.fallback
    ? result.fallback.detail
      ? fallbackDetailMessages[result.fallback.detail]
      : fallbackMessages[result.fallback.reason]
    : undefined;
  return [summary, fallback, compactAccessibilityTree(snapshot)].filter(Boolean).join("\n");
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
  searchScope: z.literal("current-rendered-tree"),
  absenceConclusive: z.literal(false),
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
  elementSource: z
    .union([accessibilitySnapshotSourceSchema, z.literal("react-native-fiber")])
    .optional(),
  metroStatus: z
    .enum([
      "active",
      "metro-target-unavailable",
      "metro-fiber-unavailable",
      "metro-inspection-failed",
    ])
    .optional(),
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
    resourceUri: z.string().optional(),
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
        "Native accessible name expected on the destination. This uses label/title and falls back to non-redacted text values, which is common for Android TextView nodes. Prefer a distinctive complete name; avoid generic labels such as Card.",
      )
      .optional(),
    value: z
      .string()
      .min(1)
      .describe(
        "Native AX value expected on the destination. Use this when observe/search explicitly exposed the content as a value.",
      )
      .optional(),
    placeholder: z
      .string()
      .min(1)
      .describe("Native placeholder expected on an empty editable destination field.")
      .optional(),
    checked: z
      .boolean()
      .describe("Required checked state for a checkbox, radio control, or switch.")
      .optional(),
    selected: z
      .boolean()
      .describe("Required selected state for a selectable control or tab.")
      .optional(),
    enabled: z
      .boolean()
      .describe("Required enabled state for an independently identifiable destination control.")
      .optional(),
    exact: z
      .boolean()
      .default(true)
      .describe(
        "Exact matching is the default. Set false only for a known fragment of a composite native label, such as #30363063 within Invoice #30363063.",
      ),
  })
  .strict()
  .refine(
    (selector) =>
      Boolean(
        selector.identifier ||
          selector.role ||
          selector.name ||
          selector.value ||
          selector.placeholder ||
          selector.checked !== undefined ||
          selector.enabled !== undefined ||
          selector.selected !== undefined,
      ),
    {
      message:
        "A destination selector requires identifier, role, name, value, placeholder, checked, selected, or enabled",
    },
  );

const destinationVerificationInputSchema = z
  .object({
    identity: destinationSelectorSchema.describe(
      "Optional proof of a known post-navigation destination, not a requirement for every tap in a sensitive workflow. Never copy the tapped control's label or use a generic section/action label such as Invoices, Orders, Card, or Pay. Omit verifyDestination for generic navigation and rely on the stable semantic post-action observation. When used, identity must match exactly one destination node; prefer a unique identifier or complete entity label.",
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
  })
  .strict();

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

const semanticSelectorFields = {
  ref: z.string().min(1).optional(),
  identifier: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  placeholder: z.string().min(1).optional(),
  exact: z.boolean().default(true),
  index: z.number().int().min(0).optional(),
};

function containsUnsupportedTextControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

const actionSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("tap"), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .strict(),
  z
    .object({
      type: z.literal("long_press"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      durationMs: z.number().int().min(100).max(5_000).default(600),
    })
    .strict(),
  z
    .object({
      type: z.literal("swipe"),
      from: normalizedPointSchema,
      to: normalizedPointSchema,
      durationMs: z.number().int().min(50).max(5_000).default(350),
    })
    .strict(),
  z.object({ type: z.literal("type_text"), text: z.string().max(10_000) }).strict(),
  z
    .object({
      type: z.literal("press_key"),
      key: inputKeySchema,
      modifiers: z.array(inputKeyModifierSchema).max(4).optional(),
      repeat: z.number().int().min(1).max(100).default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("press_button"),
      button: z.enum(["home", "back", "overview", "lock", "volume-up", "volume-down", "action"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_orientation"),
      orientation: z.enum([
        "portrait",
        "portrait-upside-down",
        "landscape-left",
        "landscape-right",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("gesture"),
      tracks: gestureTracksSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("tap_element"),
      ...semanticSelectorFields,
      query: semanticSearchTextSchema.optional(),
      verifyDestination: destinationVerificationInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wait_for_element"),
      ...semanticSelectorFields,
      state: z.enum(["visible", "hidden"]).default("visible"),
      timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("clear_text"),
      ...semanticSelectorFields,
    })
    .strict(),
  z
    .object({
      type: z.literal("replace_text"),
      ...semanticSelectorFields,
      text: z.string().max(10_000),
    })
    .strict(),
]);

type SemanticSelectorInput = {
  ref?: string | undefined;
  identifier?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  placeholder?: string | undefined;
  exact?: boolean | undefined;
  index?: number | undefined;
};

function accessibilitySelectorFromInput(
  input: SemanticSelectorInput,
): z.output<typeof accessibilitySelectorSchema> {
  return accessibilitySelectorSchema.parse({
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.identifier ? { identifier: input.identifier } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.value ? { value: input.value } : {}),
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
    exact: input.exact ?? true,
    ...(input.index !== undefined ? { index: input.index } : {}),
  });
}

type ActionPreflightFailure = {
  index: number;
  code: "invalid_action" | "reused_generation_ref" | "special_key_requires_press_key";
  message: string;
};

function preflightActions(
  actions: z.output<typeof actionSchema>[],
): ActionPreflightFailure | undefined {
  const generationRefs = new Map<string, number>();
  for (const [index, action] of actions.entries()) {
    if (action.type === "type_text" && containsUnsupportedTextControl(action.text)) {
      return {
        index,
        code: "special_key_requires_press_key",
        message:
          "type_text accepts literal printable text only; use press_key for Return, Tab, or Delete",
      };
    }
    if (
      action.type === "tap_element" ||
      action.type === "wait_for_element" ||
      action.type === "clear_text" ||
      action.type === "replace_text"
    ) {
      const hasSelector = Boolean(
        action.ref ||
          action.identifier ||
          action.role ||
          action.name ||
          action.value ||
          action.placeholder,
      );
      if (action.type === "tap_element" && action.query && hasSelector) {
        return {
          index,
          code: "invalid_action",
          message: "tap_element accepts either query or selector fields, not both",
        };
      }
      if (!hasSelector && !(action.type === "tap_element" && action.query)) {
        return {
          index,
          code: "invalid_action",
          message: `${action.type} requires query or a supported selector field`,
        };
      }
      if (action.ref && /^(?:ax|rn):/u.test(action.ref)) {
        const firstIndex = generationRefs.get(action.ref);
        if (firstIndex !== undefined) {
          return {
            index,
            code: "reused_generation_ref",
            message: `Generation-scoped ref was already used by action ${firstIndex}`,
          };
        }
        generationRefs.set(action.ref, index);
      }
    }
  }
  return undefined;
}

function rejectedDispatchedAction(error: unknown) {
  return inputReceiptFromError(error);
}

const DISPATCHED_INPUT_HARD_STOP =
  "HARD STOP — INPUT WAS DISPATCHED. No further device input may be sent until the user supplies new direction or an independent UI change occurs.";
const RAW_INPUT_RECEIPT_GUIDANCE =
  "Returns an explicit dispatch receipt. accepted:true means SimView submitted and acknowledged the input. If inputDispatched:true accompanies an error, the action may have reached the device: retryInput remains false, so reconnect and observe without replaying it.";

function rejectedSemanticTap(
  resolution: NativeTapResolution,
  selector?: z.output<typeof accessibilitySelectorSchema>,
) {
  const recovery =
    resolution.searchScope && resolution.candidates?.length === 0
      ? ({
          retryInput: false,
          recoveryAllowed: true,
          recoveryAction: "scroll_then_search",
        } as const)
      : nativeTapRecovery(resolution);
  return {
    accepted: false,
    safeToContinue: false,
    inputDispatched: false,
    code: resolution.code,
    retryable: resolution.retryable,
    ...recovery,
    interaction: {
      ...compactNativeTapResolution(resolution),
      ...(selector ? { selector } : {}),
    },
  } as const;
}

function compactNativeTapResolution(resolution: NativeTapResolution) {
  const {
    target,
    hitNode,
    actionableHitNode,
    selectorDiagnostics,
    actionabilityDiagnostics,
    ...receipt
  } = resolution;
  return {
    ...receipt,
    ...(target ? { target: summarizeAccessibilityNode(target) } : {}),
    ...(hitNode ? { hitNode: summarizeAccessibilityNode(hitNode) } : {}),
    ...(actionableHitNode
      ? { actionableHitNode: summarizeAccessibilityNode(actionableHitNode) }
      : {}),
    ...(selectorDiagnostics
      ? {
          selectorDiagnostics: {
            ...selectorDiagnostics,
            fields: selectorDiagnostics.fields.map((field) => ({
              ...field,
              matches: field.matches.map(summarizeAccessibilityNode),
            })),
          },
        }
      : {}),
    ...(actionabilityDiagnostics
      ? {
          actionabilityDiagnostics: {
            ...actionabilityDiagnostics,
            candidates: actionabilityDiagnostics.candidates.map((candidate) => ({
              ...candidate,
              node: summarizeAccessibilityNode(candidate.node),
            })),
          },
        }
      : {}),
  };
}

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
    { name: "simview", version: session.resourceVersion ?? VERSION },
    { capabilities: { resources: { subscribe: true } } },
  );
  const metadata = resourceMetadata(session.reviewId, session.resourceVersion);
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
    let accessibilityMessage = "";
    if (state.iosAccessibility?.status === "enhanced-ready") {
      accessibilityMessage = " XCTest is the active iOS accessibility provider.";
    } else if (state.device?.platform === "ios") {
      accessibilityMessage =
        " XCTest could not start, so SimView is using the built-in Simulator AX fallback.";
    }
    return toolResult(
      `SimView is connected to ${state.device?.name}.${accessibilityMessage}`,
      state,
    );
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
    { hash: string; index: SemanticSnapshotIndex; sessionKey: string }
  >();
  const observe = async ({
    mode = "semantic",
    sinceObservationId,
    afterRevision,
    afterVisualRevision,
    postAction,
    verifiedAccessibility,
    settleQuietMs = 75,
    maxWaitMs = 500,
  }: {
    mode?: "auto" | "semantic" | "visual" | undefined;
    sinceObservationId?: string | undefined;
    afterRevision?: string | undefined;
    afterVisualRevision?: number | undefined;
    postAction?: { beforeSemanticHash?: string | undefined };
    verifiedAccessibility?: AccessibilityObservation | undefined;
    settleQuietMs?: number | undefined;
    maxWaitMs?: number | undefined;
  }) => {
    const includeVision = mode === "visual";
    const accessibilityPromise = verifiedAccessibility
      ? Promise.resolve({ value: verifiedAccessibility })
      : session
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
      postAction &&
      accessibilityObservation &&
      (!accessibilityObservation.stable ||
        (postAction.beforeSemanticHash !== undefined &&
          semanticObservationHash(indexSemanticSnapshot(accessibilityObservation.snapshot)) ===
            postAction.beforeSemanticHash &&
          (accessibilityObservation.eventChanged || visualChanged)))
    ) {
      forcedRetry = true;
      try {
        accessibilityObservation = await session.accessibilityObserve({
          scope: "interactive",
          maxNodes: 1_200,
          settleQuietMs,
          maxWaitMs: 0,
          requireChange: false,
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
    let index: SemanticSnapshotIndex = new Map();
    let hash: string | undefined;
    try {
      result = await session.preparedElementSnapshot(240);
      if (!accessibilityObservation) {
        throw accessibilityError ?? new Error("Accessibility observation is unavailable");
      }
      snapshot = accessibilityObservation.snapshot;
      if (!snapshot) throw new Error("Semantic observation did not produce accessibility state");
      index = indexSemanticSnapshot(snapshot);
      hash = semanticObservationHash(index);
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
    const delta = previous && hash ? semanticSnapshotDelta(previous.index, index) : undefined;
    let semanticStatus: "unavailable" | "full" | "unchanged" | "delta";
    if (!hash) semanticStatus = "unavailable";
    else if (!previous) semanticStatus = "full";
    else if (previous.hash === hash) semanticStatus = "unchanged";
    else semanticStatus = "delta";
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
    let postActionEvent: "changed" | "timed_out" | "unavailable" | undefined;
    if (postAction) {
      if (!accessibilityObservation) postActionEvent = "unavailable";
      else if (postActionSemantic === "changed") postActionEvent = "changed";
      else if (accessibilityObservation.timedOut) postActionEvent = "timed_out";
      else if (accessibilityObservation.eventChanged) postActionEvent = "changed";
      else postActionEvent = "timed_out";
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
    let visionReason:
      | "explicit-visual-mode"
      | "semantic-unavailable-vision-not-requested"
      | "semantic-mode";
    if (includeVision) visionReason = "explicit-visual-mode";
    else if (semanticError) visionReason = "semantic-unavailable-vision-not-requested";
    else visionReason = "semantic-mode";

    let text: string;
    if (semanticError) {
      text = `Semantic inspection unavailable: ${semanticError.message}`;
    } else if (semanticStatus === "unchanged") {
      text = `Semantic state unchanged (${hash?.slice(0, 12)}).`;
    } else if (semanticStatus === "delta") {
      text = `Semantic delta: +${delta?.added.length ?? 0} -${delta?.removed.length ?? 0} ~${delta?.changed.length ?? 0}.`;
    } else if (result) {
      text = compactElementTree(result, snapshot);
    } else {
      text = "No semantic state is available.";
    }
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
      elementSource: result?.snapshot.source,
      metroStatus:
        result?.snapshot.source === "react-native-fiber"
          ? ("active" as const)
          : result?.fallback?.reason,
      sourceRevisions: {
        frame: warm.frameRevision,
        visualChange: warm.changeRevision,
        image: warm.imageRevision,
        accessibility: accessibilityObservation?.revision,
        fiber:
          result?.snapshot.source === "react-native-fiber" ? result.snapshot.snapshotId : undefined,
      },
      timestamps: {
        frameCapturedAt: warm.capturedAt,
        settledAt: warm.settledAt,
        accessibilityReadyAt: accessibilityObservation?.settledAt,
        fiberReadyAt:
          result?.snapshot.source === "react-native-fiber" ? result.snapshot.capturedAt : undefined,
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
        ...(hash ? { resourceUri: session.accessibilityResourceUri } : {}),
        ...(semanticStatus === "delta" ? delta : {}),
        ...(semanticStatus === "delta" ? { nodes: semanticNodes } : {}),
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
    const acceptedInput = async (input: z.output<typeof relayInputSchema>) => {
      const receipt = await session.dispatchInputReceipt(input);
      return receipt.accepted ? { ...receipt, interaction: receipt } : receipt;
    };
    switch (action.type) {
      case "tap":
        return acceptedInput({
          method: "input.tap",
          params: { x: action.x, y: action.y },
        });
      case "long_press":
        return acceptedInput({
          method: "input.longPress",
          params: { x: action.x, y: action.y, durationMs: action.durationMs },
        });
      case "swipe":
        return acceptedInput({
          method: "input.swipe",
          params: { from: action.from, to: action.to, durationMs: action.durationMs },
        });
      case "type_text":
        return acceptedInput({ method: "input.typeText", params: { text: action.text } });
      case "press_key":
        return acceptedInput({
          method: "input.key",
          params: {
            key: action.key,
            ...(action.modifiers ? { modifiers: action.modifiers } : {}),
            repeat: action.repeat,
          },
        });
      case "press_button":
        return acceptedInput({
          method: "input.button",
          params: { button: action.button },
        });
      case "set_orientation":
        session.requireCapability("orientation", "Orientation changes");
        return session
          .requireClient()
          .request("device.orientation.set", {
            orientation: action.orientation,
          })
          .then((receipt) => ({
            ...receipt,
            accepted: true,
            safeToContinue: true,
            inputDispatched: true,
            interaction: receipt,
          }));
      case "gesture":
        return acceptedInput({
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
            return rejectedSemanticTap({
              accepted: false,
              code: "ambiguous_target",
              retryable: false,
              searchScope: "current-rendered-tree",
              absenceConclusive: false,
              candidates: search.matches,
              excludedExactMatchCount: search.excludedExactMatchCount,
              excludedCandidateCount: search.excludedCandidateCount,
              excludedCandidates: search.excludedCandidates,
            } as NativeTapResolution);
          }
          selector = accessibilitySelectorSchema.parse({
            ref: winner.element.ref,
          });
        } else {
          selector = accessibilitySelectorFromInput(action);
        }
        const resolution = await session.resolveNativeTap(selector);
        if (!resolution.accepted || !resolution.point) {
          return rejectedSemanticTap(resolution, selector);
        }
        const verificationBaseline = action.verifyDestination
          ? await captureObservationBaseline(session)
          : undefined;
        const receipt = await session.dispatchInputReceipt({
          method: "input.tap",
          params: resolution.point,
        });
        if (!receipt.accepted) {
          return {
            ...receipt,
            interaction: compactNativeTapResolution(resolution),
          };
        }
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
                retryInput: false,
              }
            : {}),
          interaction: compactNativeTapResolution(resolution),
          ...(destinationVerification ? { destinationVerification } : {}),
          ...(verificationWarnings.length ? { verificationWarnings } : {}),
        };
      }
      case "wait_for_element": {
        const selector = accessibilitySelectorFromInput(action);
        const result = await session.requireClient().request("accessibility.wait", {
          ...(session.device?.id ? { deviceId: session.device.id } : {}),
          ...(session.device?.udid ? { udid: session.device.udid } : {}),
          selector,
          state: action.state,
          timeoutMs: action.timeoutMs,
        });
        // Refresh once so the match becomes the current semantic cache for the next action.
        await session.accessibilitySnapshot();
        return { ...result, accepted: true, safeToContinue: true, inputDispatched: false };
      }
      case "clear_text":
      case "replace_text": {
        const selector = accessibilitySelectorFromInput(action);
        return dispatchSemanticTextAction(session, action, selector);
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
    "enable_ios_accessibility",
    {
      title: "Enable complete iOS accessibility",
      description:
        "Restart SimView's temporary XCTest accessibility session for the connected iOS Simulator if automatic startup fell back to AX. It activates, but does not relaunch, the foreground app and makes XCTest the authoritative semantic tree.",
      inputSchema: {
        bundleId: z
          .string()
          .min(3)
          .optional()
          .describe("Foreground app bundle ID; normally omit it"),
      },
      outputSchema: sessionStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      _meta: metadata.modelOnly,
    },
    async ({ bundleId }) => {
      const state = await session.enableIOSAccessibilityProvider(bundleId);
      return toolResult(
        `XCTest accessibility is active for ${state.iosAccessibility?.bundleId ?? state.device?.name}.`,
        state,
      );
    },
  );
  server.registerTool(
    "disable_ios_accessibility",
    {
      title: "Disable XCTest accessibility",
      description:
        "Stop the temporary XCTest accessibility session and return to the built-in Simulator AX provider.",
      inputSchema: {},
      outputSchema: sessionStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      _meta: metadata.modelOnly,
    },
    async () => {
      const state = await session.disableIOSAccessibilityProvider();
      return toolResult("The temporary XCTest accessibility session was stopped.", state);
    },
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
        "List available local devices by default. Omit platform unless the user explicitly requested iOS or Android: an unfiltered call discovers all available device types, while filtering prematurely can hide the only available device. Continue a stable first-page snapshot with nextCursor; offset remains available for compatibility.",
      inputSchema: {
        availableOnly: z.boolean().optional(),
        platform: z
          .enum(["ios", "android"])
          .optional()
          .describe(
            "Omit unless the user explicitly requested iOS or Android. An unfiltered call discovers all available device types; filtering prematurely can hide the only available device.",
          ),
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
        "List one bounded snapshot page of devices for the open SimView preview and continue with its cursor. Omit platform unless the user explicitly requested iOS or Android: an unfiltered call discovers all available device types, while filtering prematurely can hide the only available device.",
      inputSchema: {
        availableOnly: z.boolean().optional(),
        platform: z
          .enum(["ios", "android"])
          .optional()
          .describe(
            "Omit unless the user explicitly requested iOS or Android. An unfiltered call discovers all available device types; filtering prematurely can hide the only available device.",
          ),
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
        "Read prepared semantic state without waiting for an image. Full observations return compact text plus provenance and a semantic resource URI instead of duplicating the full tree in structured content; deltas include only changed node summaries. After compact semantics, get_accessibility_tree, and targeted searches leave state indeterminate, one read-only visual observation is permitted without a separate request; it cannot justify coordinate input while a semantic target exists or authorize consequential action.",
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
        "Execute up to 20 ordered device actions, wait for post-action stability, and return one prepared observation. Semantic tap receipts contain compact node summaries for both iOS and Android, followed by the stable compact post-action tree exactly once; consume that embedded tree instead of immediately calling observe_screen. verifyDestination is optional and only proves a known, distinctive post-navigation destination; do not attach it to every tap in a payment, invoice, order, or account flow. Never copy the tapped control's label or use a generic section/action label such as Invoices, Orders, Card, or Pay as destination identity. For generic navigation, omit verifyDestination and rely on the stable semantic post-action observation. When used, verification requires one unique native identity and accepts up to four supporting assertions plus a 100-5000 ms timeout (maximum 5000); name falls back to non-redacted native text, and checked/selected/enabled can verify exposed control state. Assertions must be present but may match more than one node; an ambiguous identity hard-stops later actions. HARD STOP — INPUT WAS DISPATCHED and retryInput:false prohibit further device input until new user direction or an independent UI change. When inputDispatched is false, follow recoveryAllowed and recoveryAction using the bounded actionability, hit, and selector diagnostics. tap_known_coordinate permits one automatic raw tap only at coordinateFallback.point when the original user request authorized the action; no separate confirmation is needed, but observe immediately afterward and never repeat it. Never derive fallback coordinates from hit diagnostics. Disabled, ambiguous, or other unresolved targets require a new semantic resolution, independent UI change, or user direction.",
      inputSchema: {
        actions: z.array(actionSchema).min(1).max(20),
        observe: z.enum(["auto", "semantic", "visual", "none"]).default("semantic"),
        settleQuietMs: z.number().int().min(20).max(500).default(75),
        maxWaitMs: z.number().int().min(0).max(5_000).default(500),
      },
      outputSchema: z.object({
        actionCount: z.number().int().min(1).max(20),
        completedActionCount: z.number().int().min(0).max(20),
        dispatchedActionCount: z.number().int().min(0).max(20),
        failedActionIndex: z.number().int().min(0).max(19).optional(),
        durationMs: z.number().nonnegative(),
        receipts: z.array(genericObjectOutputSchema),
        observation: observeOutputSchema.optional(),
      }),
    },
    async ({ actions, observe: observationMode, settleQuietMs, maxWaitMs }) => {
      const started = performance.now();
      const preflightFailure = preflightActions(actions);
      if (preflightFailure) {
        const receipt = {
          accepted: false,
          safeToContinue: false,
          inputDispatched: false,
          retryInput: false,
          recoveryAllowed: false,
          code: preflightFailure.code,
          retryable: false,
          message: preflightFailure.message,
        };
        return toolResult(
          "Action batch validation failed; no input was dispatched.",
          {
            actionCount: actions.length,
            completedActionCount: 0,
            dispatchedActionCount: 0,
            failedActionIndex: preflightFailure.index,
            durationMs: performance.now() - started,
            receipts: [receipt],
          },
          true,
        );
      }
      const baseline =
        observationMode === "none" ? undefined : await captureObservationBaseline(session);
      const receipts: unknown[] = [];
      let failedActionIndex: number | undefined;
      for (const [index, action] of actions.entries()) {
        try {
          const receipt = await dispatchAction(action);
          receipts.push(receipt);
          if (asRecord(receipt)?.accepted === false) {
            failedActionIndex = index;
            break;
          }
        } catch (error) {
          failedActionIndex = index;
          receipts.push(rejectedDispatchedAction(error));
          break;
        }
      }
      const receiptRecords = receipts.map(asRecord);
      let hardStop = receiptRecords.some((receipt) => receipt?.safeToContinue === false);
      const inputDispatched = receiptRecords.some((receipt) => receipt?.inputDispatched === true);
      const dispatchedActionCount = receiptRecords.filter(
        (receipt) => receipt?.inputDispatched === true,
      ).length;
      if (observationMode === "none" || !inputDispatched) {
        return toolResult(
          hardStop && inputDispatched
            ? `${DISPATCHED_INPUT_HARD_STOP} The action batch stopped after the failed action.`
            : failedActionIndex === undefined
              ? "Ordered actions completed."
              : "Action batch stopped after a rejected action.",
          {
            actionCount: actions.length,
            completedActionCount: failedActionIndex ?? receipts.length,
            dispatchedActionCount,
            ...(failedActionIndex !== undefined ? { failedActionIndex } : {}),
            durationMs: performance.now() - started,
            receipts,
          },
          hardStop,
        );
      }
      const finalAction = actions[receipts.length - 1];
      const finalReceiptBeforeObservation = asRecord(receipts.at(-1));
      const finalReceiptVerification = asRecord(finalReceiptBeforeObservation?.verification);
      const verifiedAccessibility =
        (finalAction?.type === "clear_text" || finalAction?.type === "replace_text") &&
        finalReceiptBeforeObservation?.accepted === true &&
        finalReceiptVerification?.stable === true
          ? session.latestAccessibilityObservation
          : undefined;
      const observed = await observe({
        mode: observationMode,
        afterRevision: baseline?.afterRevision,
        afterVisualRevision: baseline?.afterVisualRevision,
        postAction: { beforeSemanticHash: baseline?.beforeSemanticHash },
        verifiedAccessibility,
        settleQuietMs,
        maxWaitMs,
      });
      const finalReceipt = asRecord(receipts.at(-1));
      const finalVerification = finalReceipt?.destinationVerification
        ? (finalReceipt.destinationVerification as DestinationVerification)
        : undefined;
      const reconciledObservation = reconcileObservationWithDestination(
        observeOutputSchema.parse(observed.structuredContent),
        finalVerification,
      );
      if (!reconciledObservation.stability.stable) {
        hardStop = true;
        const finalIndex = receipts.length - 1;
        const prior = asRecord(receipts[finalIndex]);
        if (prior) {
          receipts[finalIndex] = {
            ...prior,
            accepted: false,
            safeToContinue: false,
            inputDispatched: true,
            code: "post_action_unconfirmed",
            retryable: true,
            retryInput: false,
            interaction: "interaction" in prior ? prior.interaction : prior,
          };
          failedActionIndex ??= finalIndex;
        }
      }
      return toolResultWithContent(
        [
          {
            type: "text" as const,
            text: hardStop
              ? `${DISPATCHED_INPUT_HARD_STOP} The action batch stopped after the failed action.`
              : "Ordered actions completed and the stable post-action observation follows.",
          },
          ...observed.content,
        ],
        {
          actionCount: actions.length,
          completedActionCount: failedActionIndex ?? receipts.length,
          dispatchedActionCount,
          ...(failedActionIndex !== undefined ? { failedActionIndex } : {}),
          durationMs: performance.now() - started,
          receipts,
          observation: reconciledObservation,
        },
        hardStop,
      );
    },
  );
  const semanticTextInputSchema = {
    ...semanticSelectorFields,
  };
  const runStandaloneSemanticAction = async (action: z.output<typeof actionSchema>) => {
    const failure = preflightActions([action]);
    if (failure) {
      return toolResult(
        "Semantic action validation failed; no input was dispatched.",
        {
          accepted: false,
          safeToContinue: false,
          inputDispatched: false,
          retryInput: false,
          recoveryAllowed: false,
          code: failure.code,
          retryable: false,
          message: failure.message,
        },
        true,
      );
    }
    try {
      const receipt = await dispatchAction(action);
      const failed = asRecord(receipt)?.accepted === false;
      return toolResult(
        failed ? "Semantic action was not confirmed." : "Semantic action accepted and verified.",
        receipt,
        failed,
      );
    } catch (error) {
      return toolResult(
        "Semantic action was rejected; no further action was attempted.",
        rejectedDispatchedAction(error),
        true,
      );
    }
  };
  server.registerTool(
    "clear_text",
    {
      title: "Clear text",
      description:
        "Focus an editable semantic target, clear its current text with native key input, and verify that it is empty.",
      inputSchema: semanticTextInputSchema,
      outputSchema: genericObjectOutputSchema,
    },
    (selector) =>
      runStandaloneSemanticAction(actionSchema.parse({ type: "clear_text", ...selector })),
  );
  server.registerTool(
    "replace_text",
    {
      title: "Replace text",
      description:
        "Focus and clear an editable semantic target, type replacement text, and verify its exact native value.",
      inputSchema: { ...semanticTextInputSchema, text: z.string().max(10_000) },
      outputSchema: genericObjectOutputSchema,
    },
    ({ text, ...selector }) =>
      runStandaloneSemanticAction(actionSchema.parse({ type: "replace_text", ...selector, text })),
  );
  server.registerTool(
    "press_key",
    {
      title: "Press key",
      description: `Press a named keyboard key. Use this for Return, Tab, Delete, Escape, or arrow-key navigation instead of embedding control characters in type_text. ${RAW_INPUT_RECEIPT_GUIDANCE}`,
      inputSchema: {
        key: inputKeySchema,
        modifiers: z.array(inputKeyModifierSchema).max(4).optional(),
        repeat: z.number().int().min(1).max(100).default(1),
      },
      outputSchema: inputReceiptSchema,
    },
    ({ key, modifiers, repeat }) =>
      runStandaloneSemanticAction(
        actionSchema.parse({ type: "press_key", key, modifiers, repeat }),
      ),
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
    const html = await appHtml(session.state(), session.appRoot);
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
  const selectorSchema = semanticSelectorFields;
  const tapElementInputSchema = {
    ...selectorSchema,
    query: semanticSearchTextSchema.optional(),
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
    const input = z.object(tapElementInputSchema).strict().parse(selector);
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
        const resolution = {
          accepted: false,
          code: "ambiguous_target",
          retryable: false,
          searchScope: "current-rendered-tree",
          absenceConclusive: false,
          candidates: search.matches,
          count: search.total,
          excludedExactMatchCount: search.excludedExactMatchCount,
          excludedCandidateCount: search.excludedCandidateCount,
          excludedCandidates: search.excludedCandidates,
        } as NativeTapResolution;
        const message =
          search.total === 0
            ? "No currently rendered semantic target matched; no tap was sent. This does not prove the item is absent from a scrollable list, table, or collection. Explore the surface with bounded one-swipe-at-a-time navigation and search each changed snapshot."
            : "The semantic query is ambiguous; no tap was sent.";
        return toolResult(message, rejectedSemanticTap(resolution), true);
      }
      parsedSelector = accessibilitySelectorSchema.parse({
        ref: winner.element.ref,
      });
    } else {
      parsedSelector = accessibilitySelectorFromInput(input);
    }
    const resolution = await session.resolveNativeTap(parsedSelector);
    if (!resolution.accepted || !resolution.point || !resolution.target) {
      const recovery = nativeTapRecovery(resolution);
      const message =
        resolution.code === "target_offscreen"
          ? `The target is offscreen. Scroll ${resolution.suggestedScrollDirection ?? "toward it"}, then search and resolve it again; no tap was sent.`
          : recovery.recoveryAction === "tap_known_coordinate"
            ? "The native hit-test did not confirm the semantic target, so no tap was sent. One coordinate fallback is permitted at coordinateFallback.point when the requested action is already authorized; observe immediately afterward and do not repeat it."
            : resolution.code === "target_not_found" &&
                resolution.selectorDiagnostics?.splitAcrossNodes
              ? "The selector fields matched different native nodes, but all fields must match one node. Use search_elements and pass the selected generation-scoped ref to tap_element; no tap was sent."
              : "The semantic target was not confirmed natively; no tap was sent.";
      return toolResult(message, rejectedSemanticTap(resolution, parsedSelector), true);
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
          observation: observed ? session.latestAccessibilityObservation : undefined,
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
    const observationUnconfirmed = Boolean(
      reconciledObservation && !reconciledObservation.stability.stable,
    );
    const hardStop = Boolean(verificationFailed || observationUnconfirmed);
    const structured = {
      accepted: !hardStop,
      code: verificationFailed
        ? verificationCode
        : observationUnconfirmed
          ? "post_action_unconfirmed"
          : resolution.code,
      retryable: verificationFailed
        ? destinationVerification?.status === "unstable" ||
          destinationVerification?.status === "unavailable"
        : observationUnconfirmed,
      ...(hardStop ? { retryInput: false } : {}),
      inputDispatched: true,
      safeToContinue: !hardStop,
      interaction: compactNativeTapResolution(resolution),
      selector: parsedSelector,
      receipt,
      ...(reconciledObservation ? { observation: reconciledObservation } : {}),
      ...(destinationVerification ? { destinationVerification } : {}),
      ...(verificationWarnings.length ? { verificationWarnings } : {}),
    };
    const detail = destinationVerification
      ? destinationVerification.verified
        ? "Physical element tap accepted and destination identity verified."
        : destinationVerification.status === "ambiguous"
          ? `Physical element tap was sent, but destination verification was ambiguous. ${verificationWarnings[0] ?? "Use a more specific selector."} Do not continue with consequential actions.`
          : "Physical element tap was sent, but the requested destination identity was not verified. Do not continue with consequential actions."
      : "Physical element tap accepted.";
    const text = hardStop ? `${DISPATCHED_INPUT_HARD_STOP} ${detail}` : detail;
    return observed
      ? toolResultWithContent(
          [{ type: "text" as const, text }, ...observed.content],
          structured,
          hardStop,
        )
      : toolResult(text, structured, hardStop);
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
        "Find React Native or accessible elements by identifier, role, name, value, placeholder, or a generation-scoped ref.",
      inputSchema: selectorSchema,
      outputSchema: findElementsOutputSchema,
    },
    async (selector) => {
      const result = await session.findElements(accessibilitySelectorFromInput(selector));
      return toolResult(`Matched ${result.count} accessible element(s).`, result);
    },
  );
  server.registerTool(
    "search_elements",
    {
      title: "Search elements",
      description:
        "Search the currently rendered semantic tree with a natural-language query containing at least one Unicode letter or number and return bounded ranked matches. A zero match is not proof that an item is absent from a scrollable list, table, or collection because unrendered rows are outside this search. Follow excludedCandidates swipe guidance when present; otherwise explore expected data surfaces with bounded one-swipe-at-a-time navigation, searching each changed snapshot and stopping at a semantic boundary. Use the winning ref with tap_element; this tool never captures or returns an image.",
      inputSchema: {
        query: semanticSearchTextSchema,
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
      const summary =
        result.total === 0
          ? "No currently rendered semantic elements matched. Absence is non-conclusive for a scrollable list, table, or collection; explore it with bounded one-swipe-at-a-time navigation and search each changed snapshot."
          : `Matched ${result.total} semantic element(s); returned ${result.count} ranked result(s).`;
      return toolResult(summary, result);
    },
  );

  server.registerTool(
    "tap_element",
    {
      title: "Tap element",
      description:
        "Re-resolve one React Native or accessible element, validate it, and physically tap its visible center through native device input; returned target/hit diagnostics are compact node summaries on both iOS and Android, followed by the stable compact post-action tree exactly once. Consume that embedded tree instead of immediately calling observe_screen. All supplied selector fields must match one node; target_not_found may report bounded selectorDiagnostics for split nodes, after which use search_elements and its generation-scoped ref. When inputDispatched is false, follow recoveryAllowed and recoveryAction using the bounded actionability, hit, and selector diagnostics. tap_known_coordinate permits one automatic raw tap only at coordinateFallback.point when the original user request authorized the action; no separate confirmation is needed, but observe immediately afterward and never repeat it. Never derive fallback coordinates from hit diagnostics. Disabled, ambiguous, or other unresolved targets require a new semantic resolution, independent UI change, or user direction. HARD STOP — INPUT WAS DISPATCHED and retryInput:false prohibit further device input until new user direction or an independent UI change. verifyDestination is optional and only proves a known, distinctive post-navigation destination; do not attach it to every tap in a sensitive workflow. Never copy the tapped control's label or use a generic section/action label such as Invoices, Orders, Card, or Pay as destination identity. For generic navigation, omit verifyDestination and rely on the stable semantic post-action observation. When used, verification requires a unique native identity, accepts up to four supporting assertions, and has a 100-5000 ms timeout (maximum 5000). Name matches label/title and falls back to non-redacted text values; checked/selected/enabled can verify exposed control state. Assertions such as amount/status must be present but may match multiple nodes. Prefer a stable identifier or complete entity label for identity, and use exact:false only for a known composite-label fragment.",
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
      const parsedSelector = accessibilitySelectorFromInput(selector);
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
    const receipt = await session.dispatchInputReceipt(parsed);
    return toolResult(
      receipt.accepted
        ? "Device input accepted."
        : receipt.inputDispatched
          ? `${DISPATCHED_INPUT_HARD_STOP} Reconnect and observe without replaying the input.`
          : "Device input was rejected before dispatch; follow the receipt recovery action.",
      receipt,
      !receipt.accepted,
    );
  };
  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: `Tap a normalized device coordinate. ${RAW_INPUT_RECEIPT_GUIDANCE}`,
      inputSchema: { x: z.number().min(0).max(1), y: z.number().min(0).max(1) },
      outputSchema: inputReceiptSchema,
    },
    ({ x, y }) => input({ method: "input.tap", params: { x, y } }),
  );
  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: `Swipe between normalized device coordinates. ${RAW_INPUT_RECEIPT_GUIDANCE}`,
      inputSchema: {
        from: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
        to: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
        durationMs: z.number().int().min(50).max(10_000).default(350),
      },
      outputSchema: inputReceiptSchema,
    },
    ({ from, to, durationMs }) =>
      input({ method: "input.swipe", params: { from, to, durationMs } }),
  );
  server.registerTool(
    "perform_gesture",
    {
      title: "Perform gesture",
      description: `Perform one or two normalized timestamped pointer tracks (up to five seconds and 120 total samples). ${RAW_INPUT_RECEIPT_GUIDANCE}`,
      inputSchema: { tracks: gestureTracksSchema },
      outputSchema: inputReceiptSchema,
    },
    ({ tracks }) => input({ method: "input.gesture", params: { tracks } }),
  );
  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description: `Hold a normalized device coordinate. ${RAW_INPUT_RECEIPT_GUIDANCE}`,
      inputSchema: {
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        durationMs: z.number().int().min(100).max(10_000).default(600),
      },
      outputSchema: inputReceiptSchema,
    },
    ({ x, y, durationMs }) => input({ method: "input.longPress", params: { x, y, durationMs } }),
  );
  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: `Type text at the selected device's declared ASCII or Unicode capability level. ${RAW_INPUT_RECEIPT_GUIDANCE}`,
      inputSchema: { text: z.string().max(10_000) },
      outputSchema: inputReceiptSchema,
    },
    ({ text }) => {
      if (containsUnsupportedTextControl(text)) {
        return Promise.resolve(
          toolResult(
            "type_text accepts literal printable text only; use press_key for Return, Tab, or Delete.",
            rejectedInputReceipt({
              code: "special_key_requires_press_key",
              message:
                "type_text accepts literal printable text only; use press_key for Return, Tab, or Delete.",
              inputDispatched: false,
              retryable: false,
              recoveryAllowed: true,
              recoveryAction: "press_key",
            }),
            true,
          ),
        );
      }
      return input({ method: "input.typeText", params: { text } });
    },
  );
  server.registerTool(
    "press_button",
    {
      title: "Press button",
      description: `Press a supported device hardware or navigation button. ${RAW_INPUT_RECEIPT_GUIDANCE}`,
      inputSchema: {
        button: z.enum(["home", "back", "overview", "lock", "volume-up", "volume-down", "action"]),
      },
      outputSchema: inputReceiptSchema,
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
    "app_open_browser",
    {
      title: "Open review in browser",
      description: "Open this review in a resizable browser window.",
      inputSchema: {},
      outputSchema: z.object({ opened: z.boolean() }),
      _meta: metadata.appOnly,
    },
    () => {
      session.requireClient();
      session.startRelay();
      session.openBrowser();
      return { content: [], structuredContent: { opened: true } };
    },
  );
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
        outputSchema: inputReceiptSchema,
        _meta: metadata.appOnly,
      },
      async ({ method, params }) => {
        const parsed = relayInputSchema.parse({ method, params });
        const receipt = await session.dispatchInputReceipt(parsed);
        return {
          content: [],
          structuredContent: receipt,
          ...(!receipt.accepted ? { isError: true } : {}),
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

async function appHtml(initialState: SessionState, root: string): Promise<string> {
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
  const { runAdapter } = await import("./adapter");
  await runAdapter();
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
