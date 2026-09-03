import CoreMedia
import CoreVideo
import Darwin
import Foundation

func preferredCodec(_ codecs: [String]) -> String {
    codecs.first(where: { $0 == "h264" || $0 == "mjpeg" }) ?? "mjpeg"
}

final class ClientConnection: Hashable, @unchecked Sendable {
    static func == (lhs: ClientConnection, rhs: ClientConnection) -> Bool { lhs === rhs }
    func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }

    let fd: Int32
    private(set) var authenticated = false
    private(set) var codec = "h264"
    private(set) var previewEnabled = false
    private(set) var observationMode = "semantic"
    private weak var server: SimViewServer?
    private var decoder = FrameDecoder()
    private var source: DispatchSourceRead?
    private var authenticationTimeout: DispatchWorkItem?
    private let writeQueue = DispatchQueue(label: "dev.simview.connection.write", qos: .userInteractive)
    private let stateLock = NSLock()
    private var controlFrames: [Data] = []
    private var previewFrame: Data?
    private var writing = false
    private var closed = false

    init(fd: Int32, server: SimViewServer) {
        self.fd = fd
        self.server = server
    }

    func start(on queue: DispatchQueue) {
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        source.setCancelHandler { [fd] in Darwin.close(fd) }
        source.resume()
        self.source = source
        let authenticationTimeout = DispatchWorkItem { [weak self] in
            guard let self, !self.authenticated else { return }
            self.server?.disconnect(self)
        }
        self.authenticationTimeout = authenticationTimeout
        queue.asyncAfter(deadline: .now() + .seconds(2), execute: authenticationTimeout)
    }

    func authenticate(codec: String) {
        self.codec = codec
        authenticated = true
        authenticationTimeout?.cancel()
        authenticationTimeout = nil
    }

    func setObservationMode(_ mode: String) {
        observationMode = mode
    }

    func setPreviewEnabled(_ enabled: Bool) {
        previewEnabled = enabled
    }

    func send(_ frame: WireFrame) {
        sendEncoded(frame.encoded, kind: frame.kind)
    }

    func sendEncoded(_ data: Data, kind: FrameKind) {
        stateLock.lock()
        guard !closed else {
            stateLock.unlock()
            return
        }
        if kind == .h264Frame || kind == .jpegFrame {
            previewFrame = data
        } else {
            controlFrames.append(data)
        }
        if controlFrames.count > 1_024 {
            stateLock.unlock()
            server?.connectionWriteFailed(self)
            return
        }
        let shouldStart = !writing
        writing = true
        stateLock.unlock()
        if shouldStart { writeQueue.async { [weak self] in self?.flushWrites() } }
    }

    func close() {
        authenticationTimeout?.cancel()
        stateLock.lock()
        closed = true
        controlFrames.removeAll()
        previewFrame = nil
        stateLock.unlock()
        source?.cancel()
        source = nil
    }

    private func flushWrites() {
        while true {
            stateLock.lock()
            let data: Data?
            if !controlFrames.isEmpty {
                data = controlFrames.removeFirst()
            } else if let previewFrame {
                data = previewFrame
                self.previewFrame = nil
            } else {
                writing = false
                stateLock.unlock()
                return
            }
            stateLock.unlock()

            guard let data, sendAll(data) else {
                server?.connectionWriteFailed(self)
                return
            }
        }
    }

    private func sendAll(_ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            guard var base = raw.baseAddress else { return false }
            var remaining = raw.count
            while remaining > 0 {
                let written = Darwin.send(fd, base, remaining, MSG_NOSIGNAL)
                if written <= 0 { return false }
                base = base.advanced(by: written)
                remaining -= written
            }
            return true
        }
    }

    private func readAvailable() {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        let count = Darwin.recv(fd, &bytes, bytes.count, 0)
        guard count > 0 else {
            server?.disconnect(self)
            return
        }
        do {
            for frame in try decoder.append(Data(bytes.prefix(count))) {
                server?.receive(frame, from: self)
            }
        } catch {
            server?.sendError(error, requestID: "unknown", to: self)
            server?.disconnect(self)
        }
    }
}

final class SimViewServer: @unchecked Sendable {
    private struct PendingH264Frame: @unchecked Sendable {
        let frame: CVPixelBuffer
        let timestamp: CMTime
        let frameID: String
        let capturedAt: DispatchTime
        let generation: UInt64
    }

    private let socketPath: String
    private let token: String
    private let preferredDeviceID: String?
    private let instanceID: String?
    private let parentPID: pid_t?
    private let idleTimeout: TimeInterval
    private let queue = DispatchQueue(label: "dev.simview.server", qos: .userInteractive)
    private let inputQueue = DispatchQueue(label: "dev.simview.server.input", qos: .userInteractive)
    private let observationQueue = DispatchQueue(
        label: "dev.simview.server.observation",
        qos: .userInitiated,
        attributes: .concurrent
    )
    private let mjpegQueue = DispatchQueue(label: "dev.simview.server.mjpeg", qos: .userInitiated)
    private var listenerFD: Int32 = -1
    private var listener: DispatchSourceRead?
    private var timer: DispatchSourceTimer?
    private var signalSources: [DispatchSourceSignal] = []
    private var connections = Set<ClientConnection>()
    private var lastDisconnect = Date()
    private var hasAuthenticatedClient = false
    private var selectedDevice: DeviceDescription?
    private let capture = FrameCapture()
    private let hid = HIDInjector()
    private let accessibilityObservation = AccessibilityObservationCoordinator()
    private let accessibility: AccessibilityService
    private let probe = ProbeCoordinator()
    private let h264 = H264Encoder()
    private let metrics = Metrics()
    private lazy var androidH264 = H264Decoder { [weak self] event in
        guard let self else { return }
        switch event {
        case .received:
            metrics.didReceiveAndroidDecodeAccessUnit()
        case .scheduled(let workCount):
            metrics.didScheduleAndroidDecode(workCount: workCount)
        case .submitted:
            metrics.didSubmitAndroidDecode()
        case .callback(let latencyMilliseconds):
            metrics.didCompleteAndroidDecodeCallback(latencyMilliseconds: latencyMilliseconds)
        case .dropped:
            metrics.didDropAndroidDecode()
        case .submissionFailure(let submitted):
            metrics.didFailAndroidDecodeSubmission(submitted: submitted)
        case .callbackFailure:
            metrics.didFailAndroidDecodeCallback()
        case .recovery:
            metrics.didRecoverAndroidDecode()
        }
    }
    private lazy var observation = ObservationCoordinator(
        didAttemptImagePreparation: { [weak self] in self?.metrics.didAttemptImageEncode() },
        didCompleteImagePreparation: { [weak self] in self?.metrics.didCompleteImageEncode() }
    )
    private var androidClient: ADBClient?
    private var androidCapture: AndroidFrameCapture?
    private var androidController: AndroidController?
    private var androidAccessibility: AndroidAccessibilityService?
    private var androidAgent: AndroidAgentConnection?
    private var androidAgentError: String?
    private var androidAgentRestartAttempts = 0
    private var androidDecoderFailurePolicy = H264DecodeFailurePolicy(
        maximumConsecutiveFailures: 3)
    private var androidAgentFrameSequence: UInt64 = 0
    private var androidInputWidth = 0
    private var androidInputHeight = 0
    private var latestH264Configuration: Data?
    private var captureActive = false
    private var captureDeviceID: String?
    private var frameID = "0"
    private var encodingFrame = false
    private var pendingH264Frame: PendingH264Frame?
    private var encodingMJPEGFrame = false
    private var pendingMJPEGFrame: PendingH264Frame?
    private var captureGeneration: UInt64 = 0
    private var observationMode = "hybrid"

    init(
        socketPath: String,
        token: String,
        preferredDeviceID: String?,
        instanceID: String?,
        parentPID: pid_t?,
        idleTimeout: TimeInterval
    ) {
        self.socketPath = socketPath
        self.token = token
        self.preferredDeviceID = preferredDeviceID
        self.instanceID = instanceID
        self.parentPID = parentPID
        self.idleTimeout = idleTimeout
        self.accessibility = AccessibilityService(observation: accessibilityObservation)
    }

    func run() throws -> Never {
        try bind()
        let source = DispatchSource.makeReadSource(fileDescriptor: listenerFD, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptConnection() }
        source.setCancelHandler { [listenerFD] in Darwin.close(listenerFD) }
        source.resume()
        listener = source
        installLifecycleTimer()
        installSignalHandlers()
        dispatchMain()
    }

    func receive(_ frame: WireFrame, from connection: ClientConnection) {
        guard frame.kind == .request else {
            sendError(
                SimViewError("PROTOCOL_EXPECTED_REQUEST", "Clients may only send JSON request frames"),
                requestID: "unknown",
                to: connection
            )
            return
        }
        do {
            let request = try Request(data: frame.payload)
            guard request.protocolVersion == SimViewVersion.protocolVersion else {
                throw SimViewError(
                    "PROTOCOL_VERSION_UNSUPPORTED",
                    "Protocol version \(request.protocolVersion) is unsupported",
                    recoverable: false,
                    details: ["supported": [SimViewVersion.protocolVersion]]
                )
            }
            if !connection.authenticated {
                guard
                    request.method == "hello",
                    let candidate = request.params["token"]?.stringValue,
                    secureEquals(candidate, token)
                else {
                    throw SimViewError("AUTHENTICATION_FAILED", "The session token is invalid", recoverable: false)
                }
                let codecs =
                    request.params["codecs"]?.arrayValue?.compactMap(\.stringValue)
                    ?? ["mjpeg"]
                connection.authenticate(codec: preferredCodec(codecs))
                hasAuthenticatedClient = true
                let configuredForAndroid = preferredDeviceID?.hasPrefix("android:") == true
                sendResult(
                    [
                        "protocolVersion": SimViewVersion.protocolVersion,
                        "codec": connection.codec,
                        "maxFrameRate": 60,
                        "server": "simview-core/\(SimViewVersion.current)",
                        "capabilities": [
                            "capture": true,
                            "input": true,
                            "accessibility": configuredForAndroid ? true : accessibility.available,
                            "probe": configuredForAndroid ? false : probe.bundled,
                            "androidContext": configuredForAndroid,
                        ],
                    ], requestID: request.id, to: connection)
                if captureActive, connection.previewEnabled, connection.codec == "h264" {
                    bootstrapH264Preview(for: connection)
                } else if captureActive, connection.previewEnabled, connection.codec == "mjpeg",
                    androidAgent != nil,
                    connections.filter({ $0.authenticated && $0.previewEnabled && $0.codec == "mjpeg" })
                        .count == 1
                {
                    ensureAndroidMJPEGCapture(generation: captureGeneration)
                }
                return
            }
            if request.method.hasPrefix("input.") || request.method == "device.orientation.set"
                || request.method.hasPrefix("probe.")
            {
                inputQueue.async { [weak self] in
                    guard let self else { return }
                    do {
                        try self.handle(request, connection: connection)
                    } catch {
                        self.sendError(error, requestID: request.id, to: connection)
                    }
                }
            } else {
                try handle(request, connection: connection)
            }
        } catch {
            let id = (try? Request(data: frame.payload).id) ?? "unknown"
            sendError(error, requestID: id, to: connection)
        }
    }

    func disconnect(_ connection: ClientConnection) {
        let wasAuthenticated = connection.authenticated
        connections.remove(connection)
        connection.close()
        if wasAuthenticated, !connections.contains(where: \.authenticated) {
            lastDisconnect = Date()
            if idleTimeout <= 0 { shutdown(exitCode: 0) }
            stopCapture()
        } else if wasAuthenticated {
            if let device = selectedDevice { try? reconcileCaptureDemand(for: device) }
            if connection.codec == "mjpeg",
                !connections.contains(where: {
                    $0.authenticated && $0.previewEnabled && $0.codec == "mjpeg"
                }), androidAgent != nil
            {
                androidCapture?.stop()
            }
        }
    }

    func connectionWriteFailed(_ connection: ClientConnection) {
        queue.async { [weak self] in self?.disconnect(connection) }
    }

    func sendError(_ error: Error, requestID: String, to connection: ClientConnection) {
        let value: SimViewError
        if let simView = error as? SimViewError {
            value = simView
        } else {
            value = SimViewError("INTERNAL_ERROR", error.localizedDescription)
        }
        sendJSON(["id": requestID, "error": value.dictionary], to: connection)
    }

    private func handle(_ request: Request, connection: ClientConnection) throws {
        let isInput = request.method.hasPrefix("input.") || request.method == "device.orientation.set"
        if isInput {
            metrics.didDispatchInput()
        }
        defer { if isInput { metrics.didAcknowledgeInput() } }
        switch request.method {
        case "devices.list":
            sendResult(try DeviceRuntime.devices().map(\.dictionary), requestID: request.id, to: connection)
        case "device.describe":
            let device = try selectDevice(request.deviceIdentifier)
            var value = deviceResponseDictionary(device)
            let captureWidth = device.platform == .ios ? capture.width : androidCapture?.width ?? 0
            let captureHeight = device.platform == .ios ? capture.height : androidCapture?.height ?? 0
            if captureWidth > 0 {
                value["pixelWidth"] = captureWidth
                value["pixelHeight"] = captureHeight
            }
            sendResult(value, requestID: request.id, to: connection)
        case "capture.start":
            let device = try selectDevice(request.deviceIdentifier)
            let requestedMode = request.params["observationMode"]?.stringValue ?? "hybrid"
            connection.setObservationMode(requestedMode)
            try reconcileCaptureDemand(for: device)
            sendResult(
                [
                    "device": deviceResponseDictionary(device),
                    "codec": connection.codec,
                    "frameRate": device.platform == .android && androidAgent == nil ? 4 : 60,
                    "observationMode": requestedMode,
                ], requestID: request.id, to: connection)
        case "capture.preview":
            let enabled = request.params["enabled"] == .bool(true)
            connection.setPreviewEnabled(enabled)
            if let device = selectedDevice { try reconcileCaptureDemand(for: device) }
            if enabled {
                if connection.codec == "h264" {
                    bootstrapH264Preview(for: connection)
                }
            }
            sendResult(["enabled": enabled], requestID: request.id, to: connection)
        case "capture.stop":
            stopCapture()
            sendResult(["stopped": true], requestID: request.id, to: connection)
        case "capture.keyframe":
            guard captureActive else {
                throw SimViewError("CAPTURE_NOT_STARTED", "Start capture before requesting a keyframe")
            }
            if let androidAgent {
                try androidAgent.requestKeyframe()
            } else {
                Task { await h264.forceKeyframe() }
            }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "capture.screenshot":
            if selectedDevice?.platform == .android, let androidCapture {
                metrics.didUseADBFallback()
                let png = try androidCapture.screenshot()
                sendResult(
                    [
                        "frameId": frameID,
                        "width": androidCapture.width,
                        "height": androidCapture.height,
                        "byteLength": png.count,
                    ], requestID: request.id, to: connection)
                connection.send(WireFrame(kind: .pngScreenshot, payload: png))
            } else {
                guard let frame = capture.latestFrame else {
                    throw SimViewError("CAPTURE_NOT_STARTED", "Start capture before requesting a screenshot")
                }
                let png = try ImageEncoder.encode(frame, type: "public.png")
                sendResult(
                    [
                        "frameId": frameID,
                        "width": CVPixelBufferGetWidth(frame),
                        "height": CVPixelBufferGetHeight(frame),
                        "byteLength": png.count,
                    ], requestID: request.id, to: connection)
                connection.send(WireFrame(kind: .pngScreenshot, payload: png))
            }
        case "observation.get":
            if !captureActive, let device = selectedDevice { try startCapture(device) }
            let visual = request.params["visual"] == .bool(true)
            let afterRevision: UInt64?
            if let revision = request.params["afterRevision"]?.intValue {
                guard revision >= 0 else {
                    throw SimViewError(
                        "OBSERVATION_REVISION_INVALID", "Observation revision must be nonnegative")
                }
                afterRevision = UInt64(revision)
            } else {
                afterRevision = nil
            }
            let quietMilliseconds = request.params["settleQuietMs"]?.intValue ?? 75
            let maximumWaitMilliseconds = request.params["maxWaitMs"]?.intValue ?? 500
            observationQueue.async { [weak self] in
                guard let self else { return }
                do {
                    let prepared = try self.observation.observe(
                        visual: visual,
                        afterRevision: afterRevision,
                        quietMilliseconds: quietMilliseconds,
                        maximumWaitMilliseconds: maximumWaitMilliseconds
                    )
                    self.sendObservationResult(
                        prepared, requestID: request.id, to: connection)
                } catch {
                    self.sendError(error, requestID: request.id, to: connection)
                }
            }
        case "input.touch":
            if selectedDevice?.platform == .android {
                guard let androidAgent, let dimensions = androidInputDimensions()
                else {
                    throw SimViewError(
                        "INPUT_RAW_TOUCH_UNAVAILABLE",
                        "Continuous touch requires the SimView Android agent"
                    )
                }
                try androidAgent.touch(
                    phase: request.params.string("phase"),
                    x: request.params.double("x"),
                    y: request.params.double("y"),
                    width: dimensions.width,
                    height: dimensions.height
                )
                sendResult(["accepted": true], requestID: request.id, to: connection)
                return
            }
            try prepareHID()
            try hid.touch(
                phase: request.params.string("phase"),
                x: request.params.double("x"),
                y: request.params.double("y")
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.tap":
            try performTap(params: request.params, defaultDuration: 0.05)
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.longPress":
            try performTap(params: request.params, defaultDuration: 0.6)
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.swipe":
            let from = try request.params.dictionary("from")
            let to = try request.params.dictionary("to")
            if let androidAgent, let dimensions = androidInputDimensions() {
                try androidAgent.swipe(
                    fromX: try from.double("x"), fromY: try from.double("y"),
                    toX: try to.double("x"), toY: try to.double("y"),
                    duration: request.params.double("durationMs") / 1_000,
                    width: dimensions.width, height: dimensions.height
                )
            } else if let controller = try androidInputIfSelected() {
                try controller.swipe(
                    fromX: try from.double("x"), fromY: try from.double("y"),
                    toX: try to.double("x"), toY: try to.double("y"),
                    duration: request.params.double("durationMs") / 1_000
                )
            } else {
                try prepareHID()
                try hid.swipe(
                    fromX: try from.double("x"),
                    fromY: try from.double("y"),
                    toX: try to.double("x"),
                    toY: try to.double("y"),
                    duration: max(0.05, request.params.double("durationMs") / 1_000)
                )
            }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.gesture":
            let tracks = request.params["tracks"]?.arrayValue ?? []
            let parsed = try tracks.map {
                value -> (
                    pointerID: Int, waypoints: [(x: Double, y: Double, timestamp: Double)]
                ) in
                guard let track = value.objectValue,
                    let waypoints = track["waypoints"]?.arrayValue
                else { throw SimViewError("INPUT_GESTURE_INVALID", "Gesture track is invalid") }
                return (
                    try track.int("pointerId"),
                    try parseGestureWaypoints(waypoints)
                )
            }
            if parsed.count == 2, let androidAgent, let dimensions = androidInputDimensions() {
                try androidAgent.gesture(
                    tracks: parsed,
                    width: dimensions.width,
                    height: dimensions.height
                )
            } else if parsed.count == 2, selectedDevice?.platform == .ios,
                HIDInjector.multiTouchAvailable
            {
                try performIOSMultiGesture(parsed)
            } else if parsed.count == 1, let waypoints = parsed.first?.waypoints {
                try performGesture(waypoints)
            } else {
                throw SimViewError(
                    "INPUT_MULTITOUCH_UNAVAILABLE",
                    "The active runtime does not expose a compatible two-touch digitizer path"
                )
            }
            sendResult(
                [
                    "accepted": true,
                    "pointerCount": parsed.count,
                    "sampleCount": parsed.reduce(0) { $0 + $1.waypoints.count },
                ],
                requestID: request.id,
                to: connection
            )
        case "input.typeText":
            let method: String
            if let androidAgent {
                method = try androidAgent.typeText(request.params.string("text"))
            } else if let controller = try androidInputIfSelected() {
                method = try controller.typeText(request.params.string("text"))
            } else {
                try prepareHID()
                method = try hid.typeText(request.params.string("text"))
            }
            sendResult(["accepted": true, "inputMethod": method], requestID: request.id, to: connection)
        case "input.key":
            if selectedDevice?.platform == .android {
                throw SimViewError("INPUT_KEY_UNSUPPORTED", "Named keyboard input is unavailable on Android")
            }
            try prepareHID()
            try hid.pressKey(
                request.params.string("key"),
                modifiers: request.params["modifiers"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                repeatCount: request.params["repeat"]?.intValue ?? 1
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.button":
            if let androidAgent {
                try androidAgent.pressButton(request.params.string("button"))
            } else if let controller = try androidInputIfSelected() {
                try controller.pressButton(request.params.string("button"))
            } else {
                try prepareHID()
                try hid.pressButton(request.params.string("button"))
            }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "device.orientation.set":
            if let controller = try androidInputIfSelected() {
                let orientation = try request.params.string("orientation")
                try controller.setOrientation(orientation)
                if let device = selectedDevice, let width = device.pixelWidth, let height = device.pixelHeight {
                    let landscape =
                        orientation == "landscape-left" || orientation == "landscape-right"
                        || orientation == "landscapeLeft" || orientation == "landscapeRight"
                    androidInputWidth = landscape ? max(width, height) : min(width, height)
                    androidInputHeight = landscape ? min(width, height) : max(width, height)
                    controller.updateDisplayDimensions(
                        width: androidInputWidth,
                        height: androidInputHeight
                    )
                    if let androidAgent {
                        latestH264Configuration = nil
                        try androidAgent.startCapture(width: androidInputWidth, height: androidInputHeight)
                        try androidAgent.requestKeyframe()
                    } else {
                        Task { await h264.forceKeyframe() }
                    }
                }
            } else {
                try prepareHID()
                try hid.setOrientation(request.params.string("orientation"))
                Task { await h264.forceKeyframe() }
            }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "accessibility.snapshot":
            let device = try selectDevice(request.deviceIdentifier)
            let result = try accessibilitySnapshot(device, params: request.params)
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.observe":
            let device = try selectDevice(request.deviceIdentifier)
            let result = try accessibilityObserve(device, params: request.params)
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.elementAtPoint":
            let device = try selectDevice(request.deviceIdentifier)
            let result = try accessibilityElementAtPoint(device, params: request.params)
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.find":
            let selector = try request.params.dictionary("selector")
            let device = try selectDevice(request.deviceIdentifier)
            let result: [String: Any]
            if device.platform == .android {
                result = try requireAndroidAccessibility().find(
                    selector: selector.foundationDictionary,
                    scope: request.params["scope"]?.stringValue ?? "visible"
                )
            } else {
                result = try accessibility.find(
                    udid: device.nativeIdentifier,
                    selector: selector.foundationDictionary,
                    scope: request.params["scope"]?.stringValue ?? "visible"
                )
            }
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.wait":
            let device = try selectDevice(request.deviceIdentifier)
            let selector = try request.params.dictionary("selector").foundationDictionary
            let state = request.params["state"]?.stringValue ?? "visible"
            let timeout = request.params["timeoutMs"]?.intValue ?? 5_000
            let result =
                device.platform == .android
                ? try requireAndroidAccessibility().wait(selector: selector, state: state, timeoutMs: timeout)
                : try accessibility.wait(
                    udid: device.nativeIdentifier, selector: selector, state: state, timeoutMs: timeout)
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.providerStatus":
            let device = try requireIOSDevice(request.deviceIdentifier)
            sendResult(
                accessibility.providerStatus(udid: device.nativeIdentifier),
                requestID: request.id,
                to: connection
            )
        case "accessibility.enableXCTestProvider":
            let device = try requireIOSDevice(request.deviceIdentifier)
            let detectedTarget = probe.target(udid: device.nativeIdentifier)["bundleId"] as? String
            guard let bundleID = request.params["bundleId"]?.stringValue ?? detectedTarget else {
                throw SimViewError(
                    "ACCESSIBILITY_TARGET_UNAVAILABLE",
                    "No foreground third-party application could be selected for XCTest accessibility"
                )
            }
            sendResult(
                try accessibility.enableXCTestProvider(
                    udid: device.nativeIdentifier,
                    bundleID: bundleID
                ),
                requestID: request.id,
                to: connection
            )
        case "accessibility.disableXCTestProvider":
            let device = try requireIOSDevice(request.deviceIdentifier)
            sendResult(
                accessibility.disableXCTestProvider(udid: device.nativeIdentifier),
                requestID: request.id,
                to: connection
            )
        case "device.context":
            let device = try selectDevice(request.deviceIdentifier)
            guard device.platform == .android else {
                throw SimViewError("METHOD_UNSUPPORTED", "device.context is currently Android-only")
            }
            sendResult(try requireAndroidAccessibility().context(), requestID: request.id, to: connection)
        case "probe.status":
            sendResult(probe.status(), requestID: request.id, to: connection)
        case "probe.target":
            let device = try requireIOSDevice(request.deviceIdentifier)
            sendResult(probe.target(udid: device.nativeIdentifier), requestID: request.id, to: connection)
        case "probe.enable":
            let device = try requireIOSDevice(request.deviceIdentifier)
            let result = try probe.enable(
                udid: device.nativeIdentifier,
                bundleID: request.params.string("bundleId")
            )
            sendResult(result, requestID: request.id, to: connection)
        case "probe.disable":
            let device = try requireIOSDevice(request.deviceIdentifier)
            sendResult(try probe.disable(udid: device.nativeIdentifier), requestID: request.id, to: connection)
        case "probe.context":
            _ = try requireIOSDevice(request.deviceIdentifier)
            sendResult(try probe.request("context"), requestID: request.id, to: connection)
        case "probe.inspectPoint":
            _ = try requireIOSDevice(request.deviceIdentifier)
            sendResult(
                try probe.request(
                    "inspectPoint",
                    params: [
                        "x": request.params.double("x"),
                        "y": request.params.double("y"),
                    ]), requestID: request.id, to: connection)
        case "probe.findViews":
            _ = try requireIOSDevice(request.deviceIdentifier)
            sendResult(
                try probe.request("findViews", params: request.params.foundationDictionary),
                requestID: request.id,
                to: connection
            )
        case "probe.fullHierarchy":
            _ = try requireIOSDevice(request.deviceIdentifier)
            sendResult(
                try probe.request("fullHierarchy", params: request.params.foundationDictionary),
                requestID: request.id,
                to: connection
            )
        case "health.get":
            let authenticated = connections.filter(\.authenticated)
            let idleDeadline: Any =
                authenticated.isEmpty
                ? ISO8601DateFormatter().string(from: lastDisconnect.addingTimeInterval(idleTimeout))
                : NSNull()
            let configuredUdid: Any
            if let preferredDeviceID, preferredDeviceID.hasPrefix("ios:") {
                configuredUdid = String(preferredDeviceID.dropFirst(4))
            } else if let preferredDeviceID, !preferredDeviceID.contains(":") {
                configuredUdid = preferredDeviceID
            } else {
                configuredUdid = NSNull()
            }
            let health: [String: Any] = [
                "status": "ok",
                "pid": Int(getpid()),
                "instanceId": instanceID as Any? ?? NSNull(),
                "configuredDeviceId": preferredDeviceID as Any? ?? NSNull(),
                "configuredUdid": configuredUdid,
                "device": selectedDevice.map { self.deviceResponseDictionary($0) as Any } ?? NSNull(),
                "captureActive": captureActive,
                "captureState": captureActive ? "active" : "idle",
                "idleDeadline": idleDeadline,
                "capabilities": [
                    "capture": true,
                    "input": true,
                    "accessibility": selectedDevice?.platform == .android ? true : accessibility.available,
                    "probe": selectedDevice?.platform == .android ? false : probe.status(),
                    "androidContext": selectedDevice?.platform == .android,
                    "androidAgent": androidAgent != nil,
                    "androidAgentError": androidAgentError as Any? ?? NSNull(),
                ],
                "clients": authenticated.count,
                "clientsByCodec": [
                    "h264": authenticated.filter { $0.codec == "h264" }.count,
                    "mjpeg": authenticated.filter { $0.codec == "mjpeg" }.count,
                ],
                "metrics": metrics.dictionary,
            ]
            sendResult(health, requestID: request.id, to: connection)
        case "server.shutdown":
            sendResult(["shuttingDown": true], requestID: request.id, to: connection)
            queue.asyncAfter(deadline: .now() + .milliseconds(20)) { self.shutdown(exitCode: 0) }
        default:
            throw SimViewError("METHOD_NOT_FOUND", "Unknown method: \(request.method)")
        }
    }

    private func bootstrapH264Preview(for connection: ClientConnection) {
        if let latestH264Configuration {
            connection.send(WireFrame(kind: .h264Configuration, payload: latestH264Configuration))
        }
        if let androidAgent {
            try? androidAgent.requestKeyframe()
        } else {
            Task { await h264.forceKeyframe() }
        }
    }

    private func sendObservationResult(
        _ prepared: PreparedObservation,
        requestID: String,
        to connection: ClientConnection
    ) {
        let formatter = ISO8601DateFormatter()
        let image = prepared.image
        var result: [String: Any] = [
            "observationId": prepared.observationID,
            "frameId": prepared.frameID,
            "frameRevision": prepared.frameRevision,
            "changeRevision": prepared.changeRevision,
            "imageRevision": prepared.imageRevision,
            "capturedAt": formatter.string(from: prepared.capturedAt),
            "settledAt": formatter.string(from: prepared.settledAt),
            "stable": prepared.stable,
            "ageMs": max(0, prepared.settledAt.timeIntervalSince(prepared.capturedAt) * 1_000),
            "width": prepared.width,
            "height": prepared.height,
            "byteLength": image?.count ?? 0,
            "imageIncluded": image != nil,
            "cacheHit": prepared.cacheHit,
        ]
        if let date = prepared.firstChangedFrameAt {
            result["firstChangedFrameAt"] = formatter.string(from: date)
        }
        if let date = prepared.imageReadyAt {
            result["imageReadyAt"] = formatter.string(from: date)
        }
        sendResult(result, requestID: requestID, to: connection)
        if let image { connection.send(WireFrame(kind: .preparedImage, payload: image)) }
        metrics.didReturnObservation()
    }

    private func startCapture(_ device: DeviceDescription) throws {
        if captureActive, captureDeviceID == device.id { return }
        capture.stop()
        androidCapture?.stop()
        androidAgent?.stop()
        androidH264.stop()
        androidController?.stop()
        androidCapture = nil
        androidController = nil
        androidAccessibility = nil
        androidClient = nil
        androidAgent = nil
        androidAgentError = nil
        androidAgentRestartAttempts = 0
        androidDecoderFailurePolicy.reset()
        androidAgentFrameSequence = 0
        latestH264Configuration = nil
        selectedDevice = device
        accessibilityObservation.reset()
        captureDeviceID = device.id
        androidInputWidth = device.pixelWidth ?? 0
        androidInputHeight = device.pixelHeight ?? 0
        captureGeneration &+= 1
        let generation = captureGeneration
        let handler: @Sendable (CVPixelBuffer, CMTime, String) -> Void = { [weak self] frame, timestamp, frameID in
            guard let self else { return }
            self.observation.ingest(frame, frameID: frameID)
            let pending = PendingH264Frame(
                frame: frame,
                timestamp: timestamp,
                frameID: frameID,
                capturedAt: DispatchTime.now(),
                generation: generation
            )
            self.queue.async {
                self.acceptCapturedFrame(pending)
            }
        }
        captureActive = true
        do {
            if device.platform == .ios {
                startIOSAccessibilityObservation(for: device)
                try capture.start(udid: device.nativeIdentifier, callback: handler)
            } else {
                let client = try ADBClient()
                let androidCapture = AndroidFrameCapture(client: client, serial: device.nativeIdentifier)
                self.androidClient = client
                self.androidCapture = androidCapture
                androidController = AndroidController(client: client, device: device)
                let accelerated = tryStartAndroidAgent(client: client, device: device, generation: generation)
                androidAccessibility = AndroidAccessibilityService(
                    client: client,
                    serial: device.nativeIdentifier,
                    agent: accelerated ? androidAgent : nil,
                    observation: accessibilityObservation
                )
                if accelerated {
                    if connections.contains(where: {
                        $0.authenticated && $0.previewEnabled && $0.codec == "mjpeg"
                    }) {
                        ensureAndroidMJPEGCapture(generation: generation)
                    }
                } else {
                    androidCapture.start(handler: handler)
                }
            }
        } catch {
            stopCapture()
            throw error
        }
    }

    private func reconcileCaptureDemand(for device: DeviceDescription) throws {
        observationMode =
            connections.contains(where: { $0.authenticated && $0.observationMode == "hybrid" })
            ? "hybrid" : "semantic"
        observation.setImagePreparationPolicy(
            observationMode == "semantic" ? .onDemand : .eagerOnChange
        )
        let previewRequired = connections.contains(where: {
            $0.authenticated && $0.previewEnabled
        })
        if observationMode == "hybrid" || device.platform == .android || previewRequired {
            try startCapture(device)
            return
        }
        if captureActive { stopCapture() }
        selectedDevice = device
        accessibilityObservation.reset()
        startIOSAccessibilityObservation(for: device)
    }

    private func stopCapture() {
        accessibility.stopObservation(udid: selectedDevice?.nativeIdentifier)
        captureGeneration &+= 1
        capture.stop()
        androidCapture?.stop()
        androidAgent?.stop()
        androidH264.stop()
        androidController?.stop()
        androidCapture = nil
        androidController = nil
        androidAccessibility = nil
        androidClient = nil
        androidAgent = nil
        androidAgentRestartAttempts = 0
        androidDecoderFailurePolicy.reset()
        androidAgentFrameSequence = 0
        androidInputWidth = 0
        androidInputHeight = 0
        latestH264Configuration = nil
        captureActive = false
        captureDeviceID = nil
        frameID = "0"
        pendingH264Frame = nil
        pendingMJPEGFrame = nil
        observation.clear()
        accessibilityObservation.reset()
        Task { await h264.stop() }
    }

    private func acceptCapturedFrame(_ pending: PendingH264Frame) {
        guard captureActive, pending.generation == captureGeneration else { return }
        metrics.didCapture()
        frameID = pending.frameID
        if connections.contains(where: { $0.authenticated && $0.previewEnabled && $0.codec == "mjpeg" }) {
            enqueueMJPEG(pending)
        }

        guard connections.contains(where: { $0.authenticated && $0.previewEnabled && $0.codec == "h264" })
        else { return }

        if encodingFrame {
            if pendingH264Frame != nil { metrics.didDrop() }
            pendingH264Frame = pending
            return
        }
        encode(pending)
    }

    private func enqueueMJPEG(_ pending: PendingH264Frame) {
        if encodingMJPEGFrame {
            if pendingMJPEGFrame != nil { metrics.didDrop() }
            pendingMJPEGFrame = pending
            return
        }
        encodingMJPEGFrame = true
        mjpegQueue.async { [weak self] in
            guard let self else { return }
            let jpeg = try? ImageEncoder.encode(pending.frame, type: "public.jpeg")
            self.queue.async { [weak self] in
                guard let self else { return }
                if let jpeg, self.captureActive, pending.generation == self.captureGeneration {
                    self.broadcast(WireFrame(kind: .jpegFrame, payload: jpeg), codec: "mjpeg")
                } else if jpeg == nil {
                    self.metrics.didDrop()
                }
                self.encodingMJPEGFrame = false
                if let next = self.pendingMJPEGFrame {
                    self.pendingMJPEGFrame = nil
                    self.enqueueMJPEG(next)
                }
            }
        }
    }

    private func encode(_ pending: PendingH264Frame) {
        encodingFrame = true
        Task {
            do {
                let encoded = try await h264.encode(pending.frame)
                queue.async {
                    guard self.captureActive, pending.generation == self.captureGeneration else {
                        self.finishEncoding()
                        return
                    }
                    let elapsed =
                        Double(
                            DispatchTime.now().uptimeNanoseconds - pending.capturedAt.uptimeNanoseconds
                        ) / 1_000_000
                    self.metrics.didEncode(latencyMS: elapsed)
                    if let configuration = encoded.configuration {
                        self.latestH264Configuration = configuration
                        self.broadcast(
                            WireFrame(kind: .h264Configuration, payload: configuration),
                            codec: "h264"
                        )
                    }
                    var payload = Data()
                    var micros = UInt64(
                        CMTimeGetSeconds(pending.timestamp) * 1_000_000
                    ).bigEndian
                    withUnsafeBytes(of: &micros) { payload.append(contentsOf: $0) }
                    payload.append(encoded.keyframe ? 1 : 0)
                    payload.append(encoded.bytes)
                    self.broadcast(WireFrame(kind: .h264Frame, payload: payload), codec: "h264")
                    self.finishEncoding()
                }
            } catch {
                queue.async {
                    self.metrics.didDrop()
                    self.finishEncoding()
                }
            }
        }
    }

    private func finishEncoding() {
        encodingFrame = false
        guard let pending = pendingH264Frame else { return }
        pendingH264Frame = nil
        encode(pending)
    }

    private func tryStartAndroidAgent(
        client: ADBClient, device: DeviceDescription, generation: UInt64
    ) -> Bool {
        guard let agentURL = AndroidAgentLifecycle.packagedAgentURL(),
            let width = device.pixelWidth, let height = device.pixelHeight
        else {
            androidAgentError = "Packaged Android agent or display dimensions are unavailable"
            return false
        }
        let lifecycle = AndroidAgentLifecycle(client: client, serial: device.nativeIdentifier)
        let token = UUID().uuidString + UUID().uuidString
        do {
            try lifecycle.prepare(agentURL: agentURL)
            let port = try lifecycle.start(token: token)
            let connection = AndroidAgentConnection(
                lifecycle: lifecycle,
                token: token,
                onConfiguration: { [weak self] configuration in
                    guard let server = self else { return }
                    server.queue.async {
                        guard server.captureActive, generation == server.captureGeneration else { return }
                        do {
                            try server.androidH264.configure(
                                configuration,
                                handler: { [weak server] frame, timestamp in
                                    guard let server else { return }
                                    server.observation.ingest(
                                        frame,
                                        frameID: "android-agent-\(timestamp.value)"
                                    )
                                    server.queue.async {
                                        server.androidDecoderFailurePolicy.recordSuccess()
                                    }
                                },
                                failureHandler: { [weak server] error in
                                    guard let server else { return }
                                    server.queue.async {
                                        server.handleAndroidDecoderFailure(
                                            error, generation: generation)
                                    }
                                },
                                recoveryHandler: { [weak server] in
                                    guard let server else { return }
                                    server.queue.async {
                                        guard server.captureActive,
                                            generation == server.captureGeneration
                                        else { return }
                                        do {
                                            try server.androidAgent?.requestKeyframe()
                                        } catch {
                                            server.handleAndroidDecoderFailure(
                                                error, generation: generation)
                                        }
                                    }
                                }
                            )
                        } catch {
                            server.metrics.didFailAndroidDecoder()
                            server.handleAndroidAgentFailure(error, generation: generation)
                            return
                        }
                        server.latestH264Configuration = configuration
                        server.broadcast(
                            WireFrame(kind: .h264Configuration, payload: configuration), codec: "h264")
                    }
                },
                onFrame: { [weak self] timestamp, keyframe, bytes in
                    guard let server = self else { return }
                    server.queue.async {
                        guard server.captureActive, generation == server.captureGeneration else { return }
                        server.androidAgentFrameSequence &+= 1
                        server.frameID = "android-agent-\(server.androidAgentFrameSequence)"
                        server.metrics.didCapture()
                        server.androidH264.decode(
                            bytes, timestampMicros: timestamp, keyframe: keyframe)
                        var payload = Data()
                        var micros = timestamp.bigEndian
                        withUnsafeBytes(of: &micros) { payload.append(contentsOf: $0) }
                        payload.append(keyframe ? 1 : 0)
                        payload.append(bytes)
                        server.broadcast(WireFrame(kind: .h264Frame, payload: payload), codec: "h264")
                    }
                },
                onAccessibilityEvent: { [weak self] _ in
                    self?.accessibilityObservation.markEvent()
                },
                onFailure: { [weak self] error in
                    guard let server = self else { return }
                    server.queue.async { server.handleAndroidAgentFailure(error, generation: generation) }
                }
            )
            try connection.connect(port: port)
            try connection.startCapture(width: width, height: height)
            androidAgent = connection
            androidAgentError = nil
            return true
        } catch {
            lifecycle.stop()
            androidAgentError =
                lifecycle.lastDiagnostics
                ?? (error as? SimViewError)?.message ?? error.localizedDescription
            return false
        }
    }

    private func acceptAndroidCompatibilityFrame(_ pending: PendingH264Frame) {
        guard captureActive, pending.generation == captureGeneration else { return }
        frameID = pending.frameID
        if connections.contains(where: {
            $0.authenticated && $0.previewEnabled && $0.codec == "mjpeg"
        }) {
            enqueueMJPEG(pending)
        }
    }

    private func ensureAndroidMJPEGCapture(generation: UInt64) {
        guard let androidCapture else { return }
        metrics.didUseADBFallback()
        androidCapture.start { [weak self] frame, timestamp, frameID in
            guard let self else { return }
            let pending = PendingH264Frame(
                frame: frame,
                timestamp: timestamp,
                frameID: frameID,
                capturedAt: DispatchTime.now(),
                generation: generation
            )
            self.queue.async { self.acceptAndroidCompatibilityFrame(pending) }
        }
    }

    private func handleAndroidAgentFailure(_ error: Error, generation: UInt64) {
        guard captureActive, generation == captureGeneration, selectedDevice?.platform == .android else { return }
        let failedAgent = androidAgent
        failedAgent?.stop()
        androidH264.stop()
        androidAgentError =
            failedAgent?.diagnostics
            ?? (error as? SimViewError)?.message ?? error.localizedDescription
        androidAgent = nil
        latestH264Configuration = nil
        if androidAgentRestartAttempts < 1, let client = androidClient, let device = selectedDevice {
            androidAgentRestartAttempts += 1
            if tryStartAndroidAgent(client: client, device: device, generation: generation) {
                androidDecoderFailurePolicy.reset()
                androidAccessibility = AndroidAccessibilityService(
                    client: client,
                    serial: device.nativeIdentifier,
                    agent: androidAgent,
                    observation: accessibilityObservation
                )
                if connections.contains(where: {
                    $0.authenticated && $0.previewEnabled && $0.codec == "mjpeg"
                }) {
                    ensureAndroidMJPEGCapture(generation: generation)
                }
                return
            }
        }
        guard let androidCapture else { return }
        androidCapture.start { [weak self] frame, timestamp, frameID in
            guard let self else { return }
            let pending = PendingH264Frame(
                frame: frame,
                timestamp: timestamp,
                frameID: frameID,
                capturedAt: DispatchTime.now(),
                generation: generation
            )
            self.queue.async { self.acceptCapturedFrame(pending) }
        }
    }

    private func handleAndroidDecoderFailure(_ error: Error, generation: UInt64) {
        guard captureActive, generation == captureGeneration,
            selectedDevice?.platform == .android
        else { return }
        guard androidDecoderFailurePolicy.recordFailure() else { return }
        handleAndroidAgentFailure(error, generation: generation)
    }

    private func prepareHID() throws {
        let device = try selectDevice(nil)
        guard device.platform == .ios else {
            throw SimViewError("INPUT_UNAVAILABLE", "The selected Android device does not use iOS HID")
        }
        try hid.setup(udid: device.nativeIdentifier)
    }

    private func performTap(
        params: [String: JSONValue], defaultDuration: TimeInterval
    ) throws {
        let x = try params.double("x")
        let y = try params.double("y")
        let duration = params.optionalDouble("durationMs").map { $0 / 1_000 } ?? defaultDuration
        if let androidAgent, let dimensions = androidInputDimensions() {
            try androidAgent.tap(
                x: x,
                y: y,
                duration: duration,
                width: dimensions.width,
                height: dimensions.height
            )
        } else if let controller = try androidInputIfSelected() {
            try controller.tap(x: x, y: y, duration: duration)
        } else {
            try prepareHID()
            try hid.tap(x: x, y: y, duration: duration)
        }
    }

    private func performGesture(
        _ waypoints: [(x: Double, y: Double, timestamp: Double)]
    ) throws {
        guard waypoints.count >= 2, waypoints.count <= 120 else {
            throw SimViewError("INPUT_GESTURE_INVALID", "A gesture requires 2 through 120 waypoints")
        }
        guard let first = waypoints.first, let last = waypoints.last,
            first.timestamp >= 0, last.timestamp <= 5
        else {
            throw SimViewError("INPUT_GESTURE_INVALID", "Gesture duration must not exceed five seconds")
        }
        var previousTimestamp = first.timestamp
        func send(_ phase: String, _ point: (x: Double, y: Double, timestamp: Double)) throws {
            if let androidAgent, let dimensions = androidInputDimensions() {
                try androidAgent.touch(
                    phase: phase,
                    x: point.x,
                    y: point.y,
                    width: dimensions.width,
                    height: dimensions.height
                )
            } else if selectedDevice?.platform == .android {
                throw SimViewError(
                    "INPUT_RAW_TOUCH_UNAVAILABLE",
                    "Timestamped gestures require the SimView Android agent"
                )
            } else {
                try prepareHID()
                try hid.touch(phase: phase, x: point.x, y: point.y)
            }
        }
        try send("down", first)
        for point in waypoints.dropFirst().dropLast() {
            guard point.timestamp >= previousTimestamp else {
                throw SimViewError("INPUT_GESTURE_INVALID", "Gesture timestamps must be monotonic")
            }
            Thread.sleep(forTimeInterval: point.timestamp - previousTimestamp)
            try send("move", point)
            previousTimestamp = point.timestamp
        }
        Thread.sleep(forTimeInterval: max(0, last.timestamp - previousTimestamp))
        try send("up", last)
    }

    private func parseGestureWaypoints(
        _ values: [JSONValue]
    ) throws -> [(x: Double, y: Double, timestamp: Double)] {
        let waypoints: [(x: Double, y: Double, timestamp: Double)] = try values.map { value in
            guard let point = value.objectValue else {
                throw SimViewError("INPUT_GESTURE_INVALID", "Each gesture waypoint must be an object")
            }
            return (
                try point.double("x"),
                try point.double("y"),
                try point.double("timestampMs") / 1_000
            )
        }
        guard waypoints.count >= 2, waypoints.count <= 120,
            let first = waypoints.first, let last = waypoints.last,
            first.timestamp >= 0, last.timestamp <= 5
        else {
            throw SimViewError(
                "INPUT_GESTURE_INVALID", "A gesture requires 2 through 120 monotonic waypoints")
        }
        for (previous, current) in zip(waypoints, waypoints.dropFirst())
        where current.timestamp < previous.timestamp {
            throw SimViewError("INPUT_GESTURE_INVALID", "Gesture timestamps must be monotonic")
        }
        return waypoints
    }

    private func performIOSMultiGesture(
        _ tracks: [(pointerID: Int, waypoints: [(x: Double, y: Double, timestamp: Double)])]
    ) throws {
        guard tracks.count == 2, let firstStart = tracks[0].waypoints.first,
            let secondStart = tracks[1].waypoints.first,
            let firstEnd = tracks[0].waypoints.last,
            let secondEnd = tracks[1].waypoints.last,
            firstStart.timestamp == secondStart.timestamp,
            firstEnd.timestamp == secondEnd.timestamp
        else {
            throw SimViewError(
                "INPUT_MULTITOUCH_INVALID",
                "iOS two-touch tracks must start and end at the same timestamps"
            )
        }
        try prepareHID()
        let timeline = Set(tracks.flatMap { $0.waypoints.map(\.timestamp) }).sorted()
        guard let start = timeline.first, let end = timeline.last, end - start <= 5 else {
            throw SimViewError("INPUT_GESTURE_INVALID", "Gesture duration must not exceed five seconds")
        }
        var previous = start
        for (index, timestamp) in timeline.enumerated() {
            if index > 0 { Thread.sleep(forTimeInterval: max(0, timestamp - previous)) }
            let first = interpolatedPoint(in: tracks[0].waypoints, at: timestamp)
            let second = interpolatedPoint(in: tracks[1].waypoints, at: timestamp)
            let phase = index == 0 ? "down" : (timestamp == end ? "up" : "move")
            try hid.multiTouch(phase: phase, first: first, second: second)
            previous = timestamp
        }
    }

    private func interpolatedPoint(
        in points: [(x: Double, y: Double, timestamp: Double)],
        at timestamp: Double
    ) -> (x: Double, y: Double) {
        guard let first = points.first else { return (0, 0) }
        if timestamp <= first.timestamp { return (first.x, first.y) }
        for (left, right) in zip(points, points.dropFirst()) where timestamp <= right.timestamp {
            let duration = right.timestamp - left.timestamp
            let progress = duration > 0 ? (timestamp - left.timestamp) / duration : 1
            return (
                left.x + (right.x - left.x) * progress,
                left.y + (right.y - left.y) * progress
            )
        }
        let last = points[points.count - 1]
        return (last.x, last.y)
    }

    private func selectDevice(_ requested: String?) throws -> DeviceDescription {
        let normalizedRequest = requested.map { $0.contains(":") ? $0 : "ios:\($0)" }
        let normalizedPreferred = preferredDeviceID.map { $0.contains(":") ? $0 : "ios:\($0)" }
        if let normalizedRequest, let normalizedPreferred, normalizedRequest != normalizedPreferred {
            throw SimViewError(
                "DEVICE_MISMATCH",
                "This backend is configured for \(normalizedPreferred), not \(normalizedRequest)"
            )
        }
        if let selectedDevice, normalizedRequest == nil || normalizedRequest == selectedDevice.id {
            return selectedDevice
        }
        let device = try DeviceRuntime.select(requested: requested, configured: preferredDeviceID)
        if let selectedDevice, selectedDevice.id != device.id {
            guard !captureActive else {
                throw SimViewError(
                    "DEVICE_MISMATCH",
                    "Stop capture before selecting a different device on this backend"
                )
            }
            androidController?.stop()
            androidCapture?.stop()
            androidAgent?.stop()
            androidH264.stop()
            androidCapture = nil
            androidController = nil
            androidAccessibility = nil
            androidClient = nil
            androidAgent = nil
            androidAgentError = nil
            androidAgentRestartAttempts = 0
            androidInputWidth = 0
            androidInputHeight = 0
            accessibility.stopObservation(udid: selectedDevice.nativeIdentifier)
            accessibilityObservation.reset()
        }
        selectedDevice = device
        return device
    }

    private func requireIOSDevice(_ requested: String?) throws -> DeviceDescription {
        let device = try selectDevice(requested)
        guard device.platform == .ios else {
            throw SimViewError("METHOD_UNSUPPORTED", "UIKit probe methods are unavailable on Android")
        }
        return device
    }

    private func startIOSAccessibilityObservation(for device: DeviceDescription) {
        accessibility.startObservation(udid: device.nativeIdentifier) { [weak self] in
            self?.accessibilityObservation.markEvent()
        }
    }

    private func androidInputIfSelected() throws -> AndroidController? {
        let device = try selectDevice(nil)
        guard device.platform == .android else { return nil }
        if let androidController { return androidController }
        let client = try ADBClient()
        androidClient = client
        let controller = AndroidController(client: client, device: device)
        androidController = controller
        return controller
    }

    private func androidInputDimensions() -> (width: Int, height: Int)? {
        guard androidInputWidth > 0, androidInputHeight > 0 else { return nil }
        return (androidInputWidth, androidInputHeight)
    }

    private func requireAndroidAccessibility() throws -> AndroidAccessibilityService {
        if let androidAccessibility { return androidAccessibility }
        let device = try selectDevice(nil)
        guard device.platform == .android else {
            throw SimViewError("METHOD_UNSUPPORTED", "Android accessibility requires an Android device")
        }
        let client: ADBClient
        if let androidClient {
            client = androidClient
        } else {
            client = try ADBClient()
        }
        androidClient = client
        let service = AndroidAccessibilityService(
            client: client,
            serial: device.nativeIdentifier,
            observation: accessibilityObservation
        )
        androidAccessibility = service
        return service
    }

    private func accessibilitySnapshot(
        _ device: DeviceDescription, params: [String: JSONValue]
    ) throws -> [String: Any] {
        if device.platform == .android {
            return try requireAndroidAccessibility().snapshot(
                scope: params["scope"]?.stringValue ?? "interactive",
                maxNodes: params["maxNodes"]?.intValue ?? 1_200
            )
        }
        return try accessibility.snapshot(
            udid: device.nativeIdentifier,
            scope: params["scope"]?.stringValue ?? "interactive",
            maxNodes: params["maxNodes"]?.intValue ?? 1_200
        )
    }

    private func accessibilityObserve(
        _ device: DeviceDescription, params: [String: JSONValue]
    ) throws -> [String: Any] {
        let scope = params["scope"]?.stringValue ?? "interactive"
        let maxNodes = params["maxNodes"]?.intValue ?? 1_200
        let quiet = params["settleQuietMs"]?.intValue ?? 75
        let maximumWait = params["maxWaitMs"]?.intValue ?? 500
        let afterRevision = params["afterRevision"]?.stringValue
        let requireChange = params["requireChange"] != .bool(false)
        if device.platform == .ios {
            startIOSAccessibilityObservation(for: device)
        }
        let strategy =
            device.platform == .android
            ? try requireAndroidAccessibility().observationStrategy
            : accessibility.observationStrategy
        let result = try accessibilityObservation.observe(
            afterRevision: afterRevision,
            scope: scope,
            maxNodes: maxNodes,
            settleQuietMilliseconds: quiet,
            maximumWaitMilliseconds: maximumWait,
            requireChange: requireChange,
            strategy: strategy
        ) { [weak self] scope, maxNodes in
            guard let self else {
                throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "SimView server is unavailable")
            }
            if device.platform == .android {
                return try self.requireAndroidAccessibility().snapshot(
                    scope: scope,
                    maxNodes: maxNodes
                )
            }
            return try self.accessibility.snapshot(
                udid: device.nativeIdentifier,
                scope: scope,
                maxNodes: maxNodes
            )
        }
        let formatter = ISO8601DateFormatter()
        var value: [String: Any] = [
            "snapshot": result.snapshot,
            "revision": result.revision,
            "eventChanged": result.eventChanged,
            "stable": result.stable,
            "timedOut": result.timedOut,
            "strategy": result.strategy,
            "settledAt": formatter.string(from: result.settledAt),
            "fallbackUsed": result.fallbackUsed,
            "captureCount": result.captureCount,
            "changeSource": result.changeSource,
        ]
        if let firstChangedAt = result.firstChangedAt {
            value["firstChangedAt"] = formatter.string(from: firstChangedAt)
        }
        return value
    }

    private func accessibilityElementAtPoint(
        _ device: DeviceDescription, params: [String: JSONValue]
    ) throws -> [String: Any] {
        if device.platform == .android {
            return try requireAndroidAccessibility().elementAtPoint(
                x: params.double("x"), y: params.double("y")
            )
        }
        return try accessibility.elementAtPoint(
            udid: device.nativeIdentifier,
            x: params.double("x"),
            y: params.double("y")
        )
    }

    private func deviceResponseDictionary(_ device: DeviceDescription) -> [String: Any] {
        var result = device.dictionary
        var metadata = result["metadata"] as? [String: Any] ?? [:]
        if device.platform == .android {
            let ownsActiveCapture = captureDeviceID == device.id
            let agentAvailable = ownsActiveCapture && androidAgent != nil
            metadata["captureTransport"] = agentAvailable ? "simview-agent" : "adb-screencap"
            metadata["inputTransport"] = agentAvailable ? "simview-agent" : "adb-shell"
            if ownsActiveCapture, let androidAgentError { metadata["agentError"] = androidAgentError }
            var capabilities = result["capabilities"] as? [String: Any] ?? [:]
            var input = capabilities["input"] as? [String: Any] ?? [:]
            input["rawTouch"] = agentAvailable
            input["multiTouch"] = agentAvailable
            capabilities["input"] = input
            result["capabilities"] = capabilities
        } else {
            var capabilities = result["capabilities"] as? [String: Any] ?? [:]
            var input = capabilities["input"] as? [String: Any] ?? [:]
            input["multiTouch"] = HIDInjector.multiTouchAvailable
            capabilities["input"] = input
            result["capabilities"] = capabilities
        }
        result["metadata"] = metadata
        return result
    }

    private func broadcast(_ frame: WireFrame, codec: String) {
        let data = frame.encoded
        for connection in connections
        where connection.authenticated && connection.previewEnabled && connection.codec == codec {
            connection.sendEncoded(data, kind: frame.kind)
            metrics.didDeliver()
            metrics.didCopyPreviewPacket()
        }
    }

    private func sendResult(_ result: Any, requestID: String, to connection: ClientConnection) {
        sendJSON(["id": requestID, "result": result], to: connection)
    }

    private func sendJSON(_ object: Any, to connection: ClientConnection) {
        guard let data = try? jsonData(object) else { return }
        connection.send(WireFrame(kind: .response, payload: data))
    }

    private func bind() throws {
        let parent = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: parent,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        chmod(parent.path, 0o700)
        unlink(socketPath)
        listenerFD = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenerFD >= 0 else {
            throw SimViewError("SOCKET_CREATE_FAILED", String(cString: strerror(errno)), recoverable: false)
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maximum = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < maximum else {
            throw SimViewError(
                "SOCKET_PATH_TOO_LONG", "Unix socket path exceeds \(maximum - 1) bytes", recoverable: false)
        }
        _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: maximum) { destination in
                socketPath.withCString { source in strncpy(destination, source, maximum - 1) }
            }
        }
        let status = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listenerFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard status == 0, Darwin.listen(listenerFD, 16) == 0 else {
            throw SimViewError("SOCKET_BIND_FAILED", String(cString: strerror(errno)), recoverable: false)
        }
        chmod(socketPath, 0o600)
    }

    private func acceptConnection() {
        let fd = Darwin.accept(listenerFD, nil, nil)
        guard fd >= 0 else { return }
        let connection = ClientConnection(fd: fd, server: self)
        connections.insert(connection)
        connection.start(on: queue)
    }

    private func installLifecycleTimer() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if let parentPID, parentPID > 1, kill(parentPID, 0) != 0 {
                self.shutdown(exitCode: 0)
            }
            let timeout = self.hasAuthenticatedClient ? self.idleTimeout : max(10, self.idleTimeout)
            if !self.connections.contains(where: \.authenticated),
                Date().timeIntervalSince(self.lastDisconnect) >= timeout
            {
                self.shutdown(exitCode: 0)
            }
        }
        timer.resume()
        self.timer = timer
    }

    private func installSignalHandlers() {
        for value in [SIGTERM, SIGINT] {
            Darwin.signal(value, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: value, queue: queue)
            source.setEventHandler { [weak self] in self?.shutdown(exitCode: 0) }
            source.resume()
            signalSources.append(source)
        }
    }

    private func shutdown(exitCode: Int32) -> Never {
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { exit(1) }
        probe.close()
        stopCapture()
        listener?.cancel()
        timer?.cancel()
        for source in signalSources { source.cancel() }
        signalSources.removeAll()
        for connection in connections { connection.close() }
        unlink(socketPath)
        let parent = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
        if parent.path.hasPrefix(FileManager.default.temporaryDirectory.path + "simview-") {
            try? FileManager.default.removeItem(at: parent)
        }
        exit(exitCode)
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) throws -> String {
        guard let value = self[key]?.stringValue else {
            throw SimViewError("PARAMETER_REQUIRED", "\(key) must be a string")
        }
        return value
    }

    func double(_ key: String) throws -> Double {
        guard let value = self[key]?.doubleValue else {
            throw SimViewError("PARAMETER_REQUIRED", "\(key) must be a number")
        }
        return value
    }

    func optionalDouble(_ key: String) -> Double? {
        self[key]?.doubleValue
    }

    func int(_ key: String) throws -> Int {
        guard let value = self[key]?.intValue else {
            throw SimViewError("PARAMETER_REQUIRED", "\(key) must be an integer")
        }
        return value
    }

    func dictionary(_ key: String) throws -> [String: JSONValue] {
        guard let value = self[key]?.objectValue else {
            throw SimViewError("PARAMETER_REQUIRED", "\(key) must be an object")
        }
        return value
    }

    var foundationDictionary: [String: Any] {
        mapValues(\.foundationObject)
    }
}

private func secureEquals(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8)
    let right = Array(rhs.utf8)
    var difference = UInt8(left.count ^ right.count)
    for index in 0..<max(left.count, right.count) {
        difference |= (index < left.count ? left[index] : 0) ^ (index < right.count ? right[index] : 0)
    }
    return difference == 0
}
