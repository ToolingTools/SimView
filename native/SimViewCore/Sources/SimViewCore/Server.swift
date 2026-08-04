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
    private let mjpegQueue = DispatchQueue(label: "dev.simview.server.mjpeg", qos: .userInitiated)
    private var listenerFD: Int32 = -1
    private var listener: DispatchSourceRead?
    private var timer: DispatchSourceTimer?
    private var signalSources: [DispatchSourceSignal] = []
    private var connections = Set<ClientConnection>()
    private var lastDisconnect = Date()
    private var selectedDevice: DeviceDescription?
    private let capture = FrameCapture()
    private let hid = HIDInjector()
    private let accessibility = AccessibilityService()
    private let probe = ProbeCoordinator()
    private let h264 = H264Encoder()
    private let metrics = Metrics()
    private var androidClient: ADBClient?
    private var androidCapture: AndroidFrameCapture?
    private var androidController: AndroidController?
    private var androidAccessibility: AndroidAccessibilityService?
    private var androidAgent: AndroidAgentConnection?
    private var androidAgentError: String?
    private var androidAgentRestartAttempts = 0
    private var androidAgentFrameSequence: UInt64 = 0
    private var androidInputWidth = 0
    private var androidInputHeight = 0
    private lazy var iosPhysical = IOSPhysicalDeviceBackend(
        onConfiguration: { [weak self] configuration in
            guard let self else { return }
            self.queue.async {
                guard self.captureActive,
                    self.selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical
                else { return }
                self.latestH264Configuration = configuration
                self.broadcast(
                    WireFrame(kind: .h264Configuration, payload: configuration),
                    codec: "h264"
                )
            }
        },
        onFrame: { [weak self] timestamp, keyframe, bytes in
            guard let self else { return }
            self.queue.async {
                guard self.captureActive,
                    self.selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical
                else { return }
                self.iosPhysicalFrameSequence &+= 1
                self.frameID = "ios-xcui-\(self.iosPhysicalFrameSequence)"
                self.metrics.didCapture()
                var payload = Data()
                var micros = timestamp.bigEndian
                withUnsafeBytes(of: &micros) { payload.append(contentsOf: $0) }
                payload.append(keyframe ? 1 : 0)
                payload.append(bytes)
                self.broadcast(WireFrame(kind: .h264Frame, payload: payload), codec: "h264")
            }
        },
        onFailure: { [weak self] error in
            guard let self else { return }
            self.queue.async {
                self.iosPhysicalError =
                    (error as? SimViewError)?.message ?? error.localizedDescription
                self.latestH264Configuration = nil
                if self.selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                    self.captureActive = false
                }
            }
        }
    )
    private var iosPhysicalError: String?
    private var iosPhysicalFrameSequence: UInt64 = 0
    private var iosPhysicalWidth = 0
    private var iosPhysicalHeight = 0
    private var iosPhysicalAppBundleID: String?
    private var latestH264Configuration: Data?
    private var captureActive = false
    private var captureDeviceID: String?
    private var frameID = "0"
    private var encodingFrame = false
    private var pendingH264Frame: PendingH264Frame?
    private var encodingMJPEGFrame = false
    private var pendingMJPEGFrame: PendingH264Frame?
    private var captureGeneration: UInt64 = 0

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
                if captureActive, connection.codec == "h264" {
                    if let latestH264Configuration {
                        connection.send(WireFrame(kind: .h264Configuration, payload: latestH264Configuration))
                    }
                    if let androidAgent {
                        try? androidAgent.requestKeyframe()
                    } else {
                        Task { await h264.forceKeyframe() }
                    }
                } else if captureActive, connection.codec == "mjpeg", androidAgent != nil,
                    connections.filter({ $0.authenticated && $0.codec == "mjpeg" }).count == 1
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
        if wasAuthenticated, connection.codec == "mjpeg",
            !connections.contains(where: { $0.authenticated && $0.codec == "mjpeg" }),
            androidAgent != nil
        {
            androidCapture?.stop()
        }
        if wasAuthenticated, !connections.contains(where: \.authenticated) {
            lastDisconnect = Date()
            stopCapture()
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
        switch request.method {
        case "devices.list":
            sendResult(try DeviceRuntime.devices().map(\.dictionary), requestID: request.id, to: connection)
        case "device.prepare":
            let device = try selectDevice(request.deviceIdentifier)
            guard DeviceBackendRoute(device) == .iosPhysical else {
                throw SimViewError(
                    "METHOD_UNSUPPORTED",
                    "Device preparation is only required for physical iOS devices"
                )
            }
            sendResult(
                try iosPhysical.prepare(
                    device: device,
                    team: request.params["team"]?.stringValue
                ),
                requestID: request.id,
                to: connection
            )
        case "apps.list":
            let device = try selectDevice(request.deviceIdentifier)
            guard DeviceBackendRoute(device) == .iosPhysical else {
                throw SimViewError(
                    "METHOD_UNSUPPORTED",
                    "Installed-app listing is only available for physical iOS devices"
                )
            }
            sendResult(try iosPhysical.apps(device: device), requestID: request.id, to: connection)
        case "app.target":
            let device = try selectDevice(request.deviceIdentifier)
            guard DeviceBackendRoute(device) == .iosPhysical else {
                throw SimViewError(
                    "METHOD_UNSUPPORTED",
                    "App targeting is only available for physical iOS devices"
                )
            }
            let bundleID = try request.params.string("appBundleId")
            let result = try iosPhysical.selectApp(device: device, bundleID: bundleID)
            iosPhysicalAppBundleID = bundleID
            sendResult(result, requestID: request.id, to: connection)
        case "device.describe":
            let device = try selectDevice(request.deviceIdentifier)
            var value = deviceResponseDictionary(device)
            let captureWidth: Int
            let captureHeight: Int
            switch DeviceBackendRoute(device) {
            case .iosSimulator:
                captureWidth = capture.width
                captureHeight = capture.height
            case .iosPhysical:
                captureWidth = iosPhysicalWidth
                captureHeight = iosPhysicalHeight
            case .android:
                captureWidth = androidCapture?.width ?? 0
                captureHeight = androidCapture?.height ?? 0
            }
            if captureWidth > 0 {
                value["pixelWidth"] = captureWidth
                value["pixelHeight"] = captureHeight
            }
            sendResult(value, requestID: request.id, to: connection)
        case "capture.start":
            let device = try selectDevice(request.deviceIdentifier)
            if DeviceBackendRoute(device) == .iosPhysical, connection.codec != "h264" {
                throw SimViewError(
                    "CODEC_UNSUPPORTED",
                    "Physical iOS preview requires an H.264-capable client"
                )
            }
            let requestedBundleID = request.params["appBundleId"]?.stringValue
            try startCapture(device, appBundleID: requestedBundleID)
            sendResult(
                [
                    "device": deviceResponseDictionary(device),
                    "codec": connection.codec,
                    "frameRate": DeviceBackendRoute(device) == .android && androidAgent == nil ? 4 : 60,
                ], requestID: request.id, to: connection)
        case "capture.stop":
            stopCapture()
            sendResult(["stopped": true], requestID: request.id, to: connection)
        case "capture.keyframe":
            guard captureActive else {
                throw SimViewError("CAPTURE_NOT_STARTED", "Start capture before requesting a keyframe")
            }
            if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                try iosPhysical.requestKeyframe()
            } else if let androidAgent {
                try androidAgent.requestKeyframe()
            } else {
                Task { await h264.forceKeyframe() }
            }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "capture.screenshot":
            if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                let screenshot = try iosPhysical.screenshot()
                let width = (screenshot.metadata["width"] as? NSNumber)?.intValue ?? iosPhysicalWidth
                let height = (screenshot.metadata["height"] as? NSNumber)?.intValue ?? iosPhysicalHeight
                iosPhysicalWidth = width
                iosPhysicalHeight = height
                sendResult(
                    [
                        "frameId": frameID,
                        "width": width,
                        "height": height,
                        "byteLength": screenshot.data.count,
                    ], requestID: request.id, to: connection)
                connection.send(WireFrame(kind: .pngScreenshot, payload: screenshot.data))
            } else if selectedDevice?.platform == .android, let androidCapture {
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
        case "input.touch":
            if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                throw SimViewError(
                    "INPUT_RAW_TOUCH_UNAVAILABLE",
                    "Physical iOS uses discrete XCUI gestures rather than raw touch injection"
                )
            } else if selectedDevice?.platform == .android {
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
            if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                try iosPhysical.swipe(
                    fromX: try from.double("x"), fromY: try from.double("y"),
                    toX: try to.double("x"), toY: try to.double("y"),
                    duration: request.params.double("durationMs") / 1_000
                )
            } else if let androidAgent, let dimensions = androidInputDimensions() {
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
        case "input.typeText":
            let method: String
            if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                try iosPhysical.typeText(request.params.string("text"))
                method = "ios-xcui"
            } else if let androidAgent {
                method = try androidAgent.typeText(request.params.string("text"))
            } else if let controller = try androidInputIfSelected() {
                method = try controller.typeText(request.params.string("text"))
            } else {
                try prepareHID()
                method = try hid.typeText(request.params.string("text"))
            }
            sendResult(["accepted": true, "inputMethod": method], requestID: request.id, to: connection)
        case "input.key":
            if selectedDevice.map(DeviceBackendRoute.init) != .iosSimulator {
                throw SimViewError(
                    "INPUT_KEY_UNSUPPORTED",
                    "Raw HID usages are only available on iOS Simulator"
                )
            }
            try prepareHID()
            hid.key(
                usage: UInt32(try request.params.int("usage")),
                down: try request.params.string("phase") == "down"
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.button":
            if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                try iosPhysical.pressButton(request.params.string("button"))
            } else if let androidAgent {
                try androidAgent.pressButton(request.params.string("button"))
            } else if let controller = try androidInputIfSelected() {
                try controller.pressButton(request.params.string("button"))
            } else {
                try prepareHID()
                try hid.pressButton(request.params.string("button"))
            }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "device.orientation.set":
            if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
                try iosPhysical.setOrientation(request.params.string("orientation"))
                try iosPhysical.requestKeyframe()
            } else if let controller = try androidInputIfSelected() {
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
        case "accessibility.elementAtPoint":
            let device = try selectDevice(request.deviceIdentifier)
            let result = try accessibilityElementAtPoint(device, params: request.params)
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.find":
            let selector = try request.params.dictionary("selector")
            let device = try selectDevice(request.deviceIdentifier)
            let result: [String: Any]
            if DeviceBackendRoute(device) == .iosPhysical {
                result = try iosPhysical.find(
                    selector: selector.foundationDictionary,
                    timeout: nil
                )
            } else if device.platform == .android {
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
            let result: [String: Any]
            if DeviceBackendRoute(device) == .iosPhysical {
                result = try iosPhysical.wait(
                    selector: selector,
                    exists: state == "visible",
                    timeout: Double(timeout) / 1_000
                )
            } else if device.platform == .android {
                result = try requireAndroidAccessibility().wait(
                    selector: selector, state: state, timeoutMs: timeout)
            } else {
                result = try accessibility.wait(
                    udid: device.nativeIdentifier, selector: selector, state: state, timeoutMs: timeout)
            }
            sendResult(result, requestID: request.id, to: connection)
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
                    "accessibility": selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical
                        || selectedDevice?.platform == .android || accessibility.available,
                    "probe": selectedDevice.map(DeviceBackendRoute.init) == .iosSimulator
                        ? probe.status() : false,
                    "androidContext": selectedDevice?.platform == .android,
                    "androidAgent": androidAgent != nil,
                    "androidAgentError": androidAgentError as Any? ?? NSNull(),
                    "iosRunner": selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical,
                    "iosRunnerError": iosPhysicalError as Any? ?? NSNull(),
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

    private func startCapture(_ device: DeviceDescription, appBundleID: String? = nil) throws {
        if captureActive, captureDeviceID == device.id { return }
        capture.stop()
        androidCapture?.stop()
        androidAgent?.stop()
        androidController?.stop()
        androidCapture = nil
        androidController = nil
        androidAccessibility = nil
        androidClient = nil
        androidAgent = nil
        androidAgentError = nil
        androidAgentRestartAttempts = 0
        androidAgentFrameSequence = 0
        if DeviceBackendRoute(device) != .iosPhysical { iosPhysical.shutdown() }
        iosPhysicalError = nil
        iosPhysicalFrameSequence = 0
        latestH264Configuration = nil
        selectedDevice = device
        captureDeviceID = device.id
        androidInputWidth = device.pixelWidth ?? 0
        androidInputHeight = device.pixelHeight ?? 0
        captureGeneration &+= 1
        let generation = captureGeneration
        let handler: @Sendable (CVPixelBuffer, CMTime, String) -> Void = { [weak self] frame, timestamp, frameID in
            guard let self else { return }
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
            switch DeviceBackendRoute(device) {
            case .iosSimulator:
                try capture.start(udid: device.nativeIdentifier, callback: handler)
            case .iosPhysical:
                let bundleID = appBundleID ?? iosPhysicalAppBundleID
                let result = try iosPhysical.startCapture(device: device, appBundleID: bundleID)
                iosPhysicalAppBundleID = bundleID
                iosPhysicalWidth = (result["width"] as? NSNumber)?.intValue ?? 0
                iosPhysicalHeight = (result["height"] as? NSNumber)?.intValue ?? 0
            case .android:
                let client = try ADBClient()
                let androidCapture = AndroidFrameCapture(client: client, serial: device.nativeIdentifier)
                self.androidClient = client
                self.androidCapture = androidCapture
                androidController = AndroidController(client: client, device: device)
                androidAccessibility = AndroidAccessibilityService(client: client, serial: device.nativeIdentifier)
                let accelerated = tryStartAndroidAgent(client: client, device: device, generation: generation)
                if accelerated {
                    if connections.contains(where: { $0.authenticated && $0.codec == "mjpeg" }) {
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

    private func stopCapture() {
        captureGeneration &+= 1
        capture.stop()
        iosPhysical.stopCapture()
        androidCapture?.stop()
        androidAgent?.stop()
        androidController?.stop()
        androidCapture = nil
        androidController = nil
        androidAccessibility = nil
        androidClient = nil
        androidAgent = nil
        androidAgentRestartAttempts = 0
        androidAgentFrameSequence = 0
        androidInputWidth = 0
        androidInputHeight = 0
        iosPhysicalWidth = 0
        iosPhysicalHeight = 0
        latestH264Configuration = nil
        captureActive = false
        captureDeviceID = nil
        frameID = "0"
        pendingH264Frame = nil
        pendingMJPEGFrame = nil
        Task { await h264.stop() }
    }

    private func acceptCapturedFrame(_ pending: PendingH264Frame) {
        guard captureActive, pending.generation == captureGeneration else { return }
        metrics.didCapture()
        frameID = pending.frameID
        if connections.contains(where: { $0.authenticated && $0.codec == "mjpeg" }) {
            enqueueMJPEG(pending)
        }

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
                        var payload = Data()
                        var micros = timestamp.bigEndian
                        withUnsafeBytes(of: &micros) { payload.append(contentsOf: $0) }
                        payload.append(keyframe ? 1 : 0)
                        payload.append(bytes)
                        server.broadcast(WireFrame(kind: .h264Frame, payload: payload), codec: "h264")
                    }
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
        if connections.contains(where: { $0.authenticated && $0.codec == "mjpeg" }) {
            enqueueMJPEG(pending)
        }
    }

    private func ensureAndroidMJPEGCapture(generation: UInt64) {
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
            self.queue.async { self.acceptAndroidCompatibilityFrame(pending) }
        }
    }

    private func handleAndroidAgentFailure(_ error: Error, generation: UInt64) {
        guard captureActive, generation == captureGeneration, selectedDevice?.platform == .android else { return }
        let failedAgent = androidAgent
        failedAgent?.stop()
        androidAgentError =
            failedAgent?.diagnostics
            ?? (error as? SimViewError)?.message ?? error.localizedDescription
        androidAgent = nil
        latestH264Configuration = nil
        if androidAgentRestartAttempts < 1, let client = androidClient, let device = selectedDevice {
            androidAgentRestartAttempts += 1
            if tryStartAndroidAgent(client: client, device: device, generation: generation) {
                if connections.contains(where: { $0.authenticated && $0.codec == "mjpeg" }) {
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

    private func prepareHID() throws {
        let device = try selectDevice(nil)
        guard DeviceBackendRoute(device) == .iosSimulator else {
            throw SimViewError("INPUT_UNAVAILABLE", "Simulator HID is unavailable for this device backend")
        }
        try hid.setup(udid: device.nativeIdentifier)
    }

    private func performTap(
        params: [String: JSONValue], defaultDuration: TimeInterval
    ) throws {
        let x = try params.double("x")
        let y = try params.double("y")
        let duration = params.optionalDouble("durationMs").map { $0 / 1_000 } ?? defaultDuration
        if selectedDevice.map(DeviceBackendRoute.init) == .iosPhysical {
            try iosPhysical.tap(x: x, y: y, duration: duration)
        } else if let androidAgent, let dimensions = androidInputDimensions() {
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
            androidCapture = nil
            androidController = nil
            androidAccessibility = nil
            androidClient = nil
            androidAgent = nil
            androidAgentError = nil
            androidAgentRestartAttempts = 0
            androidInputWidth = 0
            androidInputHeight = 0
            if DeviceBackendRoute(selectedDevice) == .iosPhysical {
                iosPhysical.shutdown()
                iosPhysicalWidth = 0
                iosPhysicalHeight = 0
                iosPhysicalAppBundleID = nil
            }
        }
        selectedDevice = device
        return device
    }

    private func requireIOSDevice(_ requested: String?) throws -> DeviceDescription {
        let device = try selectDevice(requested)
        guard DeviceBackendRoute(device) == .iosSimulator else {
            throw SimViewError("METHOD_UNSUPPORTED", "UIKit probe methods are only available on iOS Simulator")
        }
        return device
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
        let service = AndroidAccessibilityService(client: client, serial: device.nativeIdentifier)
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
        if DeviceBackendRoute(device) == .iosPhysical {
            return try iosPhysical.snapshot(
                maxDepth: nil,
                maxChildren: params["maxNodes"]?.intValue ?? 1_200
            )
        }
        return try accessibility.snapshot(
            udid: device.nativeIdentifier,
            scope: params["scope"]?.stringValue ?? "interactive",
            maxNodes: params["maxNodes"]?.intValue ?? 1_200
        )
    }

    private func accessibilityElementAtPoint(
        _ device: DeviceDescription, params: [String: JSONValue]
    ) throws -> [String: Any] {
        if device.platform == .android {
            return try requireAndroidAccessibility().elementAtPoint(
                x: params.double("x"), y: params.double("y")
            )
        }
        if DeviceBackendRoute(device) == .iosPhysical {
            return try iosPhysical.elementAtPoint(
                x: params.double("x"),
                y: params.double("y")
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
            capabilities["input"] = input
            result["capabilities"] = capabilities
        } else if DeviceBackendRoute(device) == .iosPhysical {
            let ownsActiveCapture = captureDeviceID == device.id
            metadata["captureTransport"] = "simview-xcui-runner"
            metadata["inputTransport"] = "ios-xcui"
            metadata["usbTransport"] = "usbmux"
            if let iosPhysicalAppBundleID { metadata["appBundleId"] = iosPhysicalAppBundleID }
            if ownsActiveCapture, let iosPhysicalError { metadata["runnerError"] = iosPhysicalError }
        }
        result["metadata"] = metadata
        return result
    }

    private func broadcast(_ frame: WireFrame, codec: String) {
        let data = frame.encoded
        for connection in connections where connection.authenticated && connection.codec == codec {
            connection.sendEncoded(data, kind: frame.kind)
            metrics.didDeliver()
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
            if !self.connections.contains(where: \.authenticated),
                Date().timeIntervalSince(self.lastDisconnect) >= self.idleTimeout
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
        probe.close()
        stopCapture()
        iosPhysical.shutdown()
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
