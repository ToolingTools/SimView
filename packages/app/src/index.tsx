import { App } from "@modelcontextprotocol/ext-apps";
import {
  type AnnotationContext,
  type AnnotationGeometry,
  type AccessibilityNode as ContractAccessibilityNode,
  type Annotation as ContractAnnotation,
  type ElementSnapshot as ContractElementSnapshot,
  type DeviceDescription,
  type ElementFallbackReason,
  type ElementTreePage,
  elementTreeOutputSchema,
  elementTreePageSchema,
  inspectPointOutputSchema,
  previewPacketBatchSchema,
  type ScreenContext,
  type SessionState,
  SIMVIEW_VERSION,
  saveReviewImagesOutputSchema,
  sessionStateSchema,
  simulatorListSchema,
  type UiContext,
  uiContextSchema,
} from "@simview/contracts";
import { type ComponentChildren, render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  annotationCropRect,
  annotationMessageContent,
  annotationMessageContext,
  annotationMessageScreenContext,
  assembleElementTreePages,
  claimFullscreenRequest,
  commentableNodeAtPoint,
  compactIdentifier,
  contextForInspectedNode,
  contextForNode,
  createUIKitScreenContext,
  elementName,
  flattenTree,
  formatFrame,
  formatProbeValue,
  formatRuntime,
  inspectorTreeRows,
  PreviewBridgeGate,
  parseSessionState,
  percent,
  requireAnnotation,
  streamMessage,
  visibleTree,
} from "./helpers";

type Point = AnnotationGeometry;
type AccessibilityNode = ContractAccessibilityNode;
type AccessibilitySnapshot = ContractElementSnapshot & {
  native?: {
    viewClass?: string;
    controllerClass?: string;
    controllerPath?: string[];
    windowClass?: string;
    sceneIdentifier?: string;
  };
};
type Annotation = ContractAnnotation;
type Device = DeviceDescription;
type State = SessionState & {
  relayOrigin?: string | undefined;
};
type Editor = {
  point: Point;
  note: string;
  frameId: string;
  annotationId?: string | undefined;
  context?: AnnotationContext | undefined;
};
type PointerInput = {
  contactId: number;
  phase: "down" | "move" | "up";
  x: number;
  y: number;
};
type StartupPhase = "connecting" | "waiting-for-frame" | "ready" | "error";

declare global {
  interface Window {
    __SIMVIEW_INITIAL_STATE__?: unknown;
  }
}

const bridge = new App(
  { name: "SimView", version: SIMVIEW_VERSION },
  { availableDisplayModes: ["inline", "fullscreen", "pip"] },
  { autoResize: true },
);
const HOVER_SLOP_PX = 10;
const elementFallbackLabels: Record<ElementFallbackReason, string> = {
  "metro-target-unavailable": "No matching React Native Metro target",
  "metro-fiber-unavailable": "React Native Fiber root unavailable",
  "metro-inspection-failed": "React Native inspection failed",
};
const initialState = parseSessionState(window.__SIMVIEW_INITIAL_STATE__);

function SimView() {
  const [state, setState] = useState<State>(
    initialState ?? {
      reviewId: "",
      annotations: [],
      codec: "h264",
      connected: false,
    },
  );
  const [streamCodec, setStreamCodec] = useState<"h264" | "mjpeg">(
    "VideoDecoder" in window ? "h264" : "mjpeg",
  );
  const [mode, setMode] = useState<"interact" | "annotate">("interact");
  const [frozenFrameId, setFrozenFrameId] = useState<string>();
  const [editor, setEditor] = useState<Editor>();
  const [toast, setToast] = useState("");
  const [accessibility, setAccessibility] = useState<AccessibilitySnapshot>();
  const [screenContext, setScreenContext] = useState<ScreenContext>();
  const [elementFallback, setElementFallback] = useState<ElementFallbackReason>();
  const [frozenScreenContext, setFrozenScreenContext] = useState<ScreenContext>();
  const [uiContext, setUiContext] = useState<UiContext>();
  const [probeBundleId, setProbeBundleId] = useState("");
  const [probeEnabling, setProbeEnabling] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [elementsOpen, setElementsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [infoHeight, setInfoHeight] = useState(190);
  const [sceneOpen, setSceneOpen] = useState(true);
  const [elementSearch, setElementSearch] = useState("");
  const [selectedElement, setSelectedElement] = useState<AccessibilityNode>();
  const [hoveredElement, setHoveredElement] = useState<AccessibilityNode>();
  const [hoveredContext, setHoveredContext] = useState<AnnotationContext>();
  const [expandedElements, setExpandedElements] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(292);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [bootedDevices, setBootedDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [switchingDevice, setSwitchingDevice] = useState<string>();
  const [embedded, setEmbedded] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [discardingAnnotations, setDiscardingAnnotations] = useState(false);
  const [typeTextOpen, setTypeTextOpen] = useState(false);
  const [typeText, setTypeText] = useState("");
  const [typingText, setTypingText] = useState(false);
  const [savingComment, setSavingComment] = useState(false);
  const [startupPhase, setStartupPhase] = useState<StartupPhase>(
    initialState?.connected ? "waiting-for-frame" : "connecting",
  );
  const [startupError, setStartupError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const editorInputRef = useRef<HTMLTextAreaElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const deviceMenuRef = useRef<HTMLDivElement>(null);
  const decoderRef = useRef<VideoDecoder>();
  const pendingVideoFrameRef = useRef<VideoFrame>();
  const videoPaintRequestRef = useRef<number>();
  const latestFrameIdRef = useRef<string>();
  const previewReadyRef = useRef(false);
  const recordingRef = useRef<MediaRecorder>();
  const activePointer = useRef<number>();
  const pointerInputQueueRef = useRef<PointerInput[]>([]);
  const pointerInputRunningRef = useRef(false);
  const hoverRequest = useRef(0);
  const hoverRequestedAt = useRef(0);
  const hoverPending = useRef(false);
  const accessibilityRequestPending = useRef(false);
  const elementTreeAbortRef = useRef<AbortController>();
  const accessibilityInitialized = useRef(false);
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number }>();
  const infoResize = useRef<{ pointerId: number; startY: number; startHeight: number }>();
  const frozenRef = useRef(false);
  const mjpegFrameRef = useRef(0);
  const sentAnnotationIds = useRef<Set<string>>(new Set());
  const pendingAnnotationsRef = useRef<Annotation[]>([]);
  const bridgeConnectedRef = useRef(false);
  const connectedForFullscreenRef = useRef(Boolean(initialState?.connected));
  const fullscreenRequestGateRef = useRef({ claimed: false });
  const previewBridgeGateRef = useRef(new PreviewBridgeGate());

  const token = useMemo(() => {
    const match = location.href.match(/[#&]token=([^&]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }, []);

  useEffect(() => {
    if (window.parent === window) {
      void loadBrowserState();
      return;
    }
    setEmbedded(true);
    bridge.ontoolresult = (result) => {
      const nextState = parseSessionState(result.structuredContent);
      if (nextState) {
        connectedForFullscreenRef.current = nextState.connected;
        if (nextState.connected) {
          setStartupError("");
          setStartupPhase((current) => (current === "ready" ? current : "waiting-for-frame"));
          if (bridgeConnectedRef.current) void enterFullscreen();
        }
        setState((current) =>
          current.reviewId && current.reviewId !== nextState.reviewId ? current : nextState,
        );
      }
    };
    bridge
      .connect()
      .then(() => {
        bridgeConnectedRef.current = true;
        if (connectedForFullscreenRef.current) void enterFullscreen();
      })
      .catch((error) => {
        bridgeConnectedRef.current = false;
        const message = error instanceof Error ? error.message : String(error);
        setStartupError(message);
        setStartupPhase("error");
      });
  }, []);

  async function enterFullscreen() {
    const context = bridge.getHostContext();
    if (!claimFullscreenRequest(fullscreenRequestGateRef.current, context)) return;
    try {
      const result = await bridge.requestDisplayMode({ mode: "fullscreen" });
      if (result.mode !== "fullscreen") show(`Host kept SimView in ${result.mode} mode`);
    } catch (error) {
      show(`Unable to enter fullscreen: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  useEffect(() => {
    if (!editor) return;
    requestAnimationFrame(() => editorInputRef.current?.focus());
  }, [editor?.point.x, editor?.point.y]);

  useEffect(() => {
    if (!toolsOpen && !deviceMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !toolsMenuRef.current?.contains(target) &&
        !deviceMenuRef.current?.contains(target)
      ) {
        setToolsOpen(false);
        setDeviceMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolsOpen(false);
        setDeviceMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [toolsOpen, deviceMenuOpen]);

  useEffect(() => {
    if (uiContext?.target?.bundleId && !probeBundleId) {
      setProbeBundleId(uiContext.target.bundleId);
    }
  }, [uiContext?.target?.bundleId]);

  useEffect(() => {
    if (!state.connected || (!embedded && !token)) return;
    void loadUiContext();
  }, [state.connected, embedded, token]);

  useEffect(
    () => () => {
      elementTreeAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (embedded || !state.relayOrigin || !token) return;
    const url = `${state.relayOrigin.replace(/^http/, "ws")}/stream?codec=${streamCodec}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => socket.send(JSON.stringify({ type: "authenticate", token }));
    socket.onmessage = (event) => consumeFrame(new Uint8Array(event.data as ArrayBuffer));
    socket.onerror = () => show("Preview stream disconnected");
    return () => {
      socket.close();
      decoderRef.current?.close();
      decoderRef.current = undefined;
      pendingVideoFrameRef.current?.close();
      pendingVideoFrameRef.current = undefined;
      if (videoPaintRequestRef.current !== undefined) {
        window.cancelAnimationFrame(videoPaintRequestRef.current);
        videoPaintRequestRef.current = undefined;
      }
    };
  }, [embedded, state.relayOrigin, token, streamCodec]);

  useEffect(() => {
    if (!embedded || !state.connected || mode !== "interact") return;
    let stopped = false;
    let afterSequence: number | undefined;
    let reportedError = false;
    const controller = new AbortController();
    const pump = async () => {
      while (!stopped) {
        while (!stopped && previewBridgeGateRef.current.priorityPending) {
          await pause(16);
        }
        if (stopped) return;
        try {
          const result = await bridge.callServerTool(
            {
              name: "get_preview_packets",
              arguments: {
                ...(afterSequence === undefined ? {} : { afterSequence }),
                maxPackets: 12,
                timeoutMs: 100,
              },
            },
            { signal: controller.signal },
          );
          if (stopped) return;
          const batch = previewPacketBatchSchema.parse(result.structuredContent);
          if (batch.reset && batch.configuration) {
            consumeFrame(streamMessage(0x10, decodeBase64(batch.configuration)));
          }
          for (const packet of batch.packets) {
            consumeFrame(streamMessage(packet.kind, decodeBase64(packet.data)));
          }
          afterSequence =
            batch.reset && batch.packets.length === 0 ? undefined : batch.nextSequence;
          reportedError = false;
        } catch (error) {
          if (stopped) return;
          if (!reportedError) {
            show(`Preview bridge interrupted: ${errorMessage(error)}`);
            reportedError = true;
          }
          await pause(250);
        }
      }
    };
    void pump();
    return () => {
      stopped = true;
      controller.abort();
      decoderRef.current?.close();
      decoderRef.current = undefined;
      pendingVideoFrameRef.current?.close();
      pendingVideoFrameRef.current = undefined;
      if (videoPaintRequestRef.current !== undefined) {
        window.cancelAnimationFrame(videoPaintRequestRef.current);
        videoPaintRequestRef.current = undefined;
      }
    };
  }, [embedded, state.connected, state.device?.udid, mode]);

  async function loadBrowserState() {
    const hashToken = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
    if (!hashToken) {
      setStartupError("The local preview link is incomplete.");
      setStartupPhase("error");
      return;
    }
    try {
      const response = await fetch("/state", {
        headers: { authorization: `Bearer ${hashToken}` },
      });
      if (!response.ok) throw new Error(`The local relay returned ${response.status}`);
      setState({
        ...sessionStateSchema.parse(await response.json()),
        relayOrigin: location.origin,
      });
      setStartupPhase("waiting-for-frame");
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : String(error));
      setStartupPhase("error");
    }
  }

  async function relayFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!token) throw new Error("The local relay token is unavailable");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers });
  }

  async function loadPagedElementTree(source: "elements" | "accessibility", signal: AbortSignal) {
    const pages: ElementTreePage[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      throwIfAborted(signal);
      const result = await bridge.callServerTool(
        {
          name: "app_get_element_tree_page",
          arguments: cursor
            ? { action: "continue", cursor }
            : { action: "start", source, scope: "full", maxNodes: 1_200 },
        },
        { signal },
      );
      if (result.isError) throw new Error(toolResultError(result.content));
      const page = elementTreePageSchema.parse(result.structuredContent);
      pages.push(page);
      if (pages.length > page.pageCount) {
        throw new Error(`Element tree exceeded its declared ${page.pageCount}-page limit`);
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new Error("Element tree response repeated a page cursor");
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return await assembleElementTreePages(pages);
  }

  async function loadBootedDevices() {
    setDevicesLoading(true);
    try {
      const devices = embedded
        ? await bridge
            .callServerTool({
              name: "app_list_simulators",
              arguments: {},
            })
            .then((result) => {
              return simulatorListSchema.parse(result.structuredContent).devices;
            })
        : await relayFetch("/devices")
            .then(async (response) => {
              if (!response.ok) throw new Error(`Simulator list failed (${response.status})`);
              return simulatorListSchema.parse(await response.json());
            })
            .then((result) => result.devices);
      const booted = devices.filter((device) => device.state === "Booted");
      setBootedDevices((current) => {
        if (!current.length) return booted;
        const byUdid = new Map(booted.map((device) => [device.udid, device]));
        const retained = current
          .map((device) => byUdid.get(device.udid))
          .filter((device): device is Device => Boolean(device));
        const retainedIds = new Set(retained.map((device) => device.udid));
        return [...retained, ...booted.filter((device) => !retainedIds.has(device.udid))];
      });
    } catch (error) {
      show(`Unable to list simulators: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDevicesLoading(false);
    }
  }

  async function toggleDeviceMenu() {
    if (deviceMenuOpen) {
      setDeviceMenuOpen(false);
      return;
    }
    setToolsOpen(false);
    setDeviceMenuOpen(true);
    await loadBootedDevices();
  }

  async function selectSimulator(device: Device) {
    if (device.udid === state.device?.udid) {
      setDeviceMenuOpen(false);
      return;
    }
    setStartupError("");
    setStartupPhase("connecting");
    setSwitchingDevice(device.udid);
    elementTreeAbortRef.current?.abort();
    elementTreeAbortRef.current = undefined;
    accessibilityRequestPending.current = false;
    try {
      const nextState = embedded
        ? await bridge
            .callServerTool({
              name: "app_connect_simulator",
              arguments: { udid: device.udid },
            })
            .then((result) => sessionStateSchema.parse(result.structuredContent))
        : await relayFetch("/device", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ udid: device.udid }),
          }).then(async (response) => {
            if (!response.ok)
              throw new Error(
                (await response.text()) || `Simulator switch failed (${response.status})`,
              );
            return sessionStateSchema.parse(await response.json());
          });
      frozenRef.current = false;
      latestFrameIdRef.current = nextState.frameId;
      previewReadyRef.current = false;
      setFrozenFrameId(undefined);
      setMode("interact");
      setEditor(undefined);
      setSelectedElement(undefined);
      setHoveredElement(undefined);
      setHoveredContext(undefined);
      setAccessibility(undefined);
      setScreenContext(undefined);
      setElementFallback(undefined);
      setFrozenScreenContext(undefined);
      accessibilityInitialized.current = false;
      setUiContext(undefined);
      sentAnnotationIds.current.clear();
      setState(nextState);
      setStartupPhase("waiting-for-frame");
      setDeviceMenuOpen(false);
      if (elementsOpen) void loadAccessibility(true);
      show(`Switched to ${nextState.device?.name ?? device.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartupError(message);
      setStartupPhase("error");
      show(`Unable to switch simulator: ${message}`);
    } finally {
      setSwitchingDevice(undefined);
    }
  }

  function consumeFrame(message: Uint8Array) {
    const kind = message[0];
    const payload = message.subarray(1);
    if (kind === 0x10 && "VideoDecoder" in window) {
      if (payload.byteLength < 4) {
        fallbackToMjpeg("The H.264 configuration was incomplete");
        return;
      }
      const codec = `avc1.${[payload[1], payload[2], payload[3]]
        .map((value) => (value ?? 0).toString(16).padStart(2, "0"))
        .join("")}`;
      decoderRef.current?.close();
      decoderRef.current = new VideoDecoder({
        output(frame) {
          const pending = pendingVideoFrameRef.current;
          pendingVideoFrameRef.current = frame;
          pending?.close();
          if (videoPaintRequestRef.current === undefined) {
            videoPaintRequestRef.current = window.requestAnimationFrame(paintLatestVideoFrame);
          }
        },
        error: (error) => fallbackToMjpeg(`H.264 decoder failed: ${error.message}`),
      });
      try {
        decoderRef.current.configure({ codec, description: payload, optimizeForLatency: true });
      } catch (error) {
        fallbackToMjpeg(`H.264 is unavailable: ${String(error)}`);
      }
    } else if (kind === 0x11 && decoderRef.current?.state === "configured") {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const timestamp = Number(view.getBigUint64(0, false));
      try {
        decoderRef.current.decode(
          new EncodedVideoChunk({
            type: payload[8] === 1 ? "key" : "delta",
            timestamp,
            data: payload.subarray(9),
          }),
        );
      } catch (error) {
        fallbackToMjpeg(`H.264 frame decode failed: ${String(error)}`);
      }
    } else if (kind === 0x12) {
      const blob = new Blob([payload.slice().buffer as ArrayBuffer], { type: "image/jpeg" });
      createImageBitmap(blob).then((image) => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { alpha: false, desynchronized: true });
        if (!frozenRef.current && canvas && context) {
          if (canvas.width !== image.width) canvas.width = image.width;
          if (canvas.height !== image.height) canvas.height = image.height;
          context.drawImage(image, 0, 0);
          mjpegFrameRef.current += 1;
          commitFrameId(`mjpeg-${mjpegFrameRef.current}`);
        }
        image.close();
      });
    }
  }

  function paintLatestVideoFrame() {
    videoPaintRequestRef.current = undefined;
    const frame = pendingVideoFrameRef.current;
    pendingVideoFrameRef.current = undefined;
    if (!frame) return;
    try {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { alpha: false, desynchronized: true });
      if (!frozenRef.current && canvas && context) {
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        commitFrameId(String(frame.timestamp));
      }
    } finally {
      frame.close();
    }
    if (pendingVideoFrameRef.current && videoPaintRequestRef.current === undefined) {
      videoPaintRequestRef.current = window.requestAnimationFrame(paintLatestVideoFrame);
    }
  }

  function commitFrameId(frameId: string) {
    latestFrameIdRef.current = frameId;
    if (previewReadyRef.current) return;
    previewReadyRef.current = true;
    setStartupError("");
    setStartupPhase("ready");
  }

  function fallbackToMjpeg(reason: string) {
    if (streamCodec !== "h264") return;
    console.warn(reason);
    if (embedded) {
      show("The embedded H.264 preview stopped; reopen SimView to retry");
      return;
    }
    show("H.264 unavailable; using MJPEG fallback");
    setStreamCodec("mjpeg");
  }

  async function relayInput(method: string, params: unknown) {
    if (embedded) {
      await bridge.callServerTool({
        name: "simulator_input",
        arguments: {
          method,
          params: params as Record<string, unknown>,
        },
      });
      return;
    }
    if (!state.relayOrigin || !token) return;
    const response = await relayFetch(`${state.relayOrigin}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    if (!response.ok) throw new Error(`Simulator input failed (${response.status})`);
  }

  async function submitTypedText(event: SubmitEvent) {
    event.preventDefault();
    if (!typeText || typingText) return;
    setTypingText(true);
    try {
      await relayInput("input.typeText", { text: typeText });
      setTypeTextOpen(false);
      setTypeText("");
      show("Text input accepted");
    } catch (error) {
      show(`Unable to type text: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTypingText(false);
    }
  }

  function coordinate(event: PointerEvent): Point {
    const screen = screenRef.current;
    if (!screen) throw new Error("Simulator stage is unavailable");
    const rect = screen.getBoundingClientRect();
    return {
      kind: "point",
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function hoverSlop(): { x: number; y: number } {
    const rect = screenRef.current?.getBoundingClientRect();
    return {
      x: HOVER_SLOP_PX / Math.max(rect?.width ?? 1, 1),
      y: HOVER_SLOP_PX / Math.max(rect?.height ?? 1, 1),
    };
  }

  function elementContext(node: AccessibilityNode): AnnotationContext | undefined {
    if (!accessibility) return undefined;
    const context = contextForNode(accessibility, node);
    const activeContext = frozenScreenContext ?? screenContext;
    if (accessibility.source !== "react-native-fiber" || activeContext?.kind !== "react-native") {
      return context;
    }
    return {
      ...context,
      metro: {
        ...context.metro,
        route: activeContext.route,
      },
    };
  }

  function enqueuePointerInput(input: PointerInput) {
    const queue = pointerInputQueueRef.current;
    const last = queue.at(-1);
    if (input.phase === "move" && last?.phase === "move" && last.contactId === input.contactId) {
      queue[queue.length - 1] = input;
    } else {
      queue.push(input);
    }
    if (!pointerInputRunningRef.current) void drainPointerInput();
  }

  async function drainPointerInput() {
    if (pointerInputRunningRef.current) return;
    pointerInputRunningRef.current = true;
    try {
      let input = pointerInputQueueRef.current.shift();
      while (input) {
        await relayInput("input.touch", input);
        input = pointerInputQueueRef.current.shift();
      }
    } catch (error) {
      pointerInputQueueRef.current = [];
      show(`Simulator input failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pointerInputRunningRef.current = false;
      if (pointerInputQueueRef.current.length) void drainPointerInput();
    }
  }

  function onPointerDown(event: PointerEvent) {
    const point = coordinate(event);
    if (mode === "annotate") {
      const node = accessibility
        ? commentableNodeAtPoint(accessibility.root, point, hoverSlop())
        : undefined;
      const context = node ? elementContext(node) : hoveredContext;
      setSelectedElement(node);
      setEditor({
        point,
        note: "",
        frameId: frozenFrameId ?? latestFrameIdRef.current ?? state.frameId ?? "current",
        context,
      });
      void inspectAnnotationPoint(point);
      return;
    }
    activePointer.current = event.pointerId;
    screenRef.current?.setPointerCapture(event.pointerId);
    enqueuePointerInput({
      contactId: event.pointerId,
      phase: "down",
      x: point.x,
      y: point.y,
    });
  }

  function onPointerMove(event: PointerEvent) {
    const point = coordinate(event);
    if (mode === "annotate") {
      if (!editor && accessibility) {
        const slop = hoverSlop();
        const node = commentableNodeAtPoint(accessibility.root, point, slop);
        if (node?.ref !== hoveredElement?.ref) {
          setHoveredElement(node);
          setHoveredContext(node ? elementContext(node) : undefined);
        }
        if (node) return;
      }
      const frame = hoveredElement?.frame?.normalized;
      const slop = hoverSlop();
      const remainsInElement =
        frame &&
        !hoveredElement?.role?.toLowerCase().includes("application") &&
        point.x >= frame.x - slop.x &&
        point.x <= frame.x + frame.width + slop.x &&
        point.y >= frame.y - slop.y &&
        point.y <= frame.y + frame.height + slop.y;
      if (
        !editor &&
        !remainsInElement &&
        !hoverPending.current &&
        Date.now() - hoverRequestedAt.current >= 120
      ) {
        hoverRequestedAt.current = Date.now();
        void inspectHoverPoint(point);
      }
      return;
    }
    if (activePointer.current !== event.pointerId) return;
    enqueuePointerInput({
      contactId: event.pointerId,
      phase: "move",
      x: point.x,
      y: point.y,
    });
  }

  async function inspectHoverPoint(point: Point) {
    const request = ++hoverRequest.current;
    hoverPending.current = true;
    try {
      const snapshot = embedded
        ? await bridge
            .callServerTool({
              name: "app_inspect_point",
              arguments: { x: point.x, y: point.y },
            })
            .then((result) => inspectPointOutputSchema.parse(result.structuredContent))
        : await relayFetch(`/inspect-point?x=${point.x}&y=${point.y}`).then(async (response) => {
            if (!response.ok) throw new Error(`Point inspection failed (${response.status})`);
            return inspectPointOutputSchema.parse(await response.json());
          });
      if (request !== hoverRequest.current || editor) return;
      const frame = snapshot.element.frame?.normalized;
      if (!frame || frame.width <= 0 || frame.height <= 0 || snapshot.element.hidden) {
        setHoveredElement(undefined);
        setHoveredContext(undefined);
        return;
      }
      setHoveredElement(snapshot.element);
      setHoveredContext({
        ...contextForInspectedNode(accessibility, snapshot.element),
        native: snapshot.native ? { ...snapshot.native, matchConfidence: "strong" } : undefined,
      });
    } catch {
      if (request === hoverRequest.current) {
        setHoveredElement(undefined);
        setHoveredContext(undefined);
      }
    } finally {
      hoverPending.current = false;
    }
  }

  function resizeSidebar(event: PointerEvent) {
    const resize = sidebarResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setSidebarWidth(
      Math.min(430, Math.max(240, resize.startWidth + resize.startX - event.clientX)),
    );
  }

  function stopSidebarResize(event: PointerEvent) {
    if (sidebarResize.current?.pointerId !== event.pointerId) return;
    sidebarResize.current = undefined;
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture(event.pointerId);
  }

  function resizeInfo(event: PointerEvent) {
    const resize = infoResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setInfoHeight(Math.min(420, Math.max(110, resize.startHeight + resize.startY - event.clientY)));
  }

  function stopInfoResize(event: PointerEvent) {
    if (infoResize.current?.pointerId !== event.pointerId) return;
    infoResize.current = undefined;
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture(event.pointerId);
  }

  function onPointerUp(event: PointerEvent) {
    if (mode !== "interact" || activePointer.current !== event.pointerId) return;
    activePointer.current = undefined;
    const point = coordinate(event);
    enqueuePointerInput({
      contactId: event.pointerId,
      phase: "up",
      x: point.x,
      y: point.y,
    });
  }

  async function saveComment() {
    const currentEditor = editor;
    if (!currentEditor?.note.trim() || savingComment) return;
    const note = currentEditor.note.trim();
    setSavingComment(true);
    try {
      if (currentEditor.annotationId) {
        const updated = embedded
          ? updateDraftAnnotation(state.annotations, currentEditor.annotationId, note)
          : await relayFetch("/annotation", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "update",
                id: currentEditor.annotationId,
                note,
              }),
            }).then(annotationResponse);
        setState((current) => ({
          ...current,
          annotations: current.annotations.map((item) => (item.id === updated.id ? updated : item)),
        }));
        sentAnnotationIds.current.delete(updated.id);
      } else {
        const annotation = embedded
          ? createDraftAnnotation(currentEditor, note)
          : await relayFetch("/annotation", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "add",
                frameId: currentEditor.frameId,
                geometry: currentEditor.point,
                note,
                context: currentEditor.context,
              }),
            }).then(annotationResponse);
        setState((current) => ({ ...current, annotations: [...current.annotations, annotation] }));
      }
      setEditor(undefined);
      show("Comment saved");
    } catch (error) {
      show(`Unable to save comment: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingComment(false);
    }
  }

  async function deleteComment() {
    if (!editor?.annotationId) return;
    const annotationId = editor.annotationId;
    if (!embedded) {
      await relayFetch("/annotation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", id: annotationId }),
      });
    }
    sentAnnotationIds.current.delete(annotationId);
    setState((current) => ({
      ...current,
      annotations: current.annotations.filter((item) => item.id !== annotationId),
    }));
    setEditor(undefined);
    show("Comment deleted");
  }

  async function sendToChat() {
    if (!embedded) return show("Send to Chat is available inside an MCP host");
    const canvas = canvasRef.current;
    if (!canvas?.width || !canvas.height) return show("No simulator frame to send");
    const imageData = canvas.toDataURL("image/png").split(",", 2)[1];
    if (!imageData) return show("Screenshot capture failed");
    const annotations = visibleAnnotations.map((annotation) => ({
      id: annotation.id,
      text: annotation.note,
      context: annotationMessageContext(annotation),
      screenshot: croppedAnnotationScreenshot(canvas, annotation),
    }));
    const capturedScreenContext =
      frozenScreenContext ??
      screenContext ??
      createUIKitScreenContext({ ...state, frameId: activeFrameId }, uiContext, visibleAnnotations);
    try {
      const savedImages = saveReviewImagesOutputSchema.parse(
        (
          await bridge.callServerTool({
            name: "save_review_images",
            arguments: {
              screenshot: imageData,
              annotations: annotations.map(({ id, screenshot }) => ({ id, screenshot })),
            },
          })
        ).structuredContent,
      );
      const annotationPaths = new Map(
        savedImages.annotations.map((annotation) => [annotation.id, annotation.screenshotPath]),
      );
      const result = await bridge.sendMessage({
        role: "user",
        content: annotationMessageContent(
          savedImages.screenshotPath,
          annotationMessageScreenContext(capturedScreenContext),
          annotations.map(({ id, text, context }) => ({
            text,
            context,
            screenshotPath: annotationPaths.get(id) ?? savedImages.screenshotPath,
          })),
        ),
      });
      if (result.isError) throw new Error("The MCP host rejected the message");
    } catch (error) {
      show(`Unable to send annotations: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    visibleAnnotations.forEach((annotation) => {
      sentAnnotationIds.current.add(annotation.id);
    });
    completeEnterInteractMode();
    show("Sent frozen frame and annotation image paths to chat");
  }

  async function captureOnly() {
    if (!embedded) return show("Capture is available inside an MCP host");
    await bridge.callServerTool({ name: "app_take_screenshot", arguments: {} });
    show("Screenshot captured");
  }

  async function toggleRecording() {
    if (recordingRef.current?.state === "recording") {
      recordingRef.current.stop();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(canvas.captureStream(60), { mimeType: "video/webm" });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      link.download = `simview-${Date.now()}.webm`;
      link.click();
      URL.revokeObjectURL(link.href);
      show("Recording downloaded");
    };
    recorder.start();
    recordingRef.current = recorder;
    show("Recording started");
  }

  function show(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2_200);
  }

  const activeFrameId = frozenFrameId ?? latestFrameIdRef.current ?? state.frameId;
  const visibleAnnotations = state.annotations.filter(
    (annotation) => annotation.frameId === activeFrameId || annotation.frameId === "current",
  );
  const unsentAnnotations = visibleAnnotations.filter(
    (annotation) => !sentAnnotationIds.current.has(annotation.id),
  );
  pendingAnnotationsRef.current = unsentAnnotations;

  function enterAnnotateMode() {
    frozenRef.current = true;
    const frameId = latestFrameIdRef.current ?? state.frameId ?? "current";
    setFrozenFrameId(frameId);
    setFrozenScreenContext(
      screenContext
        ? { ...screenContext, frameId }
        : createUIKitScreenContext({ ...state, frameId }, uiContext, visibleAnnotations),
    );
    setMode("annotate");
    setEditor(undefined);
    void loadAccessibility();
    void loadUiContext();
  }

  function enterInteractMode() {
    if (pendingAnnotationsRef.current.length) {
      setDiscardConfirmOpen(true);
      return;
    }
    completeEnterInteractMode();
  }

  function completeEnterInteractMode() {
    frozenRef.current = false;
    setFrozenFrameId(undefined);
    setFrozenScreenContext(undefined);
    setMode("interact");
    setEditor(undefined);
    setSelectedElement(undefined);
    if (!elementsOpen) elementTreeAbortRef.current?.abort();
  }

  async function clearUnsentAndEnterInteract() {
    const annotationIds = pendingAnnotationsRef.current.map((annotation) => annotation.id);
    if (!annotationIds.length) {
      setDiscardConfirmOpen(false);
      completeEnterInteractMode();
      return;
    }

    setDiscardingAnnotations(true);
    try {
      if (!embedded) {
        await Promise.all(
          annotationIds.map((id) =>
            relayFetch("/annotation", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "delete", id }),
            }).then((response) => {
              if (!response.ok) throw new Error(`Annotation delete failed (${response.status})`);
            }),
          ),
        );
      }

      const discardedIds = new Set(annotationIds);
      annotationIds.forEach((id) => {
        sentAnnotationIds.current.delete(id);
      });
      setState((current) => ({
        ...current,
        annotations: current.annotations.filter((annotation) => !discardedIds.has(annotation.id)),
      }));
      setDiscardConfirmOpen(false);
      completeEnterInteractMode();
    } catch (error) {
      show(
        `Unable to clear annotations: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setDiscardingAnnotations(false);
    }
  }

  async function loadAccessibility(quiet = false) {
    if (accessibilityRequestPending.current) return undefined;
    accessibilityRequestPending.current = true;
    const controller = new AbortController();
    elementTreeAbortRef.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(new DOMException("Element tree transfer timed out", "TimeoutError")),
      15_000,
    );
    const releasePreviewBridge = embedded
      ? previewBridgeGateRef.current.beginPriority()
      : undefined;
    try {
      try {
        const result = embedded
          ? await loadPagedElementTree("elements", controller.signal)
          : await relayFetch("/elements?scope=full&maxNodes=1200").then(async (response) => {
              if (!response.ok) throw new Error(`Element request failed (${response.status})`);
              return elementTreeOutputSchema.parse(await response.json());
            });
        throwIfAborted(controller.signal);
        applyElementTree(result.snapshot, result.screenContext, result.fallback?.reason);
        return result.snapshot;
      } catch (error) {
        throwIfAborted(controller.signal);
        if (!embedded) throw error;
        const fallback = await loadPagedElementTree("accessibility", controller.signal);
        throwIfAborted(controller.signal);
        applyElementTree(fallback.snapshot, fallback.screenContext);
        if (!quiet) {
          const reason = error instanceof Error ? error.message : String(error);
          show(`React Native elements unavailable (${reason}); showing accessibility tree`);
        }
        return fallback.snapshot;
      }
    } catch (error) {
      if (!isAbortError(error) && !quiet) {
        show(`Element tree unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    } finally {
      window.clearTimeout(timeout);
      releasePreviewBridge?.();
      if (elementTreeAbortRef.current === controller) {
        elementTreeAbortRef.current = undefined;
        accessibilityRequestPending.current = false;
      }
    }
  }

  function applyElementTree(
    snapshot: AccessibilitySnapshot,
    context: ScreenContext,
    fallback?: ElementFallbackReason,
  ) {
    const nodes = flattenTree(snapshot.root);
    const inspectorRows = inspectorTreeRows(
      snapshot.root,
      snapshot.source === "react-native-fiber",
    );
    const branchRefs = new Set(
      inspectorRows.filter((row) => row.hasChildren).map((row) => row.node.ref),
    );
    const inspectorRefs = new Set(inspectorRows.map((row) => row.node.ref));
    setAccessibility(snapshot);
    setScreenContext(context);
    setElementFallback(fallback);
    if (frozenRef.current) {
      const frameId = frozenFrameId ?? latestFrameIdRef.current ?? state.frameId ?? "current";
      setFrozenScreenContext({ ...context, frameId });
    }
    setExpandedElements((current) => {
      if (!accessibilityInitialized.current) {
        accessibilityInitialized.current = true;
        return branchRefs;
      }
      const retained = [...current].filter((ref) => branchRefs.has(ref));
      return retained.length ? new Set(retained) : branchRefs;
    });
    setSelectedElement((current) =>
      current && inspectorRefs.has(current.ref)
        ? nodes.find((node) => node.ref === current.ref)
        : undefined,
    );
  }

  async function loadUiContext() {
    try {
      if (embedded) {
        const result = await bridge
          .callServerTool({
            name: "app_get_ui_context",
            arguments: {},
          })
          .then((response) => uiContextSchema.parse(response.structuredContent));
        setUiContext(result);
        return;
      }
      const status = await relayFetch("/probe/status").then(async (response) => {
        if (!response.ok) throw new Error(`Probe status failed (${response.status})`);
        return uiContextSchema.shape.status.parse(await response.json());
      });
      const context = status.connected
        ? await relayFetch("/probe/context").then(async (response) => {
            if (!response.ok) throw new Error(`Probe context failed (${response.status})`);
            return uiContextSchema.shape.context.unwrap().parse(await response.json());
          })
        : undefined;
      const target = !status.connected
        ? await relayFetch("/probe/target").then(async (response) => {
            if (!response.ok) throw new Error(`Probe target detection failed (${response.status})`);
            return uiContextSchema.shape.target.unwrap().parse(await response.json());
          })
        : undefined;
      setUiContext({ status, context, target });
    } catch {
      setUiContext(undefined);
    }
  }

  async function enableUiProbe(event: SubmitEvent) {
    event.preventDefault();
    const bundleId = probeBundleId.trim();
    if (bundleId.length < 3) {
      setProbeError("Enter the app bundle identifier.");
      return;
    }
    if (bundleId.startsWith("com.apple.")) {
      setProbeError("Apple platform apps cannot load the UIKit probe.");
      return;
    }
    setProbeEnabling(true);
    setProbeError("");
    try {
      if (embedded) {
        await bridge.callServerTool({
          name: "app_enable_ui_probe",
          arguments: { bundleId },
        });
      } else {
        const response = await relayFetch("/probe/enable", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bundleId }),
        });
        if (!response.ok) {
          throw new Error((await response.text()) || `Probe enable failed (${response.status})`);
        }
      }
      await loadUiContext();
      if (elementsOpen || mode === "annotate") void loadAccessibility();
      show("UIKit probe connected");
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setProbeEnabling(false);
    }
  }

  async function inspectAnnotationPoint(point: Point) {
    try {
      const snapshot = embedded
        ? await bridge
            .callServerTool({
              name: "app_inspect_point",
              arguments: { x: point.x, y: point.y },
            })
            .then((result) => inspectPointOutputSchema.parse(result.structuredContent))
        : await relayFetch(`/inspect-point?x=${point.x}&y=${point.y}`).then(async (response) =>
            inspectPointOutputSchema.parse(await response.json()),
          );
      const node = snapshot.element;
      setEditor((current) =>
        current && current.point.x === point.x && current.point.y === point.y
          ? (() => {
              const inspected = contextForInspectedNode(accessibility, node);
              const currentAccessibility = current.context?.accessibility;
              return {
                ...current,
                context: {
                  capturedAt: current.context?.capturedAt ?? inspected.capturedAt,
                  accessibility: currentAccessibility
                    ? {
                        ...inspected.accessibility,
                        ...currentAccessibility,
                        frame: currentAccessibility.frame ?? inspected.accessibility?.frame,
                        path: currentAccessibility.path ?? inspected.accessibility?.path,
                      }
                    : inspected.accessibility,
                  native: snapshot.native
                    ? { ...snapshot.native, matchConfidence: "strong" }
                    : undefined,
                  metro: current.context?.metro,
                },
              };
            })()
          : current,
      );
    } catch {
      // A point comment remains usable when accessibility is incomplete.
    }
  }

  function chooseElement(node: AccessibilityNode) {
    setSelectedElement(node);
    if (mode === "annotate") startAnnotationForElement(node);
  }

  function annotateElement(node: AccessibilityNode) {
    startAnnotationForElement(node, true);
  }

  function startAnnotationForElement(node: AccessibilityNode, activateMode = false) {
    const frame = node.frame?.normalized;
    if (!frame) return;
    const point: Point = {
      kind: "point",
      x: frame.x + frame.width / 2,
      y: frame.y + frame.height / 2,
    };
    frozenRef.current = true;
    const currentFrameId = latestFrameIdRef.current ?? state.frameId ?? "current";
    setFrozenFrameId(currentFrameId);
    setFrozenScreenContext(
      screenContext
        ? { ...screenContext, frameId: currentFrameId }
        : createUIKitScreenContext(
            { ...state, frameId: currentFrameId },
            uiContext,
            visibleAnnotations,
          ),
    );
    if (activateMode) setMode("annotate");
    setElementsOpen(true);
    setSelectedElement(node);
    setHoveredElement(undefined);
    setHoveredContext(undefined);
    setEditor({
      point,
      note: "",
      frameId: frozenFrameId ?? currentFrameId,
      context: elementContext(node),
    });
  }

  function toggleElement(ref: string) {
    setExpandedElements((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  function toggleAllElements() {
    if (!accessibility) return;
    const branches = inspectorTreeRows(
      accessibility.root,
      accessibility.source === "react-native-fiber",
    ).filter((row) => row.hasChildren);
    const allExpanded = branches.every(({ node }) => expandedElements.has(node.ref));
    setExpandedElements(new Set(allExpanded ? [] : branches.map(({ node }) => node.ref)));
  }

  async function tapSelectedElement() {
    if (!selectedElement) return;
    if (embedded && accessibility?.source !== "react-native-fiber") {
      await bridge.callServerTool({
        name: "app_tap_element",
        arguments: { ref: selectedElement.ref },
      });
    } else {
      const frame = selectedElement.frame?.normalized;
      if (!frame) return;
      await relayInput("input.tap", {
        x: frame.x + frame.width / 2,
        y: frame.y + frame.height / 2,
      });
    }
    setElementsOpen(false);
    show("Physical element tap accepted");
  }

  const renderedOnly = accessibility?.source === "react-native-fiber";
  const allInspectorRows =
    elementsOpen && accessibility ? inspectorTreeRows(accessibility.root, renderedOnly) : [];
  const elementRows =
    elementsOpen && accessibility
      ? visibleTree(accessibility.root, expandedElements, elementSearch, renderedOnly)
      : [];
  const visibleElementCount = Math.max(0, allInspectorRows.length - 1);
  const inspectedElement = hoveredElement ?? selectedElement;
  const highlightedElement = inspectedElement ?? selectedElement;
  const activeScene =
    uiContext?.context?.scenes?.find((scene) => scene.activationState === "foregroundActive") ??
    uiContext?.context?.scenes?.[0];
  const keyWindow =
    activeScene?.windows?.find((window) => window.key && !window.hidden) ??
    activeScene?.windows?.find((window) => !window.hidden);
  const visibleController = keyWindow?.visibleControllerPath?.at(-1);
  const displayedScreenContext = frozenScreenContext ?? screenContext;

  return (
    <main
      class={`shell single ${elementsOpen ? "sidebar-open" : "sidebar-closed"}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` }}
    >
      <header class="topbar">
        <div class="left-actions">
          <div ref={toolsMenuRef} class="tools-menu-wrap">
            <button
              type="button"
              class="tool-button tools-trigger"
              aria-label="Simulator tools"
              aria-expanded={toolsOpen}
              onClick={() => {
                setDeviceMenuOpen(false);
                setToolsOpen((value) => !value);
              }}
            >
              <Icon name="menu" />
            </button>
            {toolsOpen && (
              <nav class="tools-menu" aria-label="Simulator tools">
                <button
                  type="button"
                  onClick={() => {
                    setToolsOpen(false);
                    void relayInput("input.button", { button: "home" });
                  }}
                >
                  <Icon name="home" />
                  <span>Home</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setToolsOpen(false);
                    setTypeText("");
                    setTypeTextOpen(true);
                  }}
                >
                  <Icon name="type" />
                  <span>Type text…</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setToolsOpen(false);
                    void captureOnly();
                  }}
                >
                  <Icon name="capture" />
                  <span>Capture</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setToolsOpen(false);
                    void toggleRecording();
                  }}
                >
                  <Icon name="record" />
                  <span>
                    {recordingRef.current?.state === "recording" ? "Stop recording" : "Record"}
                  </span>
                </button>
              </nav>
            )}
          </div>
          <div ref={deviceMenuRef} class="device-menu-wrap">
            <button
              type="button"
              class="tool-button device-trigger"
              aria-label="Choose simulator"
              aria-expanded={deviceMenuOpen}
              onClick={() => void toggleDeviceMenu()}
            >
              <Icon name="phone" />
            </button>
            {deviceMenuOpen && (
              <div class="device-menu" role="menu" aria-label="Booted simulators">
                <div class="device-menu-heading">
                  <strong>Booted Simulators</strong>
                  <button
                    type="button"
                    class="icon-action"
                    aria-label="Refresh simulators"
                    disabled={devicesLoading}
                    onClick={() => void loadBootedDevices()}
                  >
                    <Icon name="refresh" />
                  </button>
                </div>
                {devicesLoading && !bootedDevices.length ? (
                  <p>Looking for booted devices…</p>
                ) : bootedDevices.length ? (
                  bootedDevices.map((device) => {
                    const selected = device.udid === state.device?.udid;
                    return (
                      <button
                        key={device.udid}
                        type="button"
                        role="menuitem"
                        class="device-option"
                        disabled={Boolean(switchingDevice)}
                        onClick={() => void selectSimulator(device)}
                      >
                        <span class="device-check">{selected && <Icon name="check" />}</span>
                        <span>
                          <strong>{device.name}</strong>
                          <small>{formatRuntime(device.runtime)}</small>
                        </span>
                        {switchingDevice === device.udid && (
                          <span class="device-switching">Switching…</span>
                        )}
                      </button>
                    );
                  })
                ) : (
                  <p>No booted simulators found.</p>
                )}
              </div>
            )}
          </div>
        </div>
        <fieldset class="mode-switch" aria-label="Preview mode">
          <button type="button" aria-pressed={mode === "interact"} onClick={enterInteractMode}>
            <Icon name="finger" /> Interact
          </button>
          <button type="button" aria-pressed={mode === "annotate"} onClick={enterAnnotateMode}>
            <Icon name="annotate" /> Annotate
            {!!visibleAnnotations.length && <span class="count">{visibleAnnotations.length}</span>}
          </button>
        </fieldset>
        <div class="top-actions">
          <button
            type="button"
            class="tool-button sidebar-toggle"
            aria-label={elementsOpen ? "Hide inspector" : "Show inspector"}
            aria-pressed={elementsOpen}
            onClick={() => {
              if (elementsOpen) {
                setElementsOpen(false);
                if (mode !== "annotate") elementTreeAbortRef.current?.abort();
              } else {
                setElementsOpen(true);
                void loadAccessibility();
                void loadUiContext();
              }
            }}
          >
            <Icon name="sidebar" /> <span>Inspector</span>
          </button>
          <button type="button" class="primary send-chat" onClick={() => void sendToChat()}>
            <Icon name="send" /> <span>Send to Chat</span>
          </button>
        </div>
      </header>

      <div class="workspace-single">
        <section class="single-stage">
          <div
            ref={screenRef}
            class={`screen-wrap ${mode === "annotate" ? "annotate-cursor" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (mode === "annotate" && !editor) {
                hoverRequest.current += 1;
                setHoveredElement(undefined);
                setHoveredContext(undefined);
              }
            }}
          >
            <canvas ref={canvasRef} />
            {highlightedElement?.frame?.normalized && (
              <div
                class="element-highlight"
                style={{
                  left: `${highlightedElement.frame.normalized.x * 100}%`,
                  top: `${highlightedElement.frame.normalized.y * 100}%`,
                  width: `${highlightedElement.frame.normalized.width * 100}%`,
                  height: `${highlightedElement.frame.normalized.height * 100}%`,
                }}
              />
            )}
            {startupPhase !== "ready" && (
              <div class={`empty startup ${startupPhase === "error" ? "startup-error" : ""}`}>
                {startupPhase !== "error" && <span class="startup-spinner" aria-hidden="true" />}
                <strong>
                  {startupPhase === "error"
                    ? "Simulator unavailable"
                    : startupPhase === "waiting-for-frame"
                      ? "Starting live preview"
                      : "Connecting to Simulator"}
                </strong>
                <span>
                  {startupPhase === "error"
                    ? `${startupError} Choose a booted Simulator from the device menu.`
                    : startupPhase === "waiting-for-frame"
                      ? `Waiting for the first frame${state.device?.name ? ` from ${state.device.name}` : ""}…`
                      : "Finding a booted device and starting capture…"}
                </span>
              </div>
            )}
            {visibleAnnotations.map((annotation, index) => (
              <button
                type="button"
                key={annotation.id}
                class="annotation-dot"
                style={{
                  left: `${annotation.geometry.x * 100}%`,
                  top: `${annotation.geometry.y * 100}%`,
                }}
                title={annotation.note}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setEditor({
                    point: annotation.geometry,
                    note: annotation.note,
                    frameId: annotation.frameId,
                    annotationId: annotation.id,
                    context: annotation.context,
                  });
                }}
              >
                {index + 1}
              </button>
            ))}
            {editor && (
              <form
                class={`comment-popover ${editor.point.x > 0.62 ? "align-right" : ""} ${editor.point.y > 0.65 ? "align-bottom" : ""}`}
                style={{ left: `${editor.point.x * 100}%`, top: `${editor.point.y * 100}%` }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveComment();
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div class="comment-head">
                  <span class="comment-pin">
                    <Icon name="comment-bubble" />
                  </span>
                  <div>
                    <strong>{editor.context?.accessibility?.label ?? "Screen comment"}</strong>
                    <small>
                      {editor.context?.accessibility?.role?.replace(/^AX/, "") ??
                        `${percent(editor.point.x)} · ${percent(editor.point.y)}`}
                    </small>
                  </div>
                </div>
                <textarea
                  ref={editorInputRef}
                  rows={3}
                  placeholder="Leave a comment…"
                  value={editor.note}
                  onInput={(event) =>
                    setEditor((current) =>
                      current ? { ...current, note: event.currentTarget.value } : current,
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditor(undefined);
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void saveComment();
                    }
                  }}
                />
                <div class="comment-actions">
                  {editor.annotationId && (
                    <button
                      type="button"
                      class="danger icon-action"
                      aria-label="Delete comment"
                      onClick={() => void deleteComment()}
                    >
                      <Icon name="trash" />
                    </button>
                  )}
                  <span />
                  <button
                    type="button"
                    disabled={savingComment}
                    onClick={() => setEditor(undefined)}
                  >
                    Cancel
                  </button>
                  <button
                    class="primary"
                    type="submit"
                    disabled={!editor.note.trim() || savingComment}
                  >
                    {savingComment ? "Saving…" : "Save"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
        <aside class="inspector" aria-label="Simulator inspector">
          <div
            class="sidebar-resizer"
            onPointerDown={(event) => {
              sidebarResize.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: sidebarWidth,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={resizeSidebar}
            onPointerUp={stopSidebarResize}
            onPointerCancel={stopSidebarResize}
          />
          <section class="inspector-section elements-panel">
            <div class="section-heading">
              <div>
                <strong>Elements</strong>
                <small>
                  {accessibility ? (
                    <span
                      title={
                        elementFallback
                          ? elementFallbackLabels[elementFallback]
                          : accessibility.source === "react-native-fiber"
                            ? `${accessibility.stats.nodeCount} Fiber nodes inspected`
                            : undefined
                      }
                    >
                      {accessibility.source === "react-native-fiber"
                        ? "React Native · "
                        : elementFallback
                          ? "AX fallback · "
                          : "AX · "}
                      {accessibility.source === "react-native-fiber"
                        ? `${visibleElementCount} visible`
                        : accessibility.stats.nodeCount}
                      {accessibility.source !== "react-native-fiber" &&
                      accessibility.stats.truncated
                        ? "+"
                        : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </small>
              </div>
              <div class="section-actions">
                {accessibility && (
                  <button
                    type="button"
                    class="icon-action"
                    aria-label={
                      expandedElements.size ? "Collapse element tree" : "Expand element tree"
                    }
                    onClick={toggleAllElements}
                  >
                    <Icon name={expandedElements.size ? "collapse-tree" : "expand-tree"} />
                  </button>
                )}
                <button
                  type="button"
                  class="icon-action"
                  aria-label="Refresh elements"
                  onClick={() => {
                    void loadAccessibility();
                    void loadUiContext();
                  }}
                >
                  <Icon name="refresh" />
                </button>
              </div>
            </div>
            <input
              type="search"
              placeholder="Filter elements"
              value={elementSearch}
              onInput={(event) => setElementSearch(event.currentTarget.value)}
            />
            <div class="element-tree" role="tree" onMouseLeave={() => setHoveredElement(undefined)}>
              {elementRows.map(({ node, depth, isRoot, hasChildren }) => (
                <button
                  type="button"
                  key={node.ref}
                  class={selectedElement?.ref === node.ref ? "selected" : ""}
                  role="treeitem"
                  onClick={() => {
                    chooseElement(node);
                    if (hasChildren) toggleElement(node.ref);
                  }}
                  onMouseEnter={() => setHoveredElement(node)}
                  style={{ "--tree-depth": depth }}
                  aria-expanded={hasChildren ? expandedElements.has(node.ref) : undefined}
                >
                  {hasChildren && (
                    <span class="disclosure">
                      <Icon
                        name={expandedElements.has(node.ref) ? "chevron-down" : "chevron-right"}
                      />
                    </span>
                  )}
                  <span class="element-name" title={isRoot ? "Screen" : elementName(node)}>
                    {isRoot ? "Screen" : elementName(node)}
                  </span>
                </button>
              ))}
              {!elementRows.length && <p>No matching elements.</p>}
            </div>
          </section>
          <section
            class={`inspector-section info-panel ${infoOpen ? "" : "collapsed"}`}
            style={{ "--info-height": `${infoHeight}px` }}
          >
            {infoOpen && (
              <div
                class="info-resizer"
                onPointerDown={(event) => {
                  infoResize.current = {
                    pointerId: event.pointerId,
                    startY: event.clientY,
                    startHeight: infoHeight,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={resizeInfo}
                onPointerUp={stopInfoResize}
                onPointerCancel={stopInfoResize}
              />
            )}
            <div class="section-heading">
              <button
                type="button"
                class="section-toggle"
                aria-expanded={infoOpen}
                onClick={() => setInfoOpen((value) => !value)}
              >
                <Icon name={infoOpen ? "chevron-down" : "chevron-right"} />
                <strong>Info</strong>
              </button>
            </div>
            {infoOpen && selectedElement?.frame && (
              <div class="element-actions">
                {mode === "interact" && (
                  <button type="button" onClick={() => void tapSelectedElement()}>
                    <Icon name="finger" /> Tap
                  </button>
                )}
                <button
                  type="button"
                  class="primary"
                  onClick={() => annotateElement(selectedElement)}
                >
                  <Icon name="annotate" /> Annotate
                </button>
              </div>
            )}
            {infoOpen && mode === "annotate" && selectedElement?.frame && (
              <p class="anchor-note">
                <Icon name="annotate" /> Comment anchored to this element.
              </p>
            )}
            {infoOpen &&
              (inspectedElement ? (
                <dl>
                  <div>
                    <dt>Name</dt>
                    <dd>{elementName(inspectedElement)}</dd>
                  </div>
                  <div>
                    <dt>Role</dt>
                    <dd>
                      {inspectedElement.roleDescription ??
                        inspectedElement.role?.replace(/^AX/, "") ??
                        "Element"}
                    </dd>
                  </div>
                  <div>
                    <dt>Title</dt>
                    <dd>{inspectedElement.title ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Label</dt>
                    <dd>{inspectedElement.label ?? inspectedElement.placeholder ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Identifier</dt>
                    <dd>{inspectedElement.testID ?? inspectedElement.identifier ?? "—"}</dd>
                  </div>
                  {inspectedElement.component && (
                    <div>
                      <dt>Component</dt>
                      <dd>{inspectedElement.component}</dd>
                    </div>
                  )}
                  {inspectedElement.sourceLocation && (
                    <div>
                      <dt>Source</dt>
                      <dd>
                        {inspectedElement.sourceLocation.file}
                        {inspectedElement.sourceLocation.line
                          ? `:${inspectedElement.sourceLocation.line}`
                          : ""}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Value</dt>
                    <dd>{inspectedElement.value ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Frame</dt>
                    <dd>{formatFrame(inspectedElement.frame?.normalized)}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>
                      {[
                        inspectedElement.enabled === false && "Disabled",
                        inspectedElement.focused && "Focused",
                      ]
                        .filter(Boolean)
                        .join(", ") || "Enabled"}
                    </dd>
                  </div>
                  {!!inspectedElement.actions?.length && (
                    <div>
                      <dt>Actions</dt>
                      <dd>{inspectedElement.actions.join(", ")}</dd>
                    </div>
                  )}
                </dl>
              ) : (
                <div class="info-empty">
                  <Icon name="cursor" />
                  <span>Hover or select an element to inspect it.</span>
                </div>
              ))}
          </section>
          <section class={`inspector-section scene-info ${sceneOpen ? "" : "collapsed"}`}>
            <div class="section-heading">
              <button
                type="button"
                class="section-toggle"
                aria-expanded={sceneOpen}
                onClick={() => setSceneOpen((value) => !value)}
              >
                <Icon name={sceneOpen ? "chevron-down" : "chevron-right"} />
                <strong>Scene</strong>
              </button>
              {displayedScreenContext?.kind === "react-native" ? (
                <span class="probe-live">React Native</span>
              ) : (
                uiContext?.status.connected && <span class="probe-live">UIKit</span>
              )}
            </div>
            {sceneOpen &&
              (displayedScreenContext?.kind === "react-native" ? (
                <dl>
                  <div>
                    <dt>Route</dt>
                    <dd>{displayedScreenContext.route ?? "—"}</dd>
                  </div>
                  {!!displayedScreenContext.navigationPath?.length && (
                    <div class="controller-path">
                      <dt>Path</dt>
                      <dd>{displayedScreenContext.navigationPath.join(" › ")}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Screen</dt>
                    <dd>{displayedScreenContext.screenComponent ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Renderer</dt>
                    <dd>{formatProbeValue(displayedScreenContext.renderer)}</dd>
                  </div>
                  <div>
                    <dt>Match</dt>
                    <dd>{formatProbeValue(displayedScreenContext.confidence)}</dd>
                  </div>
                  {displayedScreenContext.sourceLocation && (
                    <div class="controller-path">
                      <dt>Source</dt>
                      <dd>
                        {displayedScreenContext.sourceLocation.file}
                        {displayedScreenContext.sourceLocation.line
                          ? `:${displayedScreenContext.sourceLocation.line}`
                          : ""}
                      </dd>
                    </div>
                  )}
                </dl>
              ) : activeScene ? (
                <dl>
                  <div>
                    <dt>State</dt>
                    <dd>{formatProbeValue(activeScene.activationState)}</dd>
                  </div>
                  <div>
                    <dt>Scene</dt>
                    <dd>
                      {activeScene.configurationName ??
                        compactIdentifier(activeScene.persistentIdentifier)}
                    </dd>
                  </div>
                  <div>
                    <dt>Window</dt>
                    <dd>{keyWindow?.className ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Controller</dt>
                    <dd>{visibleController ?? "—"}</dd>
                  </div>
                  {!!keyWindow?.visibleControllerPath?.length && (
                    <div class="controller-path">
                      <dt>Path</dt>
                      <dd>{keyWindow.visibleControllerPath.join(" › ")}</dd>
                    </div>
                  )}
                </dl>
              ) : !uiContext ? (
                <div class="probe-empty">
                  <Icon name="layers" />
                  <span>Detecting the foreground Simulator app…</span>
                </div>
              ) : uiContext.status.bundled ? (
                <form class="probe-enable" onSubmit={enableUiProbe}>
                  <div class="probe-empty">
                    <Icon name="layers" />
                    <span>Scene and controller details require the optional UIKit probe.</span>
                  </div>
                  <label for="probe-bundle-id">App bundle identifier</label>
                  <div class="probe-enable-row">
                    <input
                      id="probe-bundle-id"
                      type="text"
                      value={probeBundleId}
                      placeholder="com.example.app"
                      autocomplete="off"
                      autocapitalize="none"
                      spellcheck={false}
                      onInput={(event) => setProbeBundleId(event.currentTarget.value)}
                    />
                    <button class="primary" type="submit" disabled={probeEnabling}>
                      {probeEnabling ? "Enabling…" : "Enable"}
                    </button>
                  </div>
                  {uiContext.target?.bundleId && (
                    <small class="probe-detected">
                      Detected from the foreground Simulator app.
                    </small>
                  )}
                  <small>This terminates and relaunches the selected Simulator app.</small>
                  {probeError && (
                    <p class="probe-error" role="alert">
                      {probeError}
                    </p>
                  )}
                </form>
              ) : (
                <div class="probe-empty">
                  <Icon name="layers" />
                  <span>UIKit scene inspection is unavailable in this build.</span>
                </div>
              ))}
          </section>
        </aside>
      </div>

      {discardConfirmOpen && (
        <div class="alert-backdrop">
          <section
            class="discard-alert"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-alert-title"
            aria-describedby="discard-alert-description"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !discardingAnnotations) {
                setDiscardConfirmOpen(false);
              }
            }}
          >
            <div class="discard-alert-copy">
              <span class="discard-alert-icon">
                <Icon name="annotate" />
              </span>
              <div>
                <strong id="discard-alert-title">Clear unsent annotations?</strong>
                <p id="discard-alert-description">
                  {unsentAnnotations.length === 1
                    ? "This annotation has not been sent to chat. Switching to Interact will clear it."
                    : `These ${unsentAnnotations.length} annotations have not been sent to chat. Switching to Interact will clear them.`}
                </p>
              </div>
            </div>
            <div class="discard-alert-actions">
              <button
                type="button"
                autofocus
                disabled={discardingAnnotations}
                onClick={() => setDiscardConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="danger-action"
                disabled={discardingAnnotations}
                onClick={() => void clearUnsentAndEnterInteract()}
              >
                {discardingAnnotations ? "Clearing…" : "Clear & Switch"}
              </button>
            </div>
          </section>
        </div>
      )}
      {typeTextOpen && (
        <div class="alert-backdrop">
          <form
            class="discard-alert type-text-alert"
            role="dialog"
            aria-modal="true"
            aria-labelledby="type-text-title"
            onSubmit={submitTypedText}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !typingText) {
                setTypeTextOpen(false);
                setTypeText("");
              }
            }}
          >
            <div class="discard-alert-copy">
              <span class="discard-alert-icon">
                <Icon name="type" />
              </span>
              <div>
                <strong id="type-text-title">Type text in Simulator</strong>
                <p>Enter the text to send to the currently focused control.</p>
              </div>
            </div>
            <textarea
              autofocus
              rows={3}
              value={typeText}
              aria-label="Text to type"
              disabled={typingText}
              onInput={(event) => setTypeText(event.currentTarget.value)}
            />
            <div class="discard-alert-actions">
              <button
                type="button"
                disabled={typingText}
                onClick={() => {
                  setTypeTextOpen(false);
                  setTypeText("");
                }}
              >
                Cancel
              </button>
              <button type="submit" class="primary" disabled={!typeText || typingText}>
                {typingText ? "Typing…" : "Type Text"}
              </button>
            </div>
          </form>
        </div>
      )}
      {toast && (
        <div class="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}

function createDraftAnnotation(editor: Editor, note: string): Annotation {
  return {
    id: crypto.randomUUID(),
    frameId: editor.frameId,
    createdAt: new Date().toISOString(),
    geometry: editor.point,
    note,
    context: editor.context,
  };
}

function updateDraftAnnotation(annotations: Annotation[], id: string, note: string): Annotation {
  const annotation = annotations.find((item) => item.id === id);
  if (!annotation) throw new Error("The annotation no longer exists");
  return { ...annotation, note };
}

async function annotationResponse(response: Response): Promise<Annotation> {
  if (!response.ok) {
    throw new Error((await response.text()) || `Annotation request failed (${response.status})`);
  }
  return requireAnnotation(await response.json());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Element tree transfer was cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toolResultError(content: unknown): string {
  if (Array.isArray(content)) {
    const text = content.find(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    );
    if (text) return text.text;
  }
  return "Element tree page request failed";
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pause(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function croppedAnnotationScreenshot(
  canvas: HTMLCanvasElement,
  annotation: Annotation,
): string | undefined {
  const frame = annotationCropRect(annotation);
  const left = Math.max(0, Math.min(canvas.width, Math.floor(frame.x * canvas.width)));
  const top = Math.max(0, Math.min(canvas.height, Math.floor(frame.y * canvas.height)));
  const right = Math.max(
    left,
    Math.min(canvas.width, Math.ceil((frame.x + frame.width) * canvas.width)),
  );
  const bottom = Math.max(
    top,
    Math.min(canvas.height, Math.ceil((frame.y + frame.height) * canvas.height)),
  );
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) return undefined;
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d");
  if (!context) return undefined;
  context.drawImage(canvas, left, top, width, height, 0, 0, width, height);
  return output.toDataURL("image/png").split(",", 2)[1];
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ComponentChildren> = {
    cursor: (
      <>
        <path d="m5 3 11 9-6 .8L7 18z" />
        <path d="m11 13 4 6" />
      </>
    ),
    finger: (
      <>
        <path d="M9.5 11V5.5a2 2 0 0 1 4 0V11" />
        <path d="M13.5 10V7.5a2 2 0 0 1 4 0V12" />
        <path d="M17.5 11v-1a2 2 0 0 1 4 0v4.5c0 4-2.6 6.5-6.5 6.5h-1.6a6 6 0 0 1-4.7-2.3L4.2 13a1.9 1.9 0 0 1 2.8-2.6l2.5 2.2" />
      </>
    ),
    annotate: (
      <path d="M12 4c5 0 8.5 3 8.5 7.1 0 4-3.5 6.9-8.5 6.9-1.1 0-2.2-.2-3.2-.5L5 19.5l.9-4C4.4 14.4 3.5 12.8 3.5 11.1 3.5 7 7 4 12 4Z" />
    ),
    home: (
      <>
        <path d="m3 11 9-8 9 8" />
        <path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" />
      </>
    ),
    type: (
      <>
        <path d="M5 5h14M12 5v14M8 19h8" />
      </>
    ),
    capture: (
      <>
        <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
        <circle cx="12" cy="13" r="3.5" />
      </>
    ),
    record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
    expand: (
      <>
        <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
      </>
    ),
    menu: (
      <>
        <path d="M4 7h16" />
        <path d="M4 12h16" />
        <path d="M4 17h16" />
      </>
    ),
    phone: (
      <>
        <rect x="7" y="2.5" width="10" height="19" rx="2.3" />
        <path d="M10.5 5h3M11 18.5h2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    "comment-bubble": (
      <path
        d="M12 3.5c5 0 8.5 3.1 8.5 7.4 0 4.2-3.5 7.2-8.5 7.2-1.1 0-2.2-.2-3.1-.5L5 19.5l.9-4C4.4 14.3 3.5 12.7 3.5 10.9c0-4.3 3.5-7.4 8.5-7.4Z"
        fill="currentColor"
        stroke="white"
        stroke-width="1.5"
      />
    ),
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    ),
    send: (
      <>
        <path d="m3 11 18-8-7 18-3-7z" />
        <path d="m11 14 4-4" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="2" fill="var(--popover)" />
        <circle cx="15" cy="17" r="2" fill="var(--popover)" />
      </>
    ),
    trash: (
      <>
        <path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
      </>
    ),
    refresh: (
      <>
        <path d="M19 8a8 8 0 1 0 1 7" />
        <path d="M19 3v5h-5" />
      </>
    ),
    "chevron-down": <path d="m7 9 5 5 5-5" />,
    "chevron-right": <path d="m9 7 5 5-5 5" />,
    "collapse-tree": (
      <>
        <path d="m7 10 5-5 5 5" />
        <path d="m7 19 5-5 5 5" />
      </>
    ),
    "expand-tree": (
      <>
        <path d="m7 5 5 5 5-5" />
        <path d="m7 14 5 5 5-5" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 9 5-9 5-9-5z" />
        <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    element: <rect x="5" y="5" width="14" height="14" rx="3" />,
  };
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("SimView app root is missing");
render(<SimView />, appRoot);
