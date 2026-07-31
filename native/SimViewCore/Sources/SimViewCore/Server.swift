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
        let data = frame.encoded
        stateLock.lock()
        guard !closed else {
            stateLock.unlock()
            return
        }
        if frame.kind == .h264Frame || frame.kind == .jpegFrame {
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
    private let preferredUDID: String?
    private let instanceID: String?
    private let parentPID: pid_t?
    private let idleTimeout: TimeInterval
    private let queue = DispatchQueue(label: "dev.simview.server", qos: .userInteractive)
    private let inputQueue = DispatchQueue(label: "dev.simview.server.input", qos: .userInteractive)
    private let mjpegQueue = DispatchQueue(label: "dev.simview.server.mjpeg", qos: .userInitiated)
    private var listenerFD: Int32 = -1
    private var listener: DispatchSourceRead?
    private var timer: DispatchSourceTimer?
    private var connections = Set<ClientConnection>()
    private var lastDisconnect = Date()
    private var selectedDevice: SimulatorDevice?
    private let capture = FrameCapture()
    private let hid = HIDInjector()
    private let accessibility = AccessibilityService()
    private let probe = ProbeCoordinator()
    private let h264 = H264Encoder()
    private let metrics = Metrics()
    private var captureActive = false
    private var frameID = "0"
    private var encodingFrame = false
    private var pendingH264Frame: PendingH264Frame?
    private var encodingMJPEGFrame = false
    private var pendingMJPEGFrame: PendingH264Frame?
    private var captureGeneration: UInt64 = 0

    init(
        socketPath: String,
        token: String,
        preferredUDID: String?,
        instanceID: String?,
        parentPID: pid_t?,
        idleTimeout: TimeInterval
    ) {
        self.socketPath = socketPath
        self.token = token
        self.preferredUDID = preferredUDID
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
            guard request.protocolVersion == 1 else {
                throw SimViewError(
                    "PROTOCOL_VERSION_UNSUPPORTED",
                    "Protocol version \(request.protocolVersion) is unsupported",
                    recoverable: false,
                    details: ["supported": [1]]
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
                sendResult(
                    [
                        "protocolVersion": 1,
                        "codec": connection.codec,
                        "maxFrameRate": 60,
                        "server": "simview-core/\(SimViewVersion.current)",
                        "capabilities": [
                            "capture": true,
                            "input": true,
                            "accessibility": accessibility.available,
                            "probe": probe.bundled,
                        ],
                    ], requestID: request.id, to: connection)
                if captureActive, connection.codec == "h264" {
                    Task { await h264.forceKeyframe() }
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
            sendResult(try SimulatorRuntime.devices().map(\.dictionary), requestID: request.id, to: connection)
        case "device.describe":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            var value = device.dictionary
            if capture.width > 0 {
                value["pixelWidth"] = capture.width
                value["pixelHeight"] = capture.height
            }
            sendResult(value, requestID: request.id, to: connection)
        case "capture.start":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            try startCapture(device)
            sendResult(
                [
                    "device": device.dictionary,
                    "codec": connection.codec,
                    "frameRate": 60,
                ], requestID: request.id, to: connection)
        case "capture.stop":
            stopCapture()
            sendResult(["stopped": true], requestID: request.id, to: connection)
        case "capture.keyframe":
            guard captureActive else {
                throw SimViewError("CAPTURE_NOT_STARTED", "Start capture before requesting a keyframe")
            }
            Task { await h264.forceKeyframe() }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "capture.screenshot":
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
        case "input.touch":
            try prepareHID()
            try hid.touch(
                phase: request.params.string("phase"),
                x: request.params.double("x"),
                y: request.params.double("y")
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.tap":
            try prepareHID()
            try hid.tap(
                x: request.params.double("x"),
                y: request.params.double("y"),
                duration: request.params.optionalDouble("durationMs").map { $0 / 1_000 } ?? 0.05
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.longPress":
            try prepareHID()
            try hid.tap(
                x: request.params.double("x"),
                y: request.params.double("y"),
                duration: request.params.optionalDouble("durationMs").map { $0 / 1_000 } ?? 0.6
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.swipe":
            try prepareHID()
            let from = try request.params.dictionary("from")
            let to = try request.params.dictionary("to")
            try hid.swipe(
                fromX: try from.double("x"),
                fromY: try from.double("y"),
                toX: try to.double("x"),
                toY: try to.double("y"),
                duration: max(0.05, request.params.double("durationMs") / 1_000)
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.typeText":
            try prepareHID()
            let method = try hid.typeText(request.params.string("text"))
            sendResult(["accepted": true, "inputMethod": method], requestID: request.id, to: connection)
        case "input.key":
            try prepareHID()
            hid.key(
                usage: UInt32(try request.params.int("usage")),
                down: try request.params.string("phase") == "down"
            )
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "input.button":
            try prepareHID()
            try hid.pressButton(request.params.string("button"))
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "device.orientation.set":
            try prepareHID()
            try hid.setOrientation(request.params.string("orientation"))
            Task { await h264.forceKeyframe() }
            sendResult(["accepted": true], requestID: request.id, to: connection)
        case "accessibility.snapshot":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            let result = try accessibility.snapshot(
                udid: device.udid,
                scope: request.params["scope"]?.stringValue ?? "interactive",
                maxNodes: request.params["maxNodes"]?.intValue ?? 1_200
            )
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.elementAtPoint":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            let result = try accessibility.elementAtPoint(
                udid: device.udid,
                x: request.params.double("x"),
                y: request.params.double("y")
            )
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.find":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            let selector = try request.params.dictionary("selector")
            let result = try accessibility.find(
                udid: device.udid,
                selector: selector.foundationDictionary,
                scope: request.params["scope"]?.stringValue ?? "visible"
            )
            sendResult(result, requestID: request.id, to: connection)
        case "accessibility.wait":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            let result = try accessibility.wait(
                udid: device.udid,
                selector: try request.params.dictionary("selector").foundationDictionary,
                state: request.params["state"]?.stringValue ?? "visible",
                timeoutMs: request.params["timeoutMs"]?.intValue ?? 5_000
            )
            sendResult(result, requestID: request.id, to: connection)
        case "probe.status":
            sendResult(probe.status(), requestID: request.id, to: connection)
        case "probe.target":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            sendResult(probe.target(udid: device.udid), requestID: request.id, to: connection)
        case "probe.enable":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            let result = try probe.enable(
                udid: device.udid,
                bundleID: request.params.string("bundleId")
            )
            sendResult(result, requestID: request.id, to: connection)
        case "probe.disable":
            let device = try selectDevice(request.params["udid"]?.stringValue)
            sendResult(try probe.disable(udid: device.udid), requestID: request.id, to: connection)
        case "probe.context":
            sendResult(try probe.request("context"), requestID: request.id, to: connection)
        case "probe.inspectPoint":
            sendResult(
                try probe.request(
                    "inspectPoint",
                    params: [
                        "x": request.params.double("x"),
                        "y": request.params.double("y"),
                    ]), requestID: request.id, to: connection)
        case "probe.findViews":
            sendResult(
                try probe.request("findViews", params: request.params.foundationDictionary),
                requestID: request.id,
                to: connection
            )
        case "probe.fullHierarchy":
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
            sendResult(
                [
                    "status": "ok",
                    "pid": Int(getpid()),
                    "instanceId": instanceID as Any? ?? NSNull(),
                    "configuredUdid": preferredUDID as Any? ?? NSNull(),
                    "device": selectedDevice.map { $0.dictionary as Any } ?? NSNull(),
                    "captureActive": captureActive,
                    "captureState": captureActive ? "active" : "idle",
                    "idleDeadline": idleDeadline,
                    "capabilities": [
                        "capture": true,
                        "input": true,
                        "accessibility": accessibility.available,
                        "probe": probe.status(),
                    ],
                    "clients": authenticated.count,
                    "clientsByCodec": [
                        "h264": authenticated.filter { $0.codec == "h264" }.count,
                        "mjpeg": authenticated.filter { $0.codec == "mjpeg" }.count,
                    ],
                    "metrics": metrics.dictionary,
                ], requestID: request.id, to: connection)
        case "server.shutdown":
            sendResult(["shuttingDown": true], requestID: request.id, to: connection)
            queue.asyncAfter(deadline: .now() + .milliseconds(20)) { self.shutdown(exitCode: 0) }
        default:
            throw SimViewError("METHOD_NOT_FOUND", "Unknown method: \(request.method)")
        }
    }

    private func startCapture(_ device: SimulatorDevice) throws {
        if captureActive, selectedDevice?.udid == device.udid { return }
        capture.stop()
        selectedDevice = device
        captureGeneration &+= 1
        let generation = captureGeneration
        try capture.start(udid: device.udid) { [weak self] frame, timestamp, frameID in
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
    }

    private func stopCapture() {
        captureGeneration &+= 1
        capture.stop()
        captureActive = false
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

    private func prepareHID() throws {
        let device = try selectDevice(nil)
        try hid.setup(udid: device.udid)
    }

    private func selectDevice(_ requested: String?) throws -> SimulatorDevice {
        if let selectedDevice, requested == nil || requested == selectedDevice.udid {
            return selectedDevice
        }
        let device = try SimulatorRuntime.booted(preferredUDID: requested ?? preferredUDID)
        selectedDevice = device
        return device
    }

    private func broadcast(_ frame: WireFrame, codec: String) {
        for connection in connections where connection.authenticated && connection.codec == codec {
            connection.send(frame)
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

    private func shutdown(exitCode: Int32) -> Never {
        probe.close()
        stopCapture()
        listener?.cancel()
        timer?.cancel()
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
