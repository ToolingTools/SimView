import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccessibilitySelector,
  type AccessibilitySnapshot,
  type Annotation,
  type DeviceDescription,
  type ElementSnapshot,
  FrameKind,
  flattenAccessibilityTree,
  type ScreenContext,
  SimViewClient,
} from "@simview/client";
import {
  annotationMutationSchema,
  type ElementFallbackReason,
  type ElementTreeOutput,
  normalizedPointSchema,
  relayAuthenticationSchema,
  relayInputSchema,
  type SaveReviewImagesInput,
  type SaveReviewImagesOutput,
  type SessionState,
  uiContextSchema,
} from "@simview/contracts";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { previewScriptResponse, resolveAppRoot } from "./app-assets";
import { MetroInspector } from "./metro";

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
  #metroInspector = new MetroInspector();

  get connectionGeneration(): number {
    return this.#connectionGeneration;
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

  async open(deviceId?: string, options: { startRelay?: boolean } = {}): Promise<SessionState> {
    if (!this.client) {
      const devices = await SimViewClient.listDevices();
      const available = devices.filter((device) => device.available);
      this.device = deviceId
        ? available.find((device) => matchesDeviceId(device, deviceId))
        : (available.find((device) => device.kind !== "physical") ?? available[0]);
      if (!this.device) {
        throw new Error("No available device is connected");
      }
      try {
        this.client = await SimViewClient.acquire({ deviceId: this.device.id, codec: "h264" });
        this.#connectionGeneration += 1;
        this.#bindFrames();
        const capture = await this.client.request(
          "capture.start",
          selectedDeviceParams(this.device),
        );
        this.device = capture.device;
        if (options.startRelay !== false) this.startRelay();
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
      if (!matchesDeviceId(this.device, deviceId)) await this.selectDevice(deviceId);
      else await this.refreshDevice();
    }
    return this.state();
  }

  async availableDevices(): Promise<DeviceDescription[]> {
    return (await this.devices()).filter((device) => device.available);
  }

  devices(): Promise<DeviceDescription[]> {
    return SimViewClient.listDevices();
  }

  async simulatorDevices(): Promise<DeviceDescription[]> {
    const devices = await SimViewClient.listDevices();
    return devices.filter((device) => device.kind !== "physical");
  }

  async bootedDevices(): Promise<DeviceDescription[]> {
    return (await this.simulatorDevices()).filter((device) => device.available);
  }

  async refreshDevice(): Promise<SessionState> {
    if (this.client && this.device) {
      this.device = await this.client.request("device.describe", selectedDeviceParams(this.device));
    }
    return this.state();
  }

  async selectDevice(deviceId: string): Promise<SessionState> {
    const selected = (await this.availableDevices()).find((device) =>
      matchesDeviceId(device, deviceId),
    );
    if (!selected) throw new Error(`Device ${deviceId} is not available`);
    if (selected.id === this.device?.id) return this.state();

    const nextClient = await SimViewClient.acquire({ deviceId: selected.id, codec: "h264" });
    try {
      const capture = await nextClient.request("capture.start", selectedDeviceParams(selected));

      this.#connectionGeneration += 1;
      for (const unsubscribe of this.#unsubscribers) unsubscribe();
      this.#unsubscribers = [];
      if (this.mjpegClient) await this.mjpegClient.close();
      this.mjpegClient = undefined;
      this.#mjpegClientPromise = undefined;
      if (this.client) await this.client.close();
      this.client = nextClient;
      this.device = capture.device;
      this.frameId = undefined;
      this.lastAccessibility = undefined;
      this.lastElements = undefined;
      this.lastScreenContext = undefined;
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
      connected: Boolean(this.client),
    };
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

  async saveReviewImages(input: SaveReviewImagesInput): Promise<SaveReviewImagesOutput> {
    const directory = await mkdtemp(join(tmpdir(), `simview-review-${this.reviewId}-`));
    this.#reviewImageDirectories.add(directory);
    try {
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
    this.requireCapability("accessibility", "Accessibility inspection");
    const snapshot = await this.requireClient().request("accessibility.snapshot", {
      ...selectedDeviceParams(this.device),
      scope,
      maxNodes,
    });
    this.lastAccessibility = snapshot;
    return snapshot;
  }

  async elementSnapshot(
    scope: "interactive" | "visible" | "full" = "interactive",
    maxNodes = 1_200,
  ): Promise<ElementTreeOutput> {
    const accessibility = await this.accessibilitySnapshot(scope, maxNodes);
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
      return { snapshot: metro.snapshot, screenContext: metro.screenContext };
    }

    return this.#accessibilityElementOutput(
      accessibility,
      frameId,
      this.#metroInspector.fallbackReason ?? "metro-target-unavailable",
    );
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
  ): Promise<ElementTreeOutput> {
    const screenContext = await this.#uiKitScreenContext(accessibility, frameId);
    this.lastElements = accessibility;
    this.lastScreenContext = screenContext;
    return {
      snapshot: accessibility,
      screenContext,
      ...(fallbackReason ? { fallback: { reason: fallbackReason } } : {}),
    };
  }

  async findElements(selector: AccessibilitySelector) {
    const snapshot = this.lastElements ?? (await this.elementSnapshot("visible")).snapshot;
    const exact = selector.exact ?? true;
    const match = (actual: string | undefined, expected: string | undefined) =>
      expected === undefined ||
      (actual !== undefined &&
        (exact
          ? actual.localeCompare(expected, undefined, { sensitivity: "accent" }) === 0
          : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())));
    const matches = flattenAccessibilityTree(snapshot.root).filter(
      (node) =>
        match(node.ref, selector.ref) &&
        match(node.identifier, selector.identifier) &&
        match(node.role, selector.role) &&
        match(node.label ?? node.title, selector.name) &&
        match(node.value, selector.value),
    );
    return { snapshotId: snapshot.snapshotId, selector, matches, count: matches.length };
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
    const packetLimit = Math.min(30, Math.max(1, maxPackets));
    const waitLimit = Math.min(5_000, Math.max(50, timeoutMs));
    const oldestSequence = this.#previewPackets[0]?.sequence;
    const reset =
      afterSequence === undefined ||
      afterSequence > this.#previewSequence ||
      this.#previewSequence - afterSequence > PREVIEW_MAX_LAG_PACKETS ||
      (oldestSequence !== undefined && afterSequence < oldestSequence - 1);

    if (reset) {
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

      const keyframeIndex = this.#previewPackets.findIndex(
        (packet) => packet.keyframe && packet.sequence > requestedAfter,
      );
      const packets =
        keyframeIndex < 0
          ? []
          : this.#previewPackets.slice(keyframeIndex, keyframeIndex + packetLimit);
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
    if (this.relay) return;
    const session = this;
    this.relay = Bun.serve<ViewerData>({
      hostname: "127.0.0.1",
      port,
      async fetch(request, server) {
        const url = new URL(request.url);
        const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
        if (url.pathname === "/") {
          return new Response(await browserHtml(), {
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
          return previewScriptResponse();
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
                z
                  .object({
                    screenshot: z.string().min(1).max(20_000_000),
                    annotations: z
                      .array(
                        z.object({
                          id: z.string().uuid(),
                          screenshot: z.string().min(1).max(20_000_000),
                        }),
                      )
                      .max(100),
                  })
                  .parse(await request.json()),
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
          if (socket.data.codec === "h264") {
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
    if (!this.client) throw new Error("Open SimView before using device controls");
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
    if (this.mjpegClient) await this.mjpegClient.close();
    this.mjpegClient = undefined;
    this.#mjpegClientPromise = undefined;
    if (this.client) await this.client.close();
    this.client = undefined;
    this.device = undefined;
    this.frameId = undefined;
    this.lastAccessibility = undefined;
    this.lastElements = undefined;
    this.lastScreenContext = undefined;
    this.#metroInspector.close();
    this.#annotationsByDevice.clear();
    this.#resetPreviewPackets();
    await Promise.all(
      [...this.#reviewImageDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => {}),
      ),
    );
    this.#reviewImageDirectories.clear();
  }

  async #uiKitScreenContext(
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
      kind: "uikit" as const,
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
                if (this.#h264Configuration) {
                  this.#sendFrame(viewer, FrameKind.H264Configuration, this.#h264Configuration);
                }
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
}

function matchesDeviceId(device: DeviceDescription | undefined, requested: string): boolean {
  return Boolean(
    device && (device.id === requested || device.udid === requested || device.serial === requested),
  );
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

async function browserHtml(): Promise<string> {
  const appRoot = resolveAppRoot();
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
