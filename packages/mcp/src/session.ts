import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccessibilityNode,
  type AccessibilitySelector,
  type AccessibilitySnapshot,
  type Annotation,
  type DeviceDescription,
  type ElementSearchMatch,
  type ElementSearchQuery,
  type ElementSnapshot,
  FrameKind,
  flattenAccessibilityTree,
  type ScreenContext,
  SimViewClient,
} from "@simview/client";
import {
  type AccessibilityResource,
  accessibilityObserveResultSchema,
  accessibilityResourceSchema,
  annotationMutationSchema,
  type ElementFallbackDetail,
  type ElementFallbackReason,
  type ElementTreeOutput,
  type IOSAccessibilityStatus,
  type McpConnectionContext,
  normalizedPointSchema,
  normalizeSemanticSearchText,
  relayAuthenticationSchema,
  relayInputSchema,
  type SaveReviewImagesInput,
  type SaveReviewImagesOutput,
  type SessionState,
  saveReviewImagesInputSchema,
  summarizeAccessibilityNode,
  uiContextSchema,
} from "@simview/contracts";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { previewScriptResponse, resolveAppRoot } from "./app-assets";
import { MetroInspector } from "./metro";
import { packetsFromLatestKeyframe } from "./preview";
import { accessibilityResourceSemanticHash } from "./semantic-state";

export type { SessionState } from "@simview/contracts";

type StreamCodec = "h264" | "mjpeg";
type ViewerData = {
  codec: StreamCodec;
  authenticated: boolean;
  authenticationTimer?: ReturnType<typeof setTimeout> | undefined;
  paused: boolean;
  waitingForKeyframe: boolean;
};
type PreviewPacket = {
  sequence: number;
  kind: FrameKind.H264Frame;
  payload: Uint8Array;
  keyframe: boolean;
};

export interface PreviewPacketBatch {
  reset: boolean;
  configuration?: Uint8Array | undefined;
  packets: PreviewPacket[];
  nextSequence: number;
}

interface Screenshot {
  bytes: Uint8Array;
  frameId: string;
  width: number;
  height: number;
}

export interface WarmObservation {
  observationId: string;
  frameId: string;
  frameRevision: number;
  changeRevision: number;
  imageRevision: number;
  capturedAt: string;
  settledAt: string;
  stable: boolean;
  ageMs: number;
  width: number;
  height: number;
  byteLength: number;
  imageIncluded: boolean;
  cacheHit: boolean;
  firstChangedFrameAt?: string | undefined;
  imageReadyAt?: string | undefined;
  image?: Uint8Array | undefined;
}

export type AccessibilityObservation = z.output<typeof accessibilityObserveResultSchema>;

export type NativeTapResolution = {
  accepted: boolean;
  code:
    | "stale_ref"
    | "target_not_found"
    | "ambiguous_target"
    | "target_offscreen"
    | "target_disabled"
    | "unstable_snapshot"
    | "native_target_unconfirmed"
    | "hit_target_mismatch"
    | "ready";
  retryable: boolean;
  discoverySource?: string;
  discoverySnapshotId?: string;
  interactionSource?: string;
  interactionSnapshotId?: string;
  fingerprint?: SemanticFingerprint;
  target?: AccessibilityNode;
  point?: { x: number; y: number };
  rawFrame?: AccessibilityNode["frame"];
  viewport?: AccessibilitySnapshot["screen"];
  scrollRequired?: boolean;
  suggestedScrollDirection?: "up" | "down" | "left" | "right";
  corroboratedBy?: SemanticFingerprintField[];
  stable?: boolean;
  hitTest?: boolean;
  hitNode?: AccessibilityNode;
  actionableHitNode?: AccessibilityNode;
  hitRelationship?: "self" | "descendant" | "ancestor" | "unrelated" | "ambiguous";
  hitMethod?: "snapshot-actionable" | "provider-element-at-point";
  selectorDiagnostics?: SelectorDiagnostics;
  actionabilityDiagnostics?: ActionabilityDiagnostics;
  searchScope?: "current-rendered-tree";
  absenceConclusive?: boolean;
  candidates?: ElementSearchMatch[];
};

export type NativeTapRecoveryAction =
  | "search_again"
  | "scroll_then_search"
  | "observe_then_search"
  | "tap_known_coordinate";

export type NativeCoordinateFallback = {
  point: { x: number; y: number };
  source: "fresh-semantic-target-center";
  targetRef: string;
  maxAttempts: 1;
  requiresPostActionObservation: true;
};

export type NativeTapRecovery = {
  retryInput: false;
  recoveryAllowed: boolean;
  recoveryAction?: NativeTapRecoveryAction;
  coordinateFallback?: NativeCoordinateFallback;
};

export function nativeTapRecovery(resolution: NativeTapResolution): NativeTapRecovery {
  switch (resolution.code) {
    case "target_offscreen":
      return { retryInput: false, recoveryAllowed: true, recoveryAction: "scroll_then_search" };
    case "unstable_snapshot":
      return { retryInput: false, recoveryAllowed: true, recoveryAction: "observe_then_search" };
    case "hit_target_mismatch":
      if (
        resolution.point &&
        resolution.target &&
        resolution.target.enabled !== false &&
        resolution.target.hidden !== true &&
        resolution.actionabilityDiagnostics?.targetActionable !== false &&
        resolution.hitRelationship !== "ambiguous"
      ) {
        return {
          retryInput: false,
          recoveryAllowed: true,
          recoveryAction: "tap_known_coordinate",
          coordinateFallback: {
            point: resolution.point,
            source: "fresh-semantic-target-center",
            targetRef: resolution.target.ref,
            maxAttempts: 1,
            requiresPostActionObservation: true,
          },
        };
      }
      return { retryInput: false, recoveryAllowed: false };
    case "target_disabled":
    case "ready":
      return { retryInput: false, recoveryAllowed: false };
    default:
      return { retryInput: false, recoveryAllowed: true, recoveryAction: "search_again" };
  }
}

type SelectorDiagnosticField = "ref" | "identifier" | "role" | "name" | "value" | "placeholder";

type SelectorDiagnostics = {
  fields: Array<{
    field: SelectorDiagnosticField;
    matchCount: number;
    matches: AccessibilityNode[];
  }>;
  splitAcrossNodes: boolean;
  relationship?: "ancestor-descendant" | "separate";
};

type ActionabilityDiagnostics = {
  targetActionable: boolean;
  ambiguous: boolean;
  candidates: Array<{
    relationship: "ancestor" | "descendant";
    node: AccessibilityNode;
  }>;
};

export type DestinationVerification = {
  status: "matched" | "mismatch" | "ambiguous" | "unstable" | "unavailable";
  verified: boolean;
  source?: AccessibilitySnapshot["source"];
  snapshotId?: string;
  revision?: string;
  settledAt?: string;
  strategy?: AccessibilityObservation["strategy"];
  eventChanged?: boolean;
  timedOut?: boolean;
  fallbackUsed?: boolean;
  captureCount?: number;
  changeSource?: AccessibilityObservation["changeSource"];
  stable: boolean;
  checks: Array<{
    kind: "identity" | "assertion";
    selector: DestinationSelector;
    count: number;
    suggestions?: DestinationSelectorSuggestion[];
  }>;
};

export type DestinationSelector = AccessibilitySelector & {
  checked?: boolean | undefined;
  enabled?: boolean | undefined;
  selected?: boolean | undefined;
};

export type DestinationVerificationRequest = {
  identity: DestinationSelector;
  assertions?: DestinationSelector[];
};

type DestinationSelectorSuggestion = {
  identifier?: string;
  role?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  exact: true;
};

const PREVIEW_PACKET_LIMIT = 120;
const PREVIEW_MAX_LAG_PACKETS = 30;

export class SimViewSession {
  readonly reviewId = randomUUID();
  readonly relayToken = randomBytes(32).toString("hex");
  readonly viewers = new Set<ServerWebSocket<ViewerData>>();
  client: SimViewClient | undefined = undefined;
  mjpegClient: SimViewClient | undefined = undefined;
  device: DeviceDescription | undefined = undefined;
  frameId: string | undefined = undefined;
  lastAccessibility: AccessibilitySnapshot | undefined = undefined;
  lastElements: ElementSnapshot | undefined = undefined;
  lastScreenContext: ScreenContext | undefined = undefined;
  relay: ReturnType<typeof Bun.serve> | undefined = undefined;
  codec: "h264" | "mjpeg" = "h264";
  #h264Configuration: Uint8Array | undefined = undefined;
  #mjpegClientPromise: Promise<SimViewClient> | undefined = undefined;
  #previewSequence = 0;
  #previewPackets: PreviewPacket[] = [];
  #previewWaiters = new Set<() => void>();
  #screenshotOperation: Promise<Screenshot> | undefined = undefined;
  #unsubscribers: Array<() => void> = [];
  #annotationsByDevice = new Map<string, Map<string, Annotation>>();
  #reviewImageDirectories = new Set<string>();
  #closePromise: Promise<void> | undefined = undefined;
  #connectionGeneration = 0;
  #metroInspector: MetroInspector;
  #closed = false;
  #connectionTail: Promise<void> = Promise.resolve();
  readonly appRoot: string;
  readonly resourceVersion: string | undefined;

  constructor(private readonly context?: McpConnectionContext) {
    this.appRoot = context?.appRoot ?? resolveAppRoot();
    this.resourceVersion = context?.resourceVersion;
    this.#metroInspector = new MetroInspector({ projectRoot: context?.projectRoot });
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new Error("SimView review is closed; reconnect the agent to start a new review");
  }

  #connectionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#connectionTail.then(() => {
      this.#assertOpen();
      return operation();
    });
    this.#connectionTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  #acquireClient(deviceId: string): Promise<SimViewClient> {
    const options = {
      deviceId,
      codec: "h264" as const,
      binary: this.context?.coreBinary,
      environment: this.context?.nativeEnvironment,
    };
    return this.context?.backendMode === "ephemeral"
      ? SimViewClient.start(options)
      : SimViewClient.acquire({ ...options, backendMode: this.context?.backendMode });
  }
  #observationMode: "hybrid" | "semantic" = "semantic";
  #latestObservation: WarmObservation | undefined;
  #latestAccessibilityObservation: AccessibilityObservation | undefined;
  #latestAccessibilityResource: AccessibilityResource | undefined;
  #accessibilityResourceListeners = new Set<(resource: AccessibilityResource) => void>();
  #fiberCache = new Map<string, { expiresAt: number; bytes: number; output: ElementTreeOutput }>();
  #semanticCache = new Map<string, { expiresAt: number; output: ElementTreeOutput }>();
  #semanticRefresh = new Map<string, Promise<ElementTreeOutput>>();
  #semanticGeneration = 0;
  #visualObservationTail: Promise<void> = Promise.resolve();
  #iosAccessibility: IOSAccessibilityStatus | undefined;

  get connectionGeneration(): number {
    return this.#connectionGeneration;
  }

  get accessibilityRevision(): string | undefined {
    return this.#latestAccessibilityObservation?.revision;
  }

  get accessibilityStrategy(): AccessibilityObservation["strategy"] | undefined {
    return this.#latestAccessibilityObservation?.strategy;
  }

  get latestAccessibilityObservation(): AccessibilityObservation | undefined {
    return this.#latestAccessibilityObservation;
  }

  get accessibilityResourceUri(): string {
    return `simview://review/${this.reviewId}/accessibility`;
  }

  onAccessibilityResourceUpdate(listener: (resource: AccessibilityResource) => void): () => void {
    this.#accessibilityResourceListeners.add(listener);
    return () => this.#accessibilityResourceListeners.delete(listener);
  }

  get annotations(): Map<string, Annotation> {
    const deviceId = this.device?.id ?? "unselected";
    let annotations = this.#annotationsByDevice.get(deviceId);
    if (!annotations) {
      annotations = new Map();
      this.#annotationsByDevice.set(deviceId, annotations);
    }
    return annotations;
  }

  async open(
    deviceId?: string,
    options: { startRelay?: boolean; observationMode?: "hybrid" | "semantic" } = {},
  ): Promise<SessionState> {
    return this.#connectionOperation(() => this.#open(deviceId, options));
  }

  async #open(
    deviceId: string | undefined,
    options: { startRelay?: boolean; observationMode?: "hybrid" | "semantic" },
  ): Promise<SessionState> {
    if (!this.client?.connected) {
      if (this.client) {
        for (const unsubscribe of this.#unsubscribers) unsubscribe();
        this.#unsubscribers = [];
        await this.client.close().catch(() => {});
        this.client = undefined;
        this.#connectionGeneration += 1;
        this.#clearSemanticState();
        this.#latestObservation = undefined;
        this.#resetPreviewPackets();
      }
      const devices = await this.devices();
      this.#assertOpen();
      const available = devices.filter((device) => device.available);
      this.device = deviceId
        ? available.find((device) => matchesDeviceId(device, deviceId))
        : (available.find((device) => device.kind !== "physical") ?? available[0]);
      if (!this.device) {
        throw new Error("No available device is connected");
      }
      try {
        const client = await this.#acquireClient(this.device.id);
        if (this.#closed) {
          await client.close();
          this.#assertOpen();
        }
        this.client = client;
        this.#connectionGeneration += 1;
        this.#bindFrames();
        this.#observationMode = options.observationMode ?? "semantic";
        const capture = await this.client.request("capture.start", {
          ...selectedDeviceParams(this.device),
          observationMode: this.#observationMode,
        });
        this.#assertOpen();
        this.device = capture.device;
        await this.#refreshIOSAccessibilityStatus();
        this.#assertOpen();
        if (options.startRelay === true) this.startRelay();
        void this.#primeObservation();
      } catch (error) {
        for (const unsubscribe of this.#unsubscribers) unsubscribe();
        this.#unsubscribers = [];
        await this.client?.close().catch(() => {});
        this.#connectionGeneration += 1;
        this.client = undefined;
        this.device = undefined;
        this.#resetPreviewPackets();
        throw error;
      }
    } else if (deviceId) {
      if (!matchesDeviceId(this.device, deviceId)) await this.#selectDevice(deviceId);
      else await this.refreshDevice();
    }
    return this.state();
  }

  async availableDevices(): Promise<DeviceDescription[]> {
    return (await this.devices()).filter((device) => device.available);
  }

  devices(): Promise<DeviceDescription[]> {
    return SimViewClient.listDevices(this.context?.coreBinary, this.context?.nativeEnvironment);
  }

  async refreshDevice(): Promise<SessionState> {
    if (this.client && this.device) {
      this.device = await this.client.request("device.describe", selectedDeviceParams(this.device));
    }
    return this.state();
  }

  async selectDevice(deviceId: string): Promise<SessionState> {
    return this.#connectionOperation(() => this.#selectDevice(deviceId));
  }

  async #selectDevice(deviceId: string): Promise<SessionState> {
    const selected = (await this.availableDevices()).find((device) =>
      matchesDeviceId(device, deviceId),
    );
    if (!selected) throw new Error(`Device ${deviceId} is not available`);
    if (selected.id === this.device?.id) return this.state();

    this.#assertOpen();
    const nextClient = await this.#acquireClient(selected.id);
    try {
      this.#assertOpen();
      const capture = await nextClient.request("capture.start", {
        ...selectedDeviceParams(selected),
        observationMode: this.#observationMode,
      });

      this.#connectionGeneration += 1;
      for (const unsubscribe of this.#unsubscribers) unsubscribe();
      this.#unsubscribers = [];
      if (this.mjpegClient) await this.mjpegClient.close();
      this.mjpegClient = undefined;
      this.#mjpegClientPromise = undefined;
      if (this.client) await this.client.close();
      this.#assertOpen();
      this.client = nextClient;
      this.device = capture.device;
      await this.#refreshIOSAccessibilityStatus();
      this.#assertOpen();
      this.frameId = undefined;
      this.#latestObservation = undefined;
      this.#clearSemanticState();
      this.#metroInspector.close();
      this.#resetPreviewPackets();
      this.#bindFrames();
      if ([...this.viewers].some((viewer) => viewer.data.codec === "mjpeg")) {
        void this.#ensureMjpegClient().catch(() => {});
      }
      return this.state();
    } catch (error) {
      await nextClient.close();
      throw error;
    }
  }

  state(): SessionState {
    const screenContext = this.lastScreenContext;
    const componentName =
      screenContext?.kind === "react-native"
        ? screenContext.screenComponent
        : screenContext?.component;
    const componentSource =
      screenContext?.kind === "react-native"
        ? screenContext.sourceLocation?.file
        : screenContext?.source;
    const componentTestID = screenContext?.testID;
    return {
      reviewId: this.reviewId,
      device: this.device,
      frameId: this.frameId,
      route: screenContext?.route,
      component:
        componentName || componentSource || componentTestID
          ? {
              label: componentName,
              source: componentSource,
              testID: componentTestID,
            }
          : undefined,
      annotations: [...this.annotations.values()],
      codec: this.codec,
      connected: this.client?.connected === true,
      iosAccessibility: this.#iosAccessibility,
    };
  }

  async enableIOSAccessibilityProvider(bundleId?: string): Promise<SessionState> {
    const client = this.requireClient();
    const device = this.device;
    if (device?.platform !== "ios") {
      throw new Error("The XCTest accessibility provider is available only for iOS Simulators");
    }
    this.#iosAccessibility = await client.request("accessibility.enableXCTestProvider", {
      ...selectedDeviceParams(device),
      bundleId,
    });
    this.#clearSemanticState();
    await this.#primeObservation();
    return this.state();
  }

  async disableIOSAccessibilityProvider(): Promise<SessionState> {
    const client = this.requireClient();
    const device = this.device;
    if (device?.platform !== "ios") return this.state();
    this.#iosAccessibility = await client.request("accessibility.disableXCTestProvider", {
      ...selectedDeviceParams(device),
    });
    this.#clearSemanticState();
    return this.state();
  }

  async #refreshIOSAccessibilityStatus(): Promise<void> {
    const device = this.device;
    if (device?.platform !== "ios") {
      this.#iosAccessibility = undefined;
      return;
    }
    const client = this.requireClient();
    try {
      this.#iosAccessibility = await client.request("accessibility.enableXCTestProvider", {
        ...selectedDeviceParams(device),
      });
    } catch {
      this.#iosAccessibility = await client.request("accessibility.providerStatus", {
        ...selectedDeviceParams(device),
      });
    }
  }

  browserUrl(): string | undefined {
    if (!this.relay) return undefined;
    return `http://${this.relay.hostname}:${this.relay.port}/#token=${this.relayToken}`;
  }

  openBrowser(): void {
    const url = this.browserUrl();
    if (!url) throw new Error("The browser relay is not running");
    Bun.spawn(["/usr/bin/open", url], { stdout: "ignore", stderr: "ignore" });
  }

  async screenshot(): Promise<Screenshot> {
    if (this.#screenshotOperation) return this.#screenshotOperation;
    const operation = this.#captureScreenshot();
    this.#screenshotOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.#screenshotOperation === operation) this.#screenshotOperation = undefined;
    }
  }

  async enablePreview(enabled = true): Promise<void> {
    await this.requireClient().request("capture.preview", { enabled });
    if (!enabled) this.#resetPreviewPackets();
  }

  async warmObservation({
    visual,
    afterRevision,
    settleQuietMs = 75,
    maxWaitMs = 500,
  }: {
    visual: boolean;
    afterRevision?: number | undefined;
    settleQuietMs?: number | undefined;
    maxWaitMs?: number | undefined;
  }): Promise<WarmObservation> {
    if (!visual) {
      return this.#requestWarmObservation({
        visual,
        afterRevision,
        settleQuietMs,
        maxWaitMs,
      });
    }
    const previous = this.#visualObservationTail;
    let release = () => {};
    this.#visualObservationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#requestWarmObservation({
        visual,
        afterRevision,
        settleQuietMs,
        maxWaitMs,
      });
    } finally {
      release();
    }
  }

  async #requestWarmObservation({
    visual,
    afterRevision,
    settleQuietMs,
    maxWaitMs,
  }: {
    visual: boolean;
    afterRevision?: number | undefined;
    settleQuietMs: number;
    maxWaitMs: number;
  }): Promise<WarmObservation> {
    const client = this.requireClient();
    const connectionGeneration = this.#connectionGeneration;
    let cancelImageWait = () => {};
    const imagePromise = visual
      ? new Promise<Uint8Array>((resolve, reject) => {
          const unsubscribe = client.on(FrameKind.PreparedImage, (bytes) => {
            clearTimeout(timeout);
            unsubscribe();
            resolve(bytes);
          });
          const timeout = setTimeout(
            () => {
              unsubscribe();
              reject(new Error("Timed out waiting for prepared observation image"));
            },
            Math.max(1_000, maxWaitMs + 1_000),
          );
          cancelImageWait = () => {
            clearTimeout(timeout);
            unsubscribe();
          };
        })
      : undefined;
    try {
      const metadata = await client.request("observation.get", {
        visual,
        afterRevision,
        settleQuietMs,
        maxWaitMs,
      });
      if (!metadata.imageIncluded) cancelImageWait();
      const image = metadata.imageIncluded ? await imagePromise : undefined;
      const result = { ...metadata, image };
      if (connectionGeneration === this.#connectionGeneration && client === this.client) {
        this.frameId = result.frameId;
        this.#latestObservation = result;
      }
      return result;
    } catch (error) {
      cancelImageWait();
      throw error;
    }
  }

  get latestObservation(): WarmObservation | undefined {
    return this.#latestObservation;
  }

  async saveReviewImages(input: SaveReviewImagesInput): Promise<SaveReviewImagesOutput> {
    this.#assertOpen();
    const directory = await mkdtemp(join(tmpdir(), `simview-review-${this.reviewId}-`));
    this.#reviewImageDirectories.add(directory);
    try {
      this.#assertOpen();
      await chmod(directory, 0o700);
      const screenshotPath = join(directory, "frozen-frame.png");
      await writePng(screenshotPath, input.screenshot);
      const annotations = await Promise.all(
        input.annotations.map(async (annotation, index) => {
          const screenshotPath = join(
            directory,
            `annotation-${String(index + 1).padStart(2, "0")}-${annotation.id}.png`,
          );
          await writePng(screenshotPath, annotation.screenshot);
          return { id: annotation.id, screenshotPath };
        }),
      );
      return { directory, screenshotPath, annotations };
    } catch (error) {
      this.#reviewImageDirectories.delete(directory);
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #captureScreenshot(): Promise<Screenshot> {
    if (!this.device?.capabilities.capture.screenshot) {
      throw new Error("Screenshots are not supported by the selected device");
    }
    const client = this.requireClient();
    const bytesPromise = new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for PNG screenshot payload"));
      }, 5_000);
      const unsubscribe = client.on(FrameKind.PngScreenshot, (bytes) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(bytes);
      });
    });
    const metadata = await client.request("capture.screenshot", {});
    const bytes = await bytesPromise;
    this.frameId = metadata.frameId;
    return { bytes, ...metadata };
  }

  async accessibilitySnapshot(
    scope: "interactive" | "visible" | "full" = "interactive",
    maxNodes = 1_200,
  ) {
    const semanticGeneration = this.#semanticGeneration;
    this.requireCapability("accessibility", "Accessibility inspection");
    const snapshot = await this.requireClient().request("accessibility.snapshot", {
      ...selectedDeviceParams(this.device),
      scope,
      maxNodes,
    });
    if (
      snapshot.source === "core-simulator-ax" &&
      this.#iosAccessibility?.activeProvider === "core-simulator-xctest"
    ) {
      this.#iosAccessibility = {
        schemaVersion: 1,
        status: "native-ready",
        activeProvider: "core-simulator-ax",
        xctestAvailability: "ready",
        ...(snapshot.stats.quality ? { legacyQuality: snapshot.stats.quality } : {}),
        reason: "xctest-provider-runtime-fallback",
      };
    }
    if (semanticGeneration === this.#semanticGeneration) {
      this.lastAccessibility = snapshot;
      this.#rememberAccessibilitySnapshot(snapshot, {
        revision: snapshot.snapshotId,
        strategy: strategyForSnapshot(snapshot),
        stable: true,
        settledAt: snapshot.capturedAt,
      });
    }
    return snapshot;
  }

  async accessibilityObserve({
    afterRevision,
    scope = "interactive",
    maxNodes = 1_200,
    settleQuietMs = 75,
    maxWaitMs = 500,
    requireChange = true,
  }: {
    afterRevision?: string | undefined;
    scope?: "interactive" | "visible" | "full" | undefined;
    maxNodes?: number | undefined;
    settleQuietMs?: number | undefined;
    maxWaitMs?: number | undefined;
    requireChange?: boolean | undefined;
  } = {}): Promise<AccessibilityObservation> {
    const semanticGeneration = this.#semanticGeneration;
    this.requireCapability("accessibility", "Accessibility inspection");
    const result = accessibilityObserveResultSchema.parse(
      await this.requireClient().request("accessibility.observe", {
        ...selectedDeviceParams(this.device),
        ...(afterRevision ? { afterRevision } : {}),
        scope,
        maxNodes,
        settleQuietMs,
        maxWaitMs,
        requireChange,
      }),
    );
    if (semanticGeneration === this.#semanticGeneration) {
      this.lastAccessibility = result.snapshot;
      this.#latestAccessibilityObservation = result;
      this.#rememberAccessibilitySnapshot(result.snapshot, result);
    }
    return result;
  }

  async accessibilityResource(): Promise<AccessibilityResource> {
    if (this.#latestAccessibilityResource) return this.#latestAccessibilityResource;
    await this.accessibilityObserve({ maxWaitMs: 0 });
    if (!this.#latestAccessibilityResource) {
      throw new Error("Accessibility resource is unavailable");
    }
    return this.#latestAccessibilityResource;
  }

  #rememberAccessibilitySnapshot(
    snapshot: AccessibilitySnapshot,
    observation: Pick<AccessibilityObservation, "revision" | "strategy" | "stable" | "settledAt">,
  ): void {
    const semanticHash = accessibilityResourceSemanticHash(snapshot);
    const resource = accessibilityResourceSchema.parse({
      schemaVersion: 1,
      revision: observation.revision,
      semanticHash,
      capturedAt: snapshot.capturedAt,
      strategy: observation.strategy,
      snapshot,
    });
    const changed = this.#latestAccessibilityResource?.semanticHash !== semanticHash;
    this.#latestAccessibilityResource = resource;
    if (changed && observation.stable) {
      for (const listener of this.#accessibilityResourceListeners) listener(resource);
    }
  }

  async elementSnapshot(
    scope: "interactive" | "visible" | "full" = "interactive",
    maxNodes = 1_200,
    existingAccessibility?: AccessibilitySnapshot,
  ): Promise<ElementTreeOutput> {
    const semanticGeneration = this.#semanticGeneration;
    const accessibility =
      existingAccessibility ?? (await this.accessibilitySnapshot(scope, maxNodes));
    if (semanticGeneration !== this.#semanticGeneration) {
      throw new Error("Semantic state changed while the element tree was being prepared");
    }
    const accessibilityRevision = this.accessibilityRevision ?? accessibility.snapshotId;
    const semanticHash = this.#semanticHashFor(accessibility);
    const accessibilityKey = `${scope}:${maxNodes}:${accessibilityRevision}:${semanticHash}`;
    const cached = this.#fiberCache.get(accessibilityKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.lastElements = cached.output.snapshot;
      this.lastScreenContext = cached.output.screenContext;
      return cached.output;
    }
    const device = this.device;
    const frameId = this.frameId ?? "current";
    const metro = device
      ? await this.#metroInspector.inspect(device, accessibility, frameId, maxNodes)
      : undefined;
    if (metro && device) {
      if (device.platform === "ios" && !metro.screenContext.bundleId) {
        try {
          const target = await this.probeTarget();
          metro.screenContext.bundleId = target.bundleId;
        } catch {
          // The Metro target remains useful when simctl cannot identify the focal app.
        }
      }
      this.lastElements = metro.snapshot;
      this.lastScreenContext = metro.screenContext;
      const output: ElementTreeOutput = {
        snapshot: metro.snapshot,
        screenContext: metro.screenContext,
      };
      this.#cacheFiber(accessibilityKey, output);
      return output;
    }

    const fallbackReason = this.#metroInspector.fallbackReason;
    const fallbackDetail = this.#metroInspector.fallbackDetail;
    return this.#accessibilityElementOutput(accessibility, frameId, fallbackReason, fallbackDetail);
  }

  async preparedElementSnapshot(maxNodes = 240): Promise<ElementTreeOutput> {
    const accessibilityRevision = this.accessibilityRevision ?? "0";
    const semanticHash = this.lastAccessibility
      ? this.#semanticHashFor(this.lastAccessibility)
      : "";
    const semanticGeneration = this.#semanticGeneration;
    const cacheKey = `interactive:${maxNodes}:${accessibilityRevision}:${semanticHash}`;
    const cached = this.#semanticCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.lastElements = cached.output.snapshot;
      this.lastScreenContext = cached.output.screenContext;
      return cached.output;
    }
    const inFlight = this.#semanticRefresh.get(cacheKey);
    if (inFlight) return inFlight;
    const refresh = this.elementSnapshot("interactive", maxNodes, this.lastAccessibility).then(
      (output) => {
        if (semanticGeneration === this.#semanticGeneration) {
          this.#cacheSemantic(cacheKey, output);
        }
        return output;
      },
    );
    this.#semanticRefresh.set(cacheKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#semanticRefresh.get(cacheKey) === refresh) this.#semanticRefresh.delete(cacheKey);
    }
  }

  async accessibilityElementSnapshot(
    scope: "interactive" | "visible" | "full" = "interactive",
    maxNodes = 1_200,
  ): Promise<ElementTreeOutput> {
    const accessibility = await this.accessibilitySnapshot(scope, maxNodes);
    return this.#accessibilityElementOutput(accessibility, this.frameId ?? "current");
  }

  async #accessibilityElementOutput(
    accessibility: AccessibilitySnapshot,
    frameId: string,
    fallbackReason?: ElementFallbackReason,
    fallbackDetail?: ElementFallbackDetail,
  ): Promise<ElementTreeOutput> {
    const screenContext = await this.#nativeIOSScreenContext(accessibility, frameId);
    this.lastElements = accessibility;
    this.lastScreenContext = screenContext;
    return {
      snapshot: accessibility,
      screenContext,
      ...(fallbackReason
        ? {
            fallback: {
              reason: fallbackReason,
              ...(fallbackDetail ? { detail: fallbackDetail } : {}),
            },
          }
        : {}),
    };
  }

  async findElements(selector: AccessibilitySelector) {
    const snapshots = await this.#semanticTargetSnapshots(selector.ref);
    for (const snapshot of snapshots) {
      const matches = matchingElements(snapshot, selector);
      if (matches.length > 0) {
        return { snapshotId: snapshot.snapshotId, selector, matches, count: matches.length };
      }
    }
    return {
      snapshotId: snapshots[0]?.snapshotId ?? "unavailable",
      selector,
      matches: [],
      count: 0,
    };
  }

  async resolveActionableElement(selector: AccessibilitySelector) {
    const snapshots = await this.#semanticTargetSnapshots(selector.ref);
    for (const snapshot of snapshots) {
      const matches = matchingElements(snapshot, selector);
      if (matches.length === 0) continue;
      const selected =
        selector.index === undefined ? matches : [matches[selector.index]].filter(isDefined);
      const actionable = selected.filter(isTappableElement);
      if (actionable.length > 0) {
        return {
          snapshotId: snapshot.snapshotId,
          selector,
          matches: actionable,
          count: actionable.length,
        };
      }
    }
    return {
      snapshotId: snapshots[0]?.snapshotId ?? "unavailable",
      selector,
      matches: [],
      count: 0,
    };
  }

  /**
   * Resolve a semantic discovery result into a fresh, native-only target. Refs
   * and coordinates belong to the snapshot that produced them, so neither is
   * allowed to cross this boundary into physical input.
   */
  async resolveNativeTap(selector: AccessibilitySelector): Promise<NativeTapResolution> {
    const cachedSnapshots = await this.#semanticTargetSnapshots(selector.ref);
    const cachedNative = cachedSnapshots.find(
      (snapshot) => snapshot.source !== "react-native-fiber",
    );
    const cachedFiber = cachedSnapshots.find(
      (snapshot) => snapshot.source === "react-native-fiber",
    );
    let discoverySource: ElementSnapshot | undefined;
    let discovery: AccessibilityNode | undefined;

    // A ref is meaningful only in the snapshot which issued it. Preserve its
    // semantic identity before taking the fresh native action snapshot.
    if (selector.ref) {
      const refSource = selector.ref.startsWith("rn:") ? cachedFiber : cachedNative;
      const refMatches = refSource ? matchingElements(refSource, selector) : [];
      if (refMatches.length === 0) {
        return { accepted: false, code: "stale_ref", retryable: true };
      }
      if (refMatches.length !== 1 && selector.index === undefined) {
        return { accepted: false, code: "ambiguous_target", retryable: false };
      }
      discoverySource = refSource;
      discovery = selector.index === undefined ? refMatches[0] : refMatches[selector.index];
      if (!discovery) return { accepted: false, code: "stale_ref", retryable: true };
    } else if (selector.index !== undefined && cachedNative) {
      // Index chooses an entity from the discovery generation only. Preserve
      // that entity's fingerprint before refresh so reordered repeated rows
      // cannot silently redirect the tap to the same numeric index.
      const cachedMatches = matchingElements(cachedNative, selector);
      discovery = cachedMatches[selector.index];
      if (discovery) discoverySource = cachedNative;
    }

    let settleAfterRevision = this.accessibilityRevision;
    if (!settleAfterRevision) {
      const baseline = await this.accessibilityObserve({
        scope: "interactive",
        maxWaitMs: 0,
      });
      settleAfterRevision = baseline.revision;
    }
    let observation = await this.accessibilityObserve({
      afterRevision: settleAfterRevision,
      scope: "interactive",
      maxWaitMs: 500,
      requireChange: false,
    });
    if (!observation.stable) {
      observation = await this.accessibilityObserve({
        afterRevision: observation.revision,
        scope: "interactive",
        maxWaitMs: 500,
        requireChange: false,
      });
    }
    if (!observation.stable) {
      return {
        accepted: false,
        code: "unstable_snapshot",
        retryable: true,
        ...(discoverySource ? { discoverySource: discoverySource.source } : {}),
        ...(discoverySource ? { discoverySnapshotId: discoverySource.snapshotId } : {}),
        interactionSource: observation.snapshot.source,
        interactionSnapshotId: observation.snapshot.snapshotId,
        stable: false,
      };
    }

    // Field selectors resolve directly against the fresh native tree. Fiber is
    // consulted only when native has no candidate, or when the caller supplied
    // a generation-scoped rn: ref. Fiber coordinates never reach input.
    if (!discovery) {
      const freshMatches = matchingElements(observation.snapshot, selector);
      const selected =
        selector.index === undefined
          ? freshMatches
          : [freshMatches[selector.index]].filter(isDefined);
      if (selected.length > 0) {
        if (selected.length !== 1 && selector.index === undefined) {
          return { accepted: false, code: "ambiguous_target", retryable: false };
        }
        discoverySource = observation.snapshot;
        discovery = selected[0];
      } else if (cachedFiber) {
        const fiberMatches = matchingElements(cachedFiber, selector);
        const fiberSelected =
          selector.index === undefined
            ? fiberMatches
            : [fiberMatches[selector.index]].filter(isDefined);
        if (fiberSelected.length !== 1) {
          return {
            accepted: false,
            code: fiberSelected.length > 1 ? "ambiguous_target" : "target_not_found",
            retryable: fiberSelected.length === 0,
            ...(fiberSelected.length === 0
              ? { selectorDiagnostics: selectorDiagnostics(observation.snapshot, selector) }
              : {}),
          };
        }
        discoverySource = cachedFiber;
        discovery = fiberSelected[0];
      } else {
        return {
          accepted: false,
          code: "target_not_found",
          retryable: true,
          selectorDiagnostics: selectorDiagnostics(observation.snapshot, selector),
        };
      }
    }

    if (!discovery || !discoverySource) {
      return { accepted: false, code: "target_not_found", retryable: true };
    }
    const fingerprint = semanticFingerprint(discovery);
    if (
      !fingerprint.identifier &&
      !fingerprint.name &&
      !fingerprint.value &&
      !fingerprint.placeholder
    ) {
      return { accepted: false, code: "native_target_unconfirmed", retryable: false };
    }
    const corroboration =
      discoverySource.source === "react-native-fiber"
        ? corroborateFiberTarget(observation.snapshot, fingerprint)
        : {
            matches: flattenAccessibilityTree(observation.snapshot.root).filter((node) =>
              matchesFingerprint(node, fingerprint),
            ),
            fields: Object.keys(fingerprint) as SemanticFingerprintField[],
          };
    const nativeMatches = corroboration.matches;
    if (nativeMatches.length === 0) {
      return {
        accepted: false,
        code: "native_target_unconfirmed",
        retryable: true,
        discoverySource: discoverySource.source,
        discoverySnapshotId: discoverySource.snapshotId,
        interactionSource: observation.snapshot.source,
        interactionSnapshotId: observation.snapshot.snapshotId,
        fingerprint,
        corroboratedBy: corroboration.fields,
        stable: true,
      };
    }
    if (nativeMatches.length !== 1) {
      return {
        accepted: false,
        code: "ambiguous_target",
        retryable: false,
        fingerprint,
        corroboratedBy: corroboration.fields,
      };
    }
    const target = nativeMatches[0];
    if (!target) {
      return { accepted: false, code: "target_not_found", retryable: true };
    }
    const targetActionability = actionabilityDiagnostics(observation.snapshot, target);
    const frame = target.frame?.normalized;
    if (target.enabled === false || target.hidden === true) {
      return {
        accepted: false,
        code: "target_disabled",
        retryable: false,
        fingerprint,
        target,
        actionabilityDiagnostics: targetActionability,
      };
    }
    if (!frame || frame.width <= 0 || frame.height <= 0) {
      return {
        accepted: false,
        code: "native_target_unconfirmed",
        retryable: false,
        fingerprint,
        target,
        actionabilityDiagnostics: targetActionability,
        rawFrame: target.frame,
        viewport: observation.snapshot.screen,
      };
    }
    const point = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      return {
        accepted: false,
        code: "target_offscreen",
        retryable: true,
        fingerprint,
        target,
        actionabilityDiagnostics: targetActionability,
        rawFrame: target.frame,
        viewport: observation.snapshot.screen,
        scrollRequired: true,
        suggestedScrollDirection: suggestedScrollDirection(frame),
        stable: true,
      };
    }
    if (!isActionableSearchCandidate(target)) {
      return {
        accepted: false,
        code: "native_target_unconfirmed",
        retryable: false,
        fingerprint,
        target,
        rawFrame: target.frame,
        viewport: observation.snapshot.screen,
        actionabilityDiagnostics: targetActionability,
      };
    }
    const nativeFingerprint = semanticFingerprint(target);
    const hitResolution =
      this.device?.platform === "android"
        ? resolveAndroidSnapshotHit(observation.snapshot, target, point)
        : await this.#resolveProviderHit(nativeFingerprint, point);
    if (!hitResolution.matchesTarget) {
      return {
        accepted: false,
        code: "hit_target_mismatch",
        retryable: false,
        fingerprint,
        target,
        point,
        hitTest: false,
        actionabilityDiagnostics: targetActionability,
        ...hitResolution.diagnostics,
      };
    }
    return {
      accepted: true,
      code: "ready",
      retryable: false,
      discoverySource: discoverySource.source,
      discoverySnapshotId: discoverySource.snapshotId,
      interactionSource: observation.snapshot.source,
      interactionSnapshotId: observation.snapshot.snapshotId,
      fingerprint,
      corroboratedBy: corroboration.fields,
      target,
      point,
      stable: true,
      hitTest: true,
      ...hitResolution.diagnostics,
    };
  }

  async #resolveProviderHit(fingerprint: SemanticFingerprint, point: { x: number; y: number }) {
    const hitNode = (await this.inspectPoint(point.x, point.y)) as AccessibilityNode;
    const matchesTarget = matchesFingerprint(hitNode, fingerprint);
    return {
      matchesTarget,
      diagnostics: {
        hitNode,
        ...(isActionableSearchCandidate(hitNode) ? { actionableHitNode: hitNode } : {}),
        hitRelationship: matchesTarget ? ("self" as const) : ("unrelated" as const),
        hitMethod: "provider-element-at-point" as const,
      },
    };
  }

  async verifyNativeDestination(
    request: DestinationVerificationRequest,
    {
      afterRevision,
      settleQuietMs = 75,
      maxWaitMs = 1_000,
      observation: suppliedObservation,
    }: {
      afterRevision?: string | undefined;
      settleQuietMs?: number | undefined;
      maxWaitMs?: number | undefined;
      observation?: AccessibilityObservation | undefined;
    } = {},
  ): Promise<DestinationVerification> {
    let observation = suppliedObservation;
    try {
      observation ??= await this.accessibilityObserve({
        afterRevision,
        scope: "visible",
        settleQuietMs,
        maxWaitMs,
      });
      if (!observation.stable) {
        observation = await this.accessibilityObserve({
          afterRevision,
          scope: "visible",
          settleQuietMs,
          maxWaitMs,
        });
      }
    } catch {
      return { status: "unavailable", verified: false, stable: false, checks: [] };
    }
    const candidates = [
      { kind: "identity" as const, selector: request.identity },
      ...(request.assertions ?? []).map((selector) => ({
        kind: "assertion" as const,
        selector,
      })),
    ];
    const checks = candidates.map(({ kind, selector: candidate }) => {
      const count = matchingElements(observation.snapshot, candidate).length;
      return {
        kind,
        selector: candidate,
        count,
        ...(count === 0
          ? { suggestions: destinationSelectorSuggestions(observation.snapshot, candidate) }
          : {}),
      };
    });
    const identityCount = checks[0]?.count ?? 0;
    const assertionsPresent = checks.slice(1).every((check) => check.count > 0);
    const verified = observation.stable && identityCount === 1 && assertionsPresent;
    return {
      status: !observation.stable
        ? "unstable"
        : verified
          ? "matched"
          : identityCount > 1
            ? "ambiguous"
            : "mismatch",
      verified,
      source: observation.snapshot.source,
      snapshotId: observation.snapshot.snapshotId,
      revision: observation.revision,
      settledAt: observation.settledAt,
      strategy: observation.strategy,
      eventChanged: observation.eventChanged,
      timedOut: observation.timedOut,
      ...(observation.fallbackUsed !== undefined ? { fallbackUsed: observation.fallbackUsed } : {}),
      ...(observation.captureCount !== undefined ? { captureCount: observation.captureCount } : {}),
      ...(observation.changeSource ? { changeSource: observation.changeSource } : {}),
      stable: observation.stable,
      checks,
    };
  }

  async searchElements(search: ElementSearchQuery) {
    const roles = search.roles?.map(normalizeSearchText);
    const snapshots = await this.#semanticTargetSnapshots();
    const snapshot = snapshots[0];
    const ranked: Array<{ match: ElementSearchMatch; source: ElementSnapshot }> = [];
    const excluded: Array<{
      match: ElementSearchMatch;
      source: ElementSnapshot;
      reasons: Array<"visibility" | "actionability">;
      scrollRequired: boolean;
      suggestedScrollDirection?: "up" | "down" | "left" | "right";
    }> = [];
    const sourceDiagnostics: Array<{
      source: ElementSnapshot["source"];
      snapshotId: string;
      quality: "complete" | "partial" | "degraded";
      reason?: string;
      truncated: boolean;
      nodeCount: number;
      capturedBudget?: number;
      exactMatchCount: number;
      excludedExactMatchCount: number;
      excludedExactMatches: { visibility: number; actionability: number };
    }> = [];
    const excludedExactMatchKeys = new Set<string>();
    for (const candidateSnapshot of snapshots) {
      const candidates = flattenAccessibilityTree(candidateSnapshot.root).filter(
        (node) =>
          !roles?.length ||
          roles.some((role) => normalizeSearchText(node.role ?? "").includes(role)),
      );
      const rankedCandidates = candidates
        .map((element) => ({ element, match: rankElementSearchMatch(element, search.query) }))
        .filter(
          (
            candidate,
          ): candidate is {
            element: AccessibilityNode;
            match: Omit<ElementSearchMatch, "source" | "snapshotId">;
          } => candidate.match !== undefined,
        );
      const exactCandidates = rankedCandidates.filter((candidate) => candidate.match.exact);
      const excludedByVisibility = search.visibleOnly
        ? exactCandidates.filter((candidate) => !isVisibleSearchCandidate(candidate.element)).length
        : 0;
      const excludedByActionability = search.actionableOnly
        ? exactCandidates.filter((candidate) => !isActionableSearchCandidate(candidate.element))
            .length
        : 0;
      const excludedExact = exactCandidates.filter(
        (candidate) =>
          (search.visibleOnly && !isVisibleSearchCandidate(candidate.element)) ||
          (search.actionableOnly && !isActionableSearchCandidate(candidate.element)),
      ).length;
      for (const candidate of exactCandidates) {
        if (
          (search.visibleOnly && !isVisibleSearchCandidate(candidate.element)) ||
          (search.actionableOnly && !isActionableSearchCandidate(candidate.element))
        ) {
          excludedExactMatchKeys.add(elementSearchDedupeKey(candidate.element));
        }
      }
      sourceDiagnostics.push({
        source: candidateSnapshot.source,
        snapshotId: candidateSnapshot.snapshotId,
        quality: candidateSnapshot.stats.quality ?? "complete",
        ...(candidateSnapshot.stats.reason ? { reason: candidateSnapshot.stats.reason } : {}),
        truncated: candidateSnapshot.stats.truncated,
        nodeCount: candidateSnapshot.stats.nodeCount,
        ...(candidateSnapshot.stats.capturedBudget !== undefined
          ? { capturedBudget: candidateSnapshot.stats.capturedBudget }
          : {}),
        exactMatchCount: exactCandidates.length,
        excludedExactMatchCount: excludedExact,
        excludedExactMatches: {
          visibility: excludedByVisibility,
          actionability: excludedByActionability,
        },
      });
      ranked.push(
        ...rankedCandidates
          .filter(({ element }) => !search.visibleOnly || isVisibleSearchCandidate(element))
          .filter(({ element }) => !search.actionableOnly || isActionableSearchCandidate(element))
          .map(({ match }) => ({
            match: {
              ...match,
              source: candidateSnapshot.source,
              snapshotId: candidateSnapshot.snapshotId,
            },
            source: candidateSnapshot,
          })),
      );
      excluded.push(
        ...rankedCandidates.flatMap(({ element, match }) => {
          const reasons: Array<"visibility" | "actionability"> = [];
          if (search.visibleOnly && !isVisibleSearchCandidate(element)) reasons.push("visibility");
          if (search.actionableOnly && !isActionableSearchCandidate(element)) {
            reasons.push("actionability");
          }
          if (reasons.length === 0) return [];
          const frame = element.frame?.normalized;
          const offscreen = frame !== undefined && isFrameOffscreen(frame);
          return [
            {
              match: {
                ...match,
                source: candidateSnapshot.source,
                snapshotId: candidateSnapshot.snapshotId,
              },
              source: candidateSnapshot,
              reasons,
              scrollRequired: reasons.includes("visibility") && offscreen,
              ...(reasons.includes("visibility") && offscreen && frame
                ? { suggestedScrollDirection: suggestedScrollDirection(frame) }
                : {}),
            },
          ];
        }),
      );
    }
    const deduplicated = new Map<string, { match: ElementSearchMatch; source: ElementSnapshot }>();
    for (const candidate of ranked) {
      const node = candidate.match.element;
      const key = elementSearchDedupeKey(node);
      const existing = deduplicated.get(key);
      const nativeActionable =
        candidate.source.source !== "react-native-fiber" && isActionableSearchCandidate(node);
      const existingNativeActionable =
        existing &&
        existing.source.source !== "react-native-fiber" &&
        isActionableSearchCandidate(existing.match.element);
      if (
        !existing ||
        (nativeActionable && !existingNativeActionable) ||
        candidate.match.score > existing.match.score
      ) {
        deduplicated.set(key, candidate);
      }
    }
    const ordered = [...deduplicated.values()].sort(
      (left, right) =>
        right.match.score - left.match.score ||
        Number(right.match.exact) - Number(left.match.exact) ||
        left.match.element.ref.localeCompare(right.match.element.ref),
    );
    const deduplicatedExcluded = new Map<string, (typeof excluded)[number]>();
    for (const candidate of excluded) {
      const key = elementSearchDedupeKey(candidate.match.element);
      const existing = deduplicatedExcluded.get(key);
      const candidateIsNative = candidate.source.source !== "react-native-fiber";
      const existingIsNative = existing?.source.source !== "react-native-fiber";
      if (
        !existing ||
        (candidateIsNative && !existingIsNative) ||
        candidate.match.score > existing.match.score
      ) {
        deduplicatedExcluded.set(key, candidate);
      }
    }
    const orderedExcluded = [...deduplicatedExcluded.values()].sort(
      (left, right) =>
        right.match.score - left.match.score ||
        Number(right.match.exact) - Number(left.match.exact) ||
        left.match.element.ref.localeCompare(right.match.element.ref),
    );
    return {
      snapshotId: snapshot?.snapshotId ?? "unavailable",
      query: search,
      searchScope: "current-rendered-tree" as const,
      absenceConclusive: false,
      matches: ordered.slice(0, search.limit).map(({ match }) => match),
      count: Math.min(ordered.length, search.limit),
      total: ordered.length,
      truncated: ordered.length > search.limit,
      sourceTruncated: snapshots.some((candidate) => candidate.stats.truncated),
      excludedExactMatchCount: excludedExactMatchKeys.size,
      excludedCandidateCount: orderedExcluded.length,
      excludedCandidates: orderedExcluded.slice(0, search.limit).map((candidate) => ({
        match: candidate.match,
        reasons: candidate.reasons,
        scrollRequired: candidate.scrollRequired,
        ...(candidate.suggestedScrollDirection
          ? { suggestedScrollDirection: candidate.suggestedScrollDirection }
          : {}),
      })),
      sources: sourceDiagnostics,
    };
  }

  async #semanticTargetSnapshots(ref?: string): Promise<ElementSnapshot[]> {
    const currentSnapshots = () => {
      const native = this.lastAccessibility;
      const projected = this.lastElements;
      const ordered = ref?.startsWith("rn:") ? [projected, native] : [native, projected];
      return ordered.filter(
        (snapshot, index, snapshots): snapshot is ElementSnapshot =>
          snapshot !== undefined &&
          snapshots.findIndex((candidate) => candidate?.snapshotId === snapshot.snapshotId) ===
            index,
      );
    };
    const cached = currentSnapshots();
    if (
      ref &&
      cached.some((snapshot) =>
        flattenAccessibilityTree(snapshot.root).some((node) => node.ref === ref),
      )
    ) {
      return cached;
    }
    if (this.#latestObservation || (!this.lastAccessibility && !this.lastElements)) {
      await this.preparedElementSnapshot();
    }
    return currentSnapshots();
  }

  inspectPoint(x: number, y: number) {
    return this.requireClient().request("accessibility.elementAtPoint", {
      ...selectedDeviceParams(this.device),
      x,
      y,
    });
  }

  async previewPackets(
    afterSequence?: number,
    maxPackets = 12,
    timeoutMs = 1_500,
  ): Promise<PreviewPacketBatch> {
    await this.enablePreview(true);
    const packetLimit = Math.min(30, Math.max(1, maxPackets));
    const waitLimit = Math.min(5_000, Math.max(50, timeoutMs));
    const oldestSequence = this.#previewPackets[0]?.sequence;
    const reset =
      afterSequence === undefined ||
      afterSequence > this.#previewSequence ||
      this.#previewSequence - afterSequence > PREVIEW_MAX_LAG_PACKETS ||
      (oldestSequence !== undefined && afterSequence < oldestSequence - 1);

    if (reset) {
      const cachedPackets = packetsFromLatestKeyframe(this.#previewPackets, packetLimit);
      if (this.#h264Configuration && cachedPackets.length > 0) {
        return {
          reset: true,
          configuration: this.#h264Configuration.slice(),
          packets: cachedPackets,
          nextSequence: cachedPackets.at(-1)?.sequence ?? 0,
        };
      }

      const requestedAfter = this.#previewSequence;
      await this.requireClient().request("capture.keyframe", {});
      await this.#waitForPreview(
        () =>
          Boolean(
            this.#h264Configuration &&
              this.#previewPackets.some(
                (packet) => packet.keyframe && packet.sequence > requestedAfter,
              ),
          ),
        waitLimit,
      );

      const packets = packetsFromLatestKeyframe(this.#previewPackets, packetLimit, requestedAfter);
      return {
        reset: true,
        configuration: this.#h264Configuration?.slice(),
        packets,
        nextSequence: packets.at(-1)?.sequence ?? afterSequence ?? 0,
      };
    }

    await this.#waitForPreview(() => this.#previewSequence > afterSequence, waitLimit);
    const packets = this.#previewPackets
      .filter((packet) => packet.sequence > afterSequence)
      .slice(0, packetLimit);
    return {
      reset: false,
      packets,
      nextSequence: packets.at(-1)?.sequence ?? afterSequence,
    };
  }

  probeStatus() {
    return this.requireClient().request("probe.status", {});
  }

  probeTarget() {
    this.requireCapability("uikitProbe", "UIKit probe");
    return this.requireClient().request("probe.target", selectedDeviceParams(this.device));
  }

  enableProbe(bundleId: string) {
    this.requireCapability("uikitProbe", "UIKit probe");
    return this.requireClient().request("probe.enable", {
      ...selectedDeviceParams(this.device),
      bundleId,
    });
  }

  disableProbe() {
    this.requireCapability("uikitProbe", "UIKit probe");
    return this.requireClient().request("probe.disable", selectedDeviceParams(this.device));
  }

  probeContext() {
    return this.requireClient().request("probe.context", {});
  }

  probeInspectPoint(x: number, y: number) {
    return this.requireClient().request("probe.inspectPoint", { x, y });
  }

  addAnnotation(
    input: Omit<Annotation, "id" | "createdAt" | "frameId"> & {
      frameId?: string | undefined;
    },
  ): Annotation {
    const annotation: Annotation = {
      ...input,
      id: randomUUID(),
      frameId: input.frameId ?? this.frameId ?? "current",
      createdAt: new Date().toISOString(),
    };
    this.annotations.set(annotation.id, annotation);
    return annotation;
  }

  updateAnnotation(
    id: string,
    patch: {
      note?: Annotation["note"] | undefined;
      geometry?: Annotation["geometry"] | undefined;
    },
  ): Annotation {
    const current = this.annotations.get(id);
    if (!current) throw new Error(`Annotation ${id} does not exist`);
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<Pick<Annotation, "note" | "geometry">>;
    const updated = { ...current, ...definedPatch };
    this.annotations.set(id, updated);
    return updated;
  }

  deleteAnnotation(id: string): boolean {
    return this.annotations.delete(id);
  }

  startRelay(port = 0): void {
    this.#assertOpen();
    if (this.relay) return;
    const session = this;
    this.relay = Bun.serve<ViewerData>({
      hostname: "127.0.0.1",
      port,
      async fetch(request, server) {
        const url = new URL(request.url);
        const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
        if (url.pathname === "/") {
          return new Response(await browserHtml(session.appRoot), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                `default-src 'self'; connect-src 'self' ws://${server.hostname}:${server.port}; ` +
                "img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
            },
          });
        }
        if (url.pathname === "/preview.js") {
          return previewScriptResponse(undefined, session.appRoot);
        }
        if (url.pathname === "/stream") {
          const codec: StreamCodec = url.searchParams.get("codec") === "mjpeg" ? "mjpeg" : "h264";
          const upgraded = server.upgrade(request, {
            data: {
              codec,
              authenticated: false,
              paused: false,
              waitingForKeyframe: false,
            },
          });
          return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
        }
        if (!bearer || !secureTokenEquals(bearer, session.relayToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          if (url.pathname === "/state") {
            return Response.json(await session.refreshDevice(), {
              headers: { "cache-control": "no-store" },
            });
          }
          if (url.pathname === "/devices") {
            return Response.json({ devices: await session.devices() });
          }
          if (url.pathname === "/device" && request.method === "POST") {
            const { deviceId, udid } = z
              .object({
                deviceId: z.string().min(1).optional(),
                udid: z.string().min(1).optional(),
              })
              .refine((value) => Boolean(value.deviceId || value.udid), {
                message: "deviceId or udid is required",
              })
              .parse(await request.json());
            const selectedId = deviceId ?? udid;
            if (!selectedId) throw new Error("deviceId or udid is required");
            return Response.json(await session.selectDevice(selectedId));
          }
          if (url.pathname === "/input" && request.method === "POST") {
            return Response.json(
              await session.dispatchInput(relayInputSchema.parse(await request.json())),
            );
          }
          if (url.pathname === "/annotation" && request.method === "POST") {
            const body = annotationMutationSchema.parse(await request.json());
            if (body.action === "delete") {
              return Response.json({ deleted: session.deleteAnnotation(body.id), id: body.id });
            }
            if (body.action === "update") {
              return Response.json(
                session.updateAnnotation(body.id, {
                  geometry: body.geometry,
                  note: body.note,
                }),
              );
            }
            return Response.json(
              session.addAnnotation({
                frameId: body.frameId,
                geometry: body.geometry,
                note: body.note,
                context: body.context,
              }),
            );
          }
          if (url.pathname === "/review-images" && request.method === "POST") {
            return Response.json(
              await session.saveReviewImages(
                saveReviewImagesInputSchema.parse(await request.json()),
              ),
            );
          }
          if (url.pathname === "/accessibility") {
            const scope = url.searchParams.get("scope");
            const requestedMaxNodes = Number(url.searchParams.get("maxNodes"));
            return Response.json(
              await session.accessibilitySnapshot(
                scope === "visible" || scope === "full" ? scope : "interactive",
                Number.isFinite(requestedMaxNodes)
                  ? Math.min(1_200, Math.max(1, requestedMaxNodes))
                  : 1_200,
              ),
            );
          }
          if (url.pathname === "/elements") {
            const scope = url.searchParams.get("scope");
            const requestedMaxNodes = Number(url.searchParams.get("maxNodes"));
            return Response.json(
              await session.elementSnapshot(
                scope === "visible" || scope === "full" ? scope : "interactive",
                Number.isFinite(requestedMaxNodes)
                  ? Math.min(1_200, Math.max(1, requestedMaxNodes))
                  : 1_200,
              ),
            );
          }
          if (url.pathname === "/inspect-point") {
            const { x, y } = normalizedPointSchema.parse({
              x: Number(url.searchParams.get("x")),
              y: Number(url.searchParams.get("y")),
            });
            const element = await session.inspectPoint(x, y);
            const probe = session.device?.capabilities.uikitProbe
              ? await session.probeStatus()
              : undefined;
            const native = probe?.connected ? await session.probeInspectPoint(x, y) : undefined;
            return Response.json({ element, native, probe });
          }
          if (url.pathname === "/probe/status") {
            return Response.json(await session.probeStatus());
          }
          if (url.pathname === "/probe/target") {
            return Response.json(await session.probeTarget());
          }
          if (url.pathname === "/probe/enable" && request.method === "POST") {
            const { bundleId } = z
              .object({ bundleId: z.string().trim().min(3) })
              .parse(await request.json());
            if (bundleId.startsWith("com.apple.")) {
              return new Response("Apple platform apps cannot load the UIKit probe", {
                status: 400,
              });
            }
            return Response.json(await session.enableProbe(bundleId));
          }
          if (url.pathname === "/probe/context") {
            return Response.json(await session.probeContext());
          }
          return new Response("Not found", { status: 404 });
        } catch (error) {
          if (error instanceof z.ZodError || error instanceof SyntaxError) {
            return new Response("Invalid request", { status: 400 });
          }
          return new Response("Relay request failed", { status: 500 });
        }
      },
      websocket: {
        open(socket) {
          socket.data.authenticationTimer = setTimeout(() => {
            if (!socket.data.authenticated) socket.close(1008, "Authentication timed out");
          }, 2_000);
        },
        message(socket, message) {
          if (socket.data.authenticated || typeof message !== "string") return;
          let body: unknown;
          try {
            body = JSON.parse(message);
          } catch {
            socket.close(1008, "Authentication failed");
            return;
          }
          const authentication = relayAuthenticationSchema.safeParse(body);
          if (
            !authentication.success ||
            !secureTokenEquals(authentication.data.token, session.relayToken)
          ) {
            socket.close(1008, "Authentication failed");
            return;
          }
          socket.data.authenticated = true;
          clearTimeout(socket.data.authenticationTimer);
          session.viewers.add(socket);
          void session.enablePreview(true).catch(() => {
            socket.close(1011, "Unable to enable preview capture");
          });
          if (socket.data.codec === "h264") {
            socket.data.waitingForKeyframe = true;
            if (session.#h264Configuration) {
              session.#sendFrame(socket, FrameKind.H264Configuration, session.#h264Configuration);
            }
            void session
              .requireClient()
              .request("capture.keyframe", {})
              .catch(() => {});
          } else {
            void session.#ensureMjpegClient().catch(() => {
              socket.close(1011, "Unable to start MJPEG fallback");
            });
          }
        },
        close(socket) {
          clearTimeout(socket.data.authenticationTimer);
          session.viewers.delete(socket);
          if (session.viewers.size === 0) void session.enablePreview(false).catch(() => {});
        },
        drain(socket) {
          socket.data.paused = false;
          if (socket.data.codec === "h264") {
            socket.data.waitingForKeyframe = true;
            void session
              .requireClient()
              .request("capture.keyframe", {})
              .catch(() => {});
          }
        },
      },
    });
  }

  requireClient(): SimViewClient {
    this.#assertOpen();
    if (!this.client?.connected) {
      throw new Error("No device is connected; call connect_device before using device controls");
    }
    return this.client;
  }

  requireCapability(
    capability: "orientation" | "accessibility" | "androidContext" | "uikitProbe",
    label: string,
  ): void {
    if (!this.device?.capabilities[capability]) {
      throw new Error(`${label} is not supported by the selected device`);
    }
  }

  async dispatchInput(input: z.output<typeof relayInputSchema>): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    const capabilities = this.device?.capabilities.input;
    if (!capabilities) throw new Error("The selected device has no input capabilities");
    this.#clearSemanticState();
    switch (input.method) {
      case "input.touch":
        if (!(capabilities.rawTouch ?? capabilities.touch))
          throw new Error("Raw touch is not supported by the selected device");
        return client.request(input.method, input.params);
      case "input.tap":
        if (!capabilities.touch) throw new Error("Tap is not supported by the selected device");
        return client.request(input.method, input.params);
      case "input.longPress":
        if (!capabilities.touch)
          throw new Error("Long press is not supported by the selected device");
        return client.request(input.method, input.params);
      case "input.swipe":
        if (!capabilities.touch) throw new Error("Swipe is not supported by the selected device");
        return client.request(input.method, input.params);
      case "input.gesture":
        if (input.params.tracks.length > 1 && !capabilities.multiTouch) {
          throw new Error("Multi-touch gestures are not supported by the selected device runtime");
        }
        if (!(capabilities.rawTouch ?? capabilities.touch)) {
          throw new Error("Continuous gestures are not supported by the selected device");
        }
        return client.request(input.method, input.params);
      case "input.typeText":
        if (capabilities.text === "none")
          throw new Error("Text input is not supported by the selected device");
        return client.request(input.method, input.params);
      case "input.key":
        return client.request(input.method, input.params);
      case "input.button":
        if (!capabilities.buttons.includes(input.params.button)) {
          throw new Error(`${input.params.button} is not supported by the selected device`);
        }
        return client.request(input.method, input.params);
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#connectionGeneration += 1;
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    for (const viewer of this.viewers) viewer.close(1001, "SimView review closed");
    this.viewers.clear();
    this.relay?.stop(true);
    this.relay = undefined;
    this.#metroInspector.close();
    if (this.mjpegClient) await this.mjpegClient.close();
    this.mjpegClient = undefined;
    this.#mjpegClientPromise = undefined;
    if (this.client) await this.client.close();
    this.client = undefined;
    await this.#connectionTail;
    this.device = undefined;
    this.frameId = undefined;
    this.#latestObservation = undefined;
    this.#clearSemanticState();
    this.#annotationsByDevice.clear();
    this.#resetPreviewPackets();
    await Promise.all(
      [...this.#reviewImageDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => {}),
      ),
    );
    this.#reviewImageDirectories.clear();
  }

  async #nativeIOSScreenContext(
    accessibility: AccessibilitySnapshot,
    frameId: string,
  ): Promise<ScreenContext> {
    const device = this.device;
    if (device?.platform === "android") {
      let nativeContext: Record<string, unknown> = {};
      if (device.capabilities.androidContext) {
        try {
          nativeContext = await this.requireClient().request("device.context", {});
        } catch {
          // UIAutomator output remains useful without package/activity context.
        }
      }
      return {
        schemaVersion: 1,
        kind: "android",
        platform: "android",
        capturedAt: new Date().toISOString(),
        frameId,
        deviceName: device.name,
        runtime: device.runtime,
        viewport: accessibility.screen,
        orientation:
          accessibility.screen.width > accessibility.screen.height ? "landscape" : "portrait",
        packageName:
          typeof nativeContext.package === "string"
            ? nativeContext.package
            : typeof nativeContext.packageName === "string"
              ? nativeContext.packageName
              : undefined,
        activityName:
          typeof nativeContext.activity === "string"
            ? nativeContext.activity
            : typeof nativeContext.activityName === "string"
              ? nativeContext.activityName
              : undefined,
        processId:
          typeof nativeContext.processId === "number" ? nativeContext.processId : undefined,
        taskId: typeof nativeContext.taskId === "number" ? nativeContext.taskId : undefined,
      };
    }
    const base = {
      schemaVersion: 1 as const,
      kind: "native-ios" as const,
      platform: "ios" as const,
      capturedAt: new Date().toISOString(),
      frameId,
      simulatorName: device?.name,
      deviceName: device?.name,
      runtime: device?.runtime,
      viewport: accessibility.screen,
      orientation:
        accessibility.screen.width > accessibility.screen.height
          ? ("landscape" as const)
          : ("portrait" as const),
    };
    try {
      const status = await this.probeStatus();
      const target = status.connected ? undefined : await this.probeTarget();
      const context = status.connected
        ? uiContextSchema.shape.context.unwrap().parse(await this.probeContext())
        : undefined;
      const scene =
        context?.scenes?.find((candidate) => candidate.activationState === "foregroundActive") ??
        context?.scenes?.[0];
      const window =
        scene?.windows?.find((candidate) => candidate.key && !candidate.hidden) ??
        scene?.windows?.find((candidate) => !candidate.hidden);
      return {
        ...base,
        bundleId: target?.bundleId ?? status.bundleId,
        controllerPath: window?.visibleControllerPath,
        windowClass: window?.className,
        sceneDelegate: scene?.delegateClass,
        sceneConfiguration: scene?.configurationName,
      };
    } catch {
      return base;
    }
  }

  #bindFrames(): void {
    const client = this.requireClient();
    this.#unsubscribers.push(
      client.onDisconnect(() => {
        if (this.client !== client) return;
        this.#connectionGeneration += 1;
        for (const unsubscribe of this.#unsubscribers) unsubscribe();
        this.#unsubscribers = [];
        this.client = undefined;
        this.frameId = undefined;
        this.#latestObservation = undefined;
        this.#clearSemanticState();
        this.#metroInspector.close();
        this.#resetPreviewPackets();
        if (this.mjpegClient) void this.mjpegClient.close().catch(() => {});
        this.mjpegClient = undefined;
        this.#mjpegClientPromise = undefined;
      }),
    );
    for (const kind of [FrameKind.H264Configuration, FrameKind.H264Frame]) {
      this.#unsubscribers.push(
        client.on(kind, (payload) => {
          if (kind === FrameKind.H264Configuration) {
            this.#h264Configuration = payload.slice();
          }
          if (kind === FrameKind.H264Frame && payload.byteLength >= 9) {
            this.frameId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
              .getBigUint64(0, false)
              .toString();
            this.#previewSequence += 1;
            this.#previewPackets.push({
              sequence: this.#previewSequence,
              kind: FrameKind.H264Frame,
              payload: payload.slice(),
              keyframe: payload[8] === 1,
            });
            if (this.#previewPackets.length > PREVIEW_PACKET_LIMIT) {
              this.#previewPackets.splice(0, this.#previewPackets.length - PREVIEW_PACKET_LIMIT);
            }
          }
          this.#notifyPreviewWaiters();
          let message: Uint8Array | undefined;
          for (const viewer of this.viewers) {
            if (viewer.data.codec === "h264" && viewer.readyState === WebSocket.OPEN) {
              if (viewer.data.paused) continue;
              if (kind === FrameKind.H264Frame && viewer.data.waitingForKeyframe) {
                if (payload[8] !== 1) continue;
                if (!this.#h264Configuration) continue;
                this.#sendFrame(viewer, FrameKind.H264Configuration, this.#h264Configuration);
                viewer.data.waitingForKeyframe = false;
              }
              message ??= previewMessage(kind, payload);
              const status = viewer.send(message);
              if (status < 0) {
                viewer.data.paused = true;
              } else if (status === 0 && kind === FrameKind.H264Frame) {
                viewer.data.waitingForKeyframe = true;
                void this.requireClient()
                  .request("capture.keyframe", {})
                  .catch(() => {});
              }
            }
          }
        }),
      );
    }
  }

  #ensureMjpegClient(): Promise<SimViewClient> {
    if (this.mjpegClient) return Promise.resolve(this.mjpegClient);
    if (this.#mjpegClientPromise) return this.#mjpegClientPromise;
    const primary = this.requireClient();
    const generation = this.#connectionGeneration;
    this.#mjpegClientPromise = SimViewClient.attach(primary.socketPath, primary.token, "mjpeg")
      .then(async (client) => {
        if (generation !== this.#connectionGeneration) {
          await client.close();
          throw new Error("Simulator changed while the MJPEG fallback was connecting");
        }
        this.mjpegClient = client;
        this.#unsubscribers.push(
          client.on(FrameKind.JpegFrame, (payload) => {
            for (const viewer of this.viewers) {
              if (viewer.data.codec === "mjpeg" && viewer.readyState === WebSocket.OPEN) {
                if (viewer.data.paused) continue;
                if (this.#sendFrame(viewer, FrameKind.JpegFrame, payload) < 0) {
                  viewer.data.paused = true;
                }
              }
            }
          }),
        );
        return client;
      })
      .finally(() => {
        this.#mjpegClientPromise = undefined;
      });
    return this.#mjpegClientPromise;
  }

  #sendFrame(viewer: ServerWebSocket<ViewerData>, kind: FrameKind, payload: Uint8Array): number {
    return viewer.send(previewMessage(kind, payload));
  }

  async #waitForPreview(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.#previewWaiters.delete(finish);
          resolve();
        };
        const timeout = setTimeout(finish, remaining);
        this.#previewWaiters.add(finish);
      });
    }
  }

  #notifyPreviewWaiters(): void {
    const waiters = [...this.#previewWaiters];
    this.#previewWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  #resetPreviewPackets(): void {
    this.#h264Configuration = undefined;
    this.#previewSequence = 0;
    this.#previewPackets = [];
    this.#notifyPreviewWaiters();
  }

  #cacheFiber(key: string, output: ElementTreeOutput): void {
    const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
    if (bytes > 8 * 1024 * 1024) return;
    this.#fiberCache.delete(key);
    this.#fiberCache.set(key, { expiresAt: Date.now() + 5_000, bytes, output });
    const cachedBytes = () =>
      [...this.#fiberCache.values()].reduce((total, entry) => total + entry.bytes, 0);
    while (this.#fiberCache.size > 2 || cachedBytes() > 8 * 1024 * 1024) {
      const oldest = this.#fiberCache.keys().next().value;
      if (oldest === undefined) break;
      this.#fiberCache.delete(oldest);
    }
  }

  #cacheSemantic(key: string, output: ElementTreeOutput): void {
    const now = Date.now();
    for (const [cachedKey, entry] of this.#semanticCache) {
      if (entry.expiresAt <= now) this.#semanticCache.delete(cachedKey);
    }
    this.#semanticCache.delete(key);
    this.#semanticCache.set(key, { expiresAt: now + 5_000, output });
    while (this.#semanticCache.size > 2) {
      const oldest = this.#semanticCache.keys().next().value;
      if (oldest === undefined) break;
      this.#semanticCache.delete(oldest);
    }
  }

  #semanticHashFor(snapshot: AccessibilitySnapshot): string {
    const resource = this.#latestAccessibilityResource;
    if (
      resource?.snapshot.snapshotId === snapshot.snapshotId &&
      resource.snapshot.capturedAt === snapshot.capturedAt
    ) {
      return resource.semanticHash;
    }
    return accessibilityResourceSemanticHash(snapshot);
  }

  #clearSemanticState(): void {
    this.#semanticGeneration += 1;
    this.#semanticRefresh.clear();
    this.lastAccessibility = undefined;
    this.lastElements = undefined;
    this.lastScreenContext = undefined;
    this.#latestAccessibilityObservation = undefined;
    this.#latestAccessibilityResource = undefined;
    this.#fiberCache.clear();
    this.#semanticCache.clear();
  }

  async #primeObservation(): Promise<void> {
    try {
      await this.warmObservation({ visual: false, maxWaitMs: 500 });
      await this.preparedElementSnapshot(240);
    } catch {
      // Foreground observations retry both warm frame and semantics with bounded deadlines.
    }
  }
}

function matchesDeviceId(device: DeviceDescription | undefined, requested: string): boolean {
  return Boolean(
    device && (device.id === requested || device.udid === requested || device.serial === requested),
  );
}

const ACTIONABLE_ROLE_MARKERS = [
  "button",
  "link",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "textfield",
  "searchfield",
  "combobox",
  "menuitem",
  "cell",
];

function strategyForSnapshot(
  snapshot: AccessibilitySnapshot,
): AccessibilityObservation["strategy"] {
  switch (snapshot.source) {
    case "core-simulator-ax":
      return "ios-axp";
    case "core-simulator-xctest":
      return "snapshot-diff";
    case "android-agent-shell":
      return "android-shell-dump";
    case "android-uiautomator":
    case "android-agent-uiautomation":
      return "android-uiautomation";
  }
}

const normalizeSearchText = normalizeSemanticSearchText;

function matchingElements(
  snapshot: ElementSnapshot,
  selector: DestinationSelector,
): AccessibilityNode[] {
  const exact = selector.exact ?? true;
  const matches = (actual: string | undefined, expected: string | undefined) =>
    expected === undefined ||
    (actual !== undefined &&
      (exact
        ? actual.localeCompare(expected, undefined, { sensitivity: "accent" }) === 0
        : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())));
  return flattenAccessibilityTree(snapshot.root).filter(
    (node) =>
      matches(node.ref, selector.ref) &&
      matches(node.testID ?? node.identifier, selector.identifier) &&
      matches(node.role, selector.role) &&
      matchesAccessibleName(accessibleName(node), selector.name, exact) &&
      matches(node.value, selector.value) &&
      matches(node.placeholder, selector.placeholder) &&
      (selector.checked === undefined || node.checked === selector.checked) &&
      (selector.enabled === undefined || node.enabled === selector.enabled) &&
      (selector.selected === undefined || node.selected === selector.selected),
  );
}

function selectorDiagnostics(
  snapshot: ElementSnapshot,
  selector: AccessibilitySelector,
): SelectorDiagnostics {
  const requestedFieldsWithMatches = (
    ["ref", "identifier", "role", "name", "value", "placeholder"] as const
  ).flatMap((field) => {
    const expected = selector[field];
    if (expected === undefined) return [];
    const fieldSelector = {
      [field]: expected,
      exact: selector.exact ?? true,
    } as DestinationSelector;
    const matches = matchingElements(snapshot, fieldSelector);
    return [{ field, matches }];
  });
  const populatedFields = requestedFieldsWithMatches.filter((field) => field.matches.length > 0);
  let commonRefs: Set<string> | undefined;
  for (const field of populatedFields) {
    const refs = new Set(field.matches.map((node) => node.ref));
    if (commonRefs === undefined) {
      commonRefs = refs;
      continue;
    }
    for (const ref of commonRefs) {
      if (!refs.has(ref)) commonRefs.delete(ref);
    }
  }
  const splitAcrossNodes = populatedFields.length >= 2 && (commonRefs?.size ?? 0) === 0;
  const relationship = splitAcrossNodes
    ? selectorDiagnosticRelationship(
        snapshot,
        populatedFields.flatMap((field) => field.matches),
      )
    : undefined;
  return {
    fields: requestedFieldsWithMatches.map(({ field, matches }) => ({
      field,
      matchCount: matches.length,
      matches: matches.slice(0, 2),
    })),
    splitAcrossNodes,
    ...(relationship ? { relationship } : {}),
  };
}

function selectorDiagnosticRelationship(
  snapshot: ElementSnapshot,
  nodes: AccessibilityNode[],
): "ancestor-descendant" | "separate" {
  const parents = new Map<string, string>();
  const visit = (node: AccessibilityNode) => {
    for (const child of node.children ?? []) {
      parents.set(child.ref, node.ref);
      visit(child);
    }
  };
  visit(snapshot.root);
  const isAncestor = (ancestor: string, descendant: string) => {
    let current = parents.get(descendant);
    while (current) {
      if (current === ancestor) return true;
      current = parents.get(current);
    }
    return false;
  };
  for (const [index, left] of nodes.entries()) {
    for (const right of nodes.slice(index + 1)) {
      if (isAncestor(left.ref, right.ref) || isAncestor(right.ref, left.ref)) {
        return "ancestor-descendant";
      }
    }
  }
  return "separate";
}

function accessibleName(node: AccessibilityNode): string | undefined {
  return node.label ?? node.title ?? (node.valueRedacted ? undefined : node.value);
}

function destinationSelectorSuggestions(
  snapshot: AccessibilitySnapshot,
  selector: DestinationSelector,
): DestinationSelectorSuggestion[] {
  const requested = [
    selector.identifier,
    selector.name,
    selector.value,
    selector.placeholder,
    selector.role,
  ]
    .filter(isDefined)
    .map(normalizeSearchText)
    .filter(Boolean);
  const requestedTokens = new Set(requested.flatMap((value) => value.split(" ").filter(Boolean)));
  if (requestedTokens.size === 0) return [];

  const ranked = flattenAccessibilityTree(snapshot.root)
    .filter(isVisibleSearchCandidate)
    .map((node) => {
      const identifier = node.testID ?? node.identifier;
      const name = node.label ?? node.title;
      const value = node.valueRedacted ? undefined : node.value;
      const placeholder = node.placeholder;
      const role = node.role ?? node.roleDescription;
      const fields = [identifier, name, value, placeholder, role]
        .filter(isDefined)
        .map(normalizeSearchText)
        .filter(Boolean);
      const candidateTokens = new Set(fields.flatMap((field) => field.split(" ").filter(Boolean)));
      const overlap = [...requestedTokens].filter((token) => candidateTokens.has(token)).length;
      if (overlap === 0) return undefined;
      const options = [
        identifier
          ? { suggestion: { identifier, exact: true } as DestinationSelectorSuggestion, weight: 3 }
          : undefined,
        name
          ? { suggestion: { name, exact: true } as DestinationSelectorSuggestion, weight: 2 }
          : undefined,
        value
          ? { suggestion: { value, exact: true } as DestinationSelectorSuggestion, weight: 1 }
          : undefined,
        placeholder
          ? {
              suggestion: { placeholder, exact: true } as DestinationSelectorSuggestion,
              weight: 0.9,
            }
          : undefined,
      ].filter(isDefined);
      const best = options
        .map((option) => {
          const raw =
            option.suggestion.identifier ??
            option.suggestion.name ??
            option.suggestion.value ??
            option.suggestion.placeholder;
          const normalized = normalizeSearchText(raw ?? "");
          const optionTokens = new Set(normalized.split(" ").filter(Boolean));
          const optionOverlap = [...requestedTokens].filter((token) =>
            optionTokens.has(token),
          ).length;
          return {
            suggestion: option.suggestion,
            score: (requested.includes(normalized) ? 100 : 0) + optionOverlap * 10 + option.weight,
          };
        })
        .sort((left, right) => right.score - left.score)[0];
      return best;
    })
    .filter(isDefined)
    .sort((left, right) => right.score - left.score);

  const deduplicated = new Map<string, DestinationSelectorSuggestion>();
  for (const candidate of ranked) {
    const key = JSON.stringify(candidate.suggestion);
    if (!deduplicated.has(key)) deduplicated.set(key, candidate.suggestion);
    if (deduplicated.size === 3) break;
  }
  return [...deduplicated.values()];
}

function matchesAccessibleName(
  actual: string | undefined,
  expected: string | undefined,
  exact: boolean,
): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  if (!exact) return actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
  if (actual.localeCompare(expected, undefined, { sensitivity: "accent" }) === 0) return true;
  const prefix = actual.slice(0, expected.length);
  return (
    prefix.localeCompare(expected, undefined, { sensitivity: "accent" }) === 0 &&
    /^[,;\n\r(]/u.test(actual.slice(expected.length))
  );
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isTappableElement(node: AccessibilityNode): boolean {
  return isActionableSearchCandidate(node) && isVisibleSearchCandidate(node);
}

type SemanticFingerprint = {
  identifier?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  placeholder?: string | undefined;
};

type SemanticFingerprintField = keyof SemanticFingerprint;

function semanticFingerprint(node: AccessibilityNode): SemanticFingerprint {
  return {
    ...((node.testID ?? node.identifier) ? { identifier: node.testID ?? node.identifier } : {}),
    ...((node.role ?? node.roleDescription) ? { role: node.role ?? node.roleDescription } : {}),
    ...((node.label ?? node.title) ? { name: node.label ?? node.title } : {}),
    ...(!node.valueRedacted && node.value ? { value: node.value } : {}),
    ...(node.placeholder ? { placeholder: node.placeholder } : {}),
  };
}

function matchesFingerprint(node: AccessibilityNode, fingerprint: SemanticFingerprint): boolean {
  const nodeRole = node.role ?? node.roleDescription;
  return (
    (!fingerprint.identifier ||
      node.testID === fingerprint.identifier ||
      node.identifier === fingerprint.identifier) &&
    (!fingerprint.role ||
      (nodeRole !== undefined &&
        normalizeFingerprintRole(nodeRole) === normalizeFingerprintRole(fingerprint.role))) &&
    (!fingerprint.name ||
      matchesAccessibleName(node.label ?? node.title, fingerprint.name, true)) &&
    (!fingerprint.value || (!node.valueRedacted && node.value === fingerprint.value)) &&
    (!fingerprint.placeholder || node.placeholder === fingerprint.placeholder)
  );
}

function corroborateFiberTarget(
  snapshot: AccessibilitySnapshot,
  fingerprint: SemanticFingerprint,
): {
  matches: AccessibilityNode[];
  fields: SemanticFingerprintField[];
} {
  const nodes = flattenAccessibilityTree(snapshot.root);
  if (fingerprint.identifier) {
    const matches = nodes.filter(
      (node) =>
        hasActionSemantics(node) &&
        (node.testID === fingerprint.identifier || node.identifier === fingerprint.identifier),
    );
    if (matches.length > 0) return { matches, fields: ["identifier"] };
  }

  // React Native testIDs are not guaranteed to be exported through iOS AX.
  // When that happens, an exact accessible name may bridge discovery to the
  // native target, but only if optional role/value evidence does not conflict.
  if (!fingerprint.name) return { matches: [], fields: [] };
  const fields: SemanticFingerprintField[] = ["name"];
  const matches = nodes.filter((node) => {
    if (!hasActionSemantics(node)) return false;
    if (!matchesAccessibleName(node.label ?? node.title, fingerprint.name, true)) return false;
    const nodeRole = node.role ?? node.roleDescription;
    if (
      fingerprint.role &&
      nodeRole &&
      isSpecificFingerprintRole(fingerprint.role) &&
      isSpecificFingerprintRole(nodeRole) &&
      normalizeFingerprintRole(nodeRole) !== normalizeFingerprintRole(fingerprint.role)
    ) {
      return false;
    }
    if (
      fingerprint.value &&
      !node.valueRedacted &&
      node.value &&
      node.value !== fingerprint.value
    ) {
      return false;
    }
    return true;
  });
  if (
    fingerprint.role &&
    matches.some((node) => {
      const role = node.role ?? node.roleDescription;
      return (
        role !== undefined &&
        isSpecificFingerprintRole(role) &&
        normalizeFingerprintRole(role) === normalizeFingerprintRole(fingerprint.role ?? "")
      );
    })
  ) {
    fields.push("role");
  }
  if (
    fingerprint.value &&
    matches.some((node) => !node.valueRedacted && node.value === fingerprint.value)
  ) {
    fields.push("value");
  }
  return { matches, fields };
}

function isSpecificFingerprintRole(role: string): boolean {
  return !["", "element", "genericelement", "view"].includes(normalizeFingerprintRole(role));
}

function normalizeFingerprintRole(role: string): string {
  return normalizeSearchText(role).replace(/^ax/u, "").replaceAll(" ", "");
}

function suggestedScrollDirection(
  frame: NonNullable<AccessibilityNode["frame"]>["normalized"],
): "up" | "down" | "left" | "right" {
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  const horizontalOverflow = overflowFromUnitInterval(centerX);
  const verticalOverflow = overflowFromUnitInterval(centerY);
  if (Math.abs(verticalOverflow) >= Math.abs(horizontalOverflow)) {
    return centerY > 1 ? "up" : "down";
  }
  return centerX > 1 ? "left" : "right";
}

function overflowFromUnitInterval(value: number): number {
  if (value < 0) return value;
  if (value > 1) return value - 1;
  return 0;
}

function isVisibleSearchCandidate(node: AccessibilityNode): boolean {
  const frame = node.frame?.normalized;
  return (
    node.hidden !== true &&
    frame !== undefined &&
    frame.width > 0 &&
    frame.height > 0 &&
    frame.x + frame.width > 0 &&
    frame.y + frame.height > 0 &&
    frame.x < 1 &&
    frame.y < 1
  );
}

function isFrameOffscreen(frame: NonNullable<AccessibilityNode["frame"]>["normalized"]): boolean {
  return frame.x + frame.width <= 0 || frame.y + frame.height <= 0 || frame.x >= 1 || frame.y >= 1;
}

function isActionableSearchCandidate(node: AccessibilityNode): boolean {
  if (node.enabled === false || node.hidden === true) return false;
  return hasActionSemantics(node);
}

function actionabilityDiagnostics(
  snapshot: AccessibilitySnapshot,
  target: AccessibilityNode,
): ActionabilityDiagnostics {
  let targetPath: AccessibilityNode[] | undefined;
  const findTarget = (node: AccessibilityNode, path: AccessibilityNode[]): void => {
    if (targetPath) return;
    const nextPath = [...path, node];
    if (node === target || node.ref === target.ref) {
      targetPath = nextPath;
      return;
    }
    for (const child of node.children ?? []) findTarget(child, nextPath);
  };
  findTarget(snapshot.root, []);

  const candidates: Array<{
    relationship: "ancestor" | "descendant";
    node: AccessibilityNode;
    distance: number;
  }> = [];
  const path = targetPath as AccessibilityNode[] | undefined;
  if (path) {
    path
      .slice(0, -1)
      .toReversed()
      .forEach((node, index) => {
        if (isActionableSearchCandidate(node)) {
          candidates.push({ relationship: "ancestor", node, distance: index + 1 });
        }
      });
  }
  const visitDescendants = (node: AccessibilityNode, distance: number): void => {
    for (const child of node.children ?? []) {
      if (isActionableSearchCandidate(child)) {
        candidates.push({ relationship: "descendant", node: child, distance });
      }
      visitDescendants(child, distance + 1);
    }
  };
  visitDescendants(target, 1);
  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      Number(left.relationship === "ancestor") - Number(right.relationship === "ancestor"),
  );
  return {
    targetActionable: isActionableSearchCandidate(target),
    ambiguous: candidates.length > 1,
    candidates: candidates.slice(0, 2).map(({ relationship, node }) => ({ relationship, node })),
  };
}

type SnapshotHit = { node: AccessibilityNode; path: AccessibilityNode[]; depth: number };

function resolveAndroidSnapshotHit(
  snapshot: AccessibilitySnapshot,
  target: AccessibilityNode,
  point: { x: number; y: number },
) {
  const hits: SnapshotHit[] = [];
  const visit = (node: AccessibilityNode, path: AccessibilityNode[]) => {
    const frame = node.frame?.normalized;
    const nextPath = [...path, node];
    if (
      node.hidden !== true &&
      (node.visibleFraction ?? 1) > 0 &&
      frame &&
      frame.width > 0 &&
      frame.height > 0 &&
      point.x >= frame.x &&
      point.x <= frame.x + frame.width &&
      point.y >= frame.y &&
      point.y <= frame.y + frame.height
    ) {
      hits.push({ node, path: nextPath, depth: path.length });
    }
    node.children?.forEach((child) => {
      visit(child, nextPath);
    });
  };
  visit(snapshot.root, []);

  const byDepthThenArea = (left: SnapshotHit, right: SnapshotHit) => {
    if (left.depth !== right.depth) return right.depth - left.depth;
    const leftFrame = left.node.frame?.normalized;
    const rightFrame = right.node.frame?.normalized;
    return (
      (leftFrame ? leftFrame.width * leftFrame.height : Number.POSITIVE_INFINITY) -
      (rightFrame ? rightFrame.width * rightFrame.height : Number.POSITIVE_INFINITY)
    );
  };
  const hitNode = hits.toSorted(byDepthThenArea)[0]?.node;
  const actionable = hits.filter(({ node }) => isActionableSearchCandidate(node));
  const winningDepth = Math.max(...actionable.map(({ depth }) => depth), -1);
  const winners = actionable
    .filter(({ depth }) => depth === winningDepth)
    .toSorted(byDepthThenArea);
  const selected = winners[0];
  const targetHit = hits.find(({ node }) => node === target || node.ref === target.ref);

  const pathContains = (path: AccessibilityNode[], node: AccessibilityNode) =>
    path.some((candidate) => candidate === node || candidate.ref === node.ref);
  const relationship = (candidate: SnapshotHit) => {
    if (candidate.node === target || candidate.node.ref === target.ref) return "self" as const;
    if (targetHit && pathContains(candidate.path.slice(0, -1), target))
      return "descendant" as const;
    if (targetHit && pathContains(targetHit.path.slice(0, -1), candidate.node)) {
      return "ancestor" as const;
    }
    return "unrelated" as const;
  };
  const selectedRelationship = selected ? relationship(selected) : ("unrelated" as const);
  const ambiguous = winners.some(
    (winner) => winner !== selected && winner.node.ref !== selected?.node.ref,
  );
  const hitRelationship = ambiguous ? ("ambiguous" as const) : selectedRelationship;
  const actionableHitNode = ambiguous ? undefined : selected?.node;

  return {
    matchesTarget: !ambiguous && actionableHitNode?.ref === target.ref,
    diagnostics: {
      ...(hitNode ? { hitNode } : {}),
      ...(actionableHitNode ? { actionableHitNode } : {}),
      hitRelationship,
      hitMethod: "snapshot-actionable" as const,
    },
  };
}

function hasActionSemantics(node: AccessibilityNode): boolean {
  if (node.interactive === true || (node.actions?.length ?? 0) > 0) return true;
  const role = normalizeSearchText(node.role ?? "").replaceAll(" ", "");
  return ACTIONABLE_ROLE_MARKERS.some((marker) => role.includes(marker));
}

function elementSearchDedupeKey(node: AccessibilityNode): string {
  const frame = node.frame?.normalized;
  return [
    normalizeSearchText(node.identifier ?? node.label ?? node.title ?? node.ref),
    normalizeSearchText(node.role ?? ""),
    frame
      ? `${Math.round(frame.x * 100)}:${Math.round(frame.y * 100)}:${Math.round(frame.width * 100)}:${Math.round(frame.height * 100)}`
      : node.ref,
  ].join("|");
}

function rankElementSearchMatch(
  element: AccessibilityNode,
  query: string,
): Omit<ElementSearchMatch, "source" | "snapshotId"> | undefined {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return undefined;
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const fields = [
    ["ref", element.ref, 1],
    ["identifier", element.testID ?? element.identifier, 0.95],
    ["name", element.label ?? element.title, 1],
    ["placeholder", element.placeholder, 0.93],
    ["text", element.text, 0.9],
    ["value", element.valueRedacted ? undefined : element.value, 0.86],
    ["help", element.help, 0.75],
    ["role", element.role, 0.65],
    ["component", element.component, 0.6],
  ] as const;
  let score = 0;
  let exact = false;
  const matchedFields = new Set<string>();
  const aggregateTokens = new Set<string>();
  for (const [field, rawValue, weight] of fields) {
    if (!rawValue) continue;
    const value = normalizeSearchText(rawValue);
    if (!value) continue;
    const valueTokens = new Set(value.split(" ").filter(Boolean));
    for (const token of queryTokens) {
      if (valueTokens.has(token)) aggregateTokens.add(token);
    }
    let fieldScore = 0;
    if (value === normalizedQuery) {
      fieldScore = 1;
      exact = true;
    } else if (value.startsWith(normalizedQuery)) {
      fieldScore = 0.92;
    } else if (value.includes(normalizedQuery)) {
      fieldScore = 0.84;
    } else {
      const matchedTokenCount = queryTokens.filter((token) => valueTokens.has(token)).length;
      if (matchedTokenCount === queryTokens.length) {
        fieldScore = 0.45 + 0.3 * (matchedTokenCount / queryTokens.length);
      }
    }
    const weightedScore = fieldScore * weight;
    if (weightedScore <= 0) continue;
    matchedFields.add(field);
    score = Math.max(score, weightedScore);
  }
  if (queryTokens.length >= 2) {
    const coverage = aggregateTokens.size / queryTokens.length;
    const minimumCoverage = queryTokens.length === 2 ? 1 : 0.5;
    if (aggregateTokens.size >= 2 && coverage >= minimumCoverage) {
      score = Math.max(score, 0.35 + 0.35 * coverage);
      for (const [field, rawValue] of fields) {
        if (!rawValue) continue;
        const valueTokens = new Set(normalizeSearchText(rawValue).split(" ").filter(Boolean));
        if ([...aggregateTokens].some((token) => valueTokens.has(token))) matchedFields.add(field);
      }
    }
  }
  if (score === 0) return undefined;
  return {
    element: summarizeAccessibilityNode(element),
    score: Math.round(score * 1_000) / 1_000,
    matchedFields: [...matchedFields],
    exact,
  };
}

function selectedDeviceParams(device: DeviceDescription | undefined): {
  deviceId?: string | undefined;
  udid?: string | undefined;
} {
  return device ? { deviceId: device.id, ...(device.udid ? { udid: device.udid } : {}) } : {};
}

function previewMessage(kind: FrameKind, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(payload.length + 1);
  message[0] = kind;
  message.set(payload, 1);
  return message;
}

async function writePng(path: string, encoded: string): Promise<void> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("Review image is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < signature.length ||
    !signature.every((value, index) => bytes[index] === value)
  ) {
    throw new Error("Review image is not a PNG");
  }
  if (bytes.byteLength > 15_000_000) throw new Error("Review image exceeds 15 MB");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

async function browserHtml(appRoot: string): Promise<string> {
  const built = Bun.file(join(appRoot, "dist", "preview.html"));
  if (await built.exists()) return built.text();
  return Bun.file(join(appRoot, "src", "preview.html")).text();
}

function secureTokenEquals(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}
