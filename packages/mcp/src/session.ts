import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
  FrameKind,
  SimViewClient,
  flattenAccessibilityTree,
  type Annotation,
  type AccessibilityNode,
  type AccessibilitySelector,
  type AccessibilitySnapshot,
  type DeviceDescription,
} from "@simview/client";
import { previewScriptResponse, resolveAppRoot } from "./app-assets";

export interface SessionState {
  device?: DeviceDescription;
  frameId?: string;
  route?: string;
  component?: { testID?: string; label?: string; source?: string };
  annotations: Annotation[];
  relayOrigin?: string;
  browserUrl?: string;
  codec: "h264" | "mjpeg";
  connected: boolean;
}

type StreamCodec = "h264" | "mjpeg";
type ViewerData = { codec: StreamCodec };

export class SimViewSession {
  readonly relayToken = randomBytes(32).toString("hex");
  readonly annotations = new Map<string, Annotation>();
  readonly viewers = new Set<ServerWebSocket<ViewerData>>();
  client?: SimViewClient;
  mjpegClient?: SimViewClient;
  device?: DeviceDescription;
  frameId?: string;
  lastAccessibility?: AccessibilitySnapshot;
  relay?: ReturnType<typeof Bun.serve>;
  codec: "h264" | "mjpeg" = "h264";
  #h264Configuration?: Uint8Array;
  #mjpegClientPromise?: Promise<SimViewClient>;
  #unsubscribers: Array<() => void> = [];

  async open(udid?: string): Promise<SessionState> {
    if (!this.client) {
      this.client = await SimViewClient.start({ udid, codec: "h264" });
      const devices = await this.client.request<DeviceDescription[]>("devices.list");
      const booted = devices.filter(device => device.state === "Booted");
      this.device = udid
        ? booted.find(device => device.udid === udid)
        : booted.length === 1 ? booted[0] : undefined;
      if (!this.device) {
        await this.close();
        throw new Error(
          booted.length === 0
            ? "No booted simulator is available"
            : "More than one simulator is booted; pass a UDID",
        );
      }
      this.#bindFrames();
      await this.client.request("capture.start", { udid: this.device.udid });
      this.startRelay();
    } else if (udid && udid !== this.device?.udid) {
      await this.selectDevice(udid);
    }
    return this.state();
  }

  async bootedDevices(): Promise<DeviceDescription[]> {
    const devices = await this.requireClient().request<DeviceDescription[]>("devices.list");
    return devices.filter(device => device.state === "Booted");
  }

  async selectDevice(udid: string): Promise<SessionState> {
    const selected = (await this.bootedDevices()).find(device => device.udid === udid);
    if (!selected) throw new Error(`Simulator ${udid} is not booted`);
    if (selected.udid === this.device?.udid) return this.state();

    const nextClient = await SimViewClient.start({ udid: selected.udid, codec: "h264" });
    const nextDevices = await nextClient.request<DeviceDescription[]>("devices.list");
    const nextDevice = nextDevices.find(device =>
      device.state === "Booted" && device.udid === selected.udid);
    if (!nextDevice) {
      await nextClient.close();
      throw new Error(`Simulator ${udid} stopped before capture could begin`);
    }

    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    if (this.mjpegClient) await this.mjpegClient.close();
    this.mjpegClient = undefined;
    this.#mjpegClientPromise = undefined;
    if (this.client) await this.client.close();
    this.client = nextClient;
    this.device = nextDevice;
    this.frameId = undefined;
    this.lastAccessibility = undefined;
    this.#h264Configuration = undefined;
    this.annotations.clear();
    this.#bindFrames();
    await this.requireClient().request("capture.start", { udid: nextDevice.udid });
    if ([...this.viewers].some(viewer => viewer.data.codec === "mjpeg")) {
      void this.#ensureMjpegClient().catch(() => {});
    }
    return this.state();
  }

  state(): SessionState {
    const origin = this.relay ? `http://${this.relay.hostname}:${this.relay.port}` : undefined;
    return {
      device: this.device,
      frameId: this.frameId,
      annotations: [...this.annotations.values()],
      relayOrigin: origin,
      browserUrl: origin ? `${origin}/#token=${this.relayToken}` : undefined,
      codec: this.codec,
      connected: Boolean(this.client),
    };
  }

  async screenshot(): Promise<{ bytes: Uint8Array; frameId: string; width: number; height: number }> {
    const client = this.requireClient();
    const bytesPromise = new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for PNG screenshot payload"));
      }, 5_000);
      const unsubscribe = client.on(FrameKind.PngScreenshot, bytes => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(bytes);
      });
    });
    const metadata = await client.request<{
      frameId: string;
      width: number;
      height: number;
    }>("capture.screenshot");
    const bytes = await bytesPromise;
    this.frameId = metadata.frameId;
    return { bytes, ...metadata };
  }

  async accessibilitySnapshot(
    scope: "interactive" | "visible" | "full" = "interactive",
    maxNodes = 1_200,
  ) {
    const snapshot = await this.requireClient().request<AccessibilitySnapshot>("accessibility.snapshot", {
      udid: this.device?.udid,
      scope,
      maxNodes,
    });
    this.lastAccessibility = snapshot;
    return snapshot;
  }

  async findElements(selector: AccessibilitySelector) {
    const snapshot = this.lastAccessibility ?? await this.accessibilitySnapshot("visible");
    const exact = selector.exact ?? true;
    const match = (actual: string | undefined, expected: string | undefined) =>
      expected === undefined || (actual !== undefined && (exact
        ? actual.localeCompare(expected, undefined, { sensitivity: "accent" }) === 0
        : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())));
    const matches = flattenAccessibilityTree(snapshot.root).filter(node =>
      match(node.ref, selector.ref)
      && match(node.identifier, selector.identifier)
      && match(node.role, selector.role)
      && match(node.label ?? node.title, selector.name)
      && match(node.value, selector.value));
    return { snapshotId: snapshot.snapshotId, selector, matches, count: matches.length };
  }

  inspectPoint(x: number, y: number) {
    return this.requireClient().request<AccessibilitySnapshot>("accessibility.elementAtPoint", {
      udid: this.device?.udid,
      x,
      y,
    });
  }

  probeStatus() {
    return this.requireClient().request<{
      bundled: boolean;
      connected: boolean;
      bundleId?: string;
      pid?: number;
    }>("probe.status");
  }

  probeTarget() {
    return this.requireClient().request<{
      bundleId?: string;
      source: "probe" | "simctl";
      error?: string;
    }>("probe.target", { udid: this.device?.udid });
  }

  enableProbe(bundleId: string) {
    return this.requireClient().request("probe.enable", {
      udid: this.device?.udid,
      bundleId,
    });
  }

  disableProbe() {
    return this.requireClient().request("probe.disable", { udid: this.device?.udid });
  }

  probeContext() {
    return this.requireClient().request("probe.context");
  }

  probeInspectPoint(x: number, y: number) {
    return this.requireClient().request<Record<string, unknown>>("probe.inspectPoint", { x, y });
  }

  addAnnotation(input: Omit<Annotation, "id" | "createdAt" | "frameId"> & { frameId?: string }): Annotation {
    const annotation: Annotation = {
      ...input,
      id: randomUUID(),
      frameId: input.frameId ?? this.frameId ?? "current",
      createdAt: new Date().toISOString(),
    };
    this.annotations.set(annotation.id, annotation);
    return annotation;
  }

  updateAnnotation(id: string, patch: Partial<Pick<Annotation, "note" | "geometry">>): Annotation {
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

  startRelay(): void {
    if (this.relay) return;
    const session = this;
    this.relay = Bun.serve<ViewerData>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        const url = new URL(request.url);
        const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
        const token = url.searchParams.get("token") ?? bearer;
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
        if (token !== session.relayToken) return new Response("Unauthorized", { status: 401 });
        if (url.pathname === "/state") {
          return Response.json(session.state(), { headers: { "cache-control": "no-store" } });
        }
        if (url.pathname === "/devices") {
          return Response.json({ devices: await session.bootedDevices() });
        }
        if (url.pathname === "/device" && request.method === "POST") {
          const { udid } = await request.json() as { udid?: string };
          if (!udid) return new Response("udid is required", { status: 400 });
          return Response.json(await session.selectDevice(udid));
        }
        if (url.pathname === "/stream") {
          const codec: StreamCodec = url.searchParams.get("codec") === "mjpeg"
            ? "mjpeg"
            : "h264";
          const upgraded = server.upgrade(request, { data: { codec } });
          return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
        }
        if (url.pathname === "/input" && request.method === "POST") {
          const { method, params } = await request.json() as { method: string; params: unknown };
          const result = await session.requireClient().request(method as never, params);
          return Response.json(result);
        }
        if (url.pathname === "/annotation" && request.method === "POST") {
          const body = await request.json() as {
            action: "add" | "update" | "delete";
            id?: string;
            frameId?: string;
            geometry?: Annotation["geometry"];
            note?: string;
            context?: Annotation["context"];
          };
          if (body.action === "delete" && body.id) {
            return Response.json({ deleted: session.deleteAnnotation(body.id), id: body.id });
          }
          if (body.action === "update" && body.id) {
            return Response.json(session.updateAnnotation(body.id, {
              geometry: body.geometry,
              note: body.note,
            }));
          }
          if (!body.geometry || !body.note) return new Response("geometry and note are required", { status: 400 });
          return Response.json(session.addAnnotation({
            frameId: body.frameId,
            geometry: body.geometry,
            note: body.note,
            context: body.context,
          }));
        }
        if (url.pathname === "/accessibility") {
          const scope = url.searchParams.get("scope");
          const requestedMaxNodes = Number(url.searchParams.get("maxNodes"));
          return Response.json(await session.accessibilitySnapshot(
            scope === "visible" || scope === "full" ? scope : "interactive",
            Number.isFinite(requestedMaxNodes)
              ? Math.min(1_200, Math.max(1, requestedMaxNodes))
              : 1_200,
          ));
        }
        if (url.pathname === "/inspect-point") {
          const x = Number(url.searchParams.get("x"));
          const y = Number(url.searchParams.get("y"));
          const accessibility = await session.inspectPoint(x, y);
          const status = await session.probeStatus();
          const native = status.connected ? await session.probeInspectPoint(x, y) : undefined;
          return Response.json({ ...accessibility, native });
        }
        if (url.pathname === "/probe/status") {
          return Response.json(await session.probeStatus());
        }
        if (url.pathname === "/probe/target") {
          return Response.json(await session.probeTarget());
        }
        if (url.pathname === "/probe/enable" && request.method === "POST") {
          const { bundleId } = await request.json() as { bundleId?: string };
          const normalizedBundleId = bundleId?.trim();
          if (!normalizedBundleId || normalizedBundleId.length < 3) {
            return new Response("A valid bundle identifier is required", { status: 400 });
          }
          if (normalizedBundleId.startsWith("com.apple.")) {
            return new Response("Apple platform apps cannot load the UIKit probe", { status: 400 });
          }
          return Response.json(await session.enableProbe(normalizedBundleId));
        }
        if (url.pathname === "/probe/context") {
          return Response.json(await session.probeContext());
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          session.viewers.add(socket);
          if (socket.data.codec === "h264") {
            if (session.#h264Configuration) {
              session.#sendFrame(socket, FrameKind.H264Configuration, session.#h264Configuration);
            }
            void session.requireClient().request("capture.keyframe").catch(() => {});
          } else {
            void session.#ensureMjpegClient().catch(() => {
              socket.close(1011, "Unable to start MJPEG fallback");
            });
          }
        },
        close(socket) {
          session.viewers.delete(socket);
        },
        message() {},
      },
    });
  }

  requireClient(): SimViewClient {
    if (!this.client) throw new Error("Open SimView before using simulator controls");
    return this.client;
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    this.relay?.stop(true);
    this.relay = undefined;
    if (this.mjpegClient) await this.mjpegClient.close();
    this.mjpegClient = undefined;
    this.#mjpegClientPromise = undefined;
    if (this.client) await this.client.close();
    this.client = undefined;
    this.device = undefined;
    this.#h264Configuration = undefined;
  }

  #bindFrames(): void {
    const client = this.requireClient();
    for (const kind of [FrameKind.H264Configuration, FrameKind.H264Frame]) {
      this.#unsubscribers.push(client.on(kind, payload => {
        if (kind === FrameKind.H264Configuration) {
          this.#h264Configuration = payload.slice();
        }
        if (kind === FrameKind.H264Frame && payload.byteLength >= 8) {
          this.frameId = new DataView(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength,
          ).getBigUint64(0, false).toString();
        }
        const message = new Uint8Array(payload.length + 1);
        message[0] = kind;
        message.set(payload, 1);
        for (const viewer of this.viewers) {
          if (viewer.data.codec === "h264" && viewer.readyState === WebSocket.OPEN) {
            viewer.send(message);
          }
        }
      }));
    }
  }

  #ensureMjpegClient(): Promise<SimViewClient> {
    if (this.mjpegClient) return Promise.resolve(this.mjpegClient);
    if (this.#mjpegClientPromise) return this.#mjpegClientPromise;
    const primary = this.requireClient();
    this.#mjpegClientPromise = SimViewClient.attach(
      primary.socketPath,
      primary.token,
      "mjpeg",
    ).then(client => {
      this.mjpegClient = client;
      this.#unsubscribers.push(client.on(FrameKind.JpegFrame, payload => {
        for (const viewer of this.viewers) {
          if (viewer.data.codec === "mjpeg" && viewer.readyState === WebSocket.OPEN) {
            this.#sendFrame(viewer, FrameKind.JpegFrame, payload);
          }
        }
      }));
      return client;
    }).finally(() => {
      this.#mjpegClientPromise = undefined;
    });
    return this.#mjpegClientPromise;
  }

  #sendFrame(
    viewer: ServerWebSocket<ViewerData>,
    kind: FrameKind,
    payload: Uint8Array,
  ): void {
    const message = new Uint8Array(payload.length + 1);
    message[0] = kind;
    message.set(payload, 1);
    viewer.send(message);
  }
}

async function browserHtml(): Promise<string> {
  const appRoot = resolveAppRoot();
  const built = Bun.file(join(appRoot, "dist", "preview.html"));
  if (await built.exists()) return built.text();
  return Bun.file(join(appRoot, "src", "preview.html")).text();
}
