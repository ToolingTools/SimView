import Foundation
@preconcurrency import Network
import UIKit

@MainActor
final class RunnerServer {
    private let token: [UInt8]
    private let port: UInt16
    private let controller: XCUIController
    private let encoder = H264Encoder()
    private let networkQueue = DispatchQueue(label: "tools.simview.ios-runner.network")

    private var listener: NWListener?
    private var connection: NWConnection?
    private var decoder = RunnerFrameDecoder()
    private var authenticated = false
    private var streamTimer: DispatchSourceTimer?
    private var captureInFlight = false
    private var streamFPS = 60
    private var streamMaximumLongEdge = 1_600
    private var streamBitrate = 5_000_000
    private var streamedFrameCount: UInt64 = 0
    private var streamStartedAt: TimeInterval?
    private var lastAdaptationAt: TimeInterval?
    private var stopped = false
    private var stopHandlers: [() -> Void] = []

    init(port: UInt16, token: String, initialBundleID: String?) throws {
        guard port > 0 else {
            throw RunnerError("PORT_INVALID", "Runner TCP port must be non-zero", recoverable: false)
        }
        guard token.utf8.count >= 32, token.utf8.count <= 4_096 else {
            throw RunnerError(
                "TOKEN_INVALID",
                "Runner token must contain between 32 and 4096 UTF-8 bytes",
                recoverable: false
            )
        }
        self.port = port
        self.token = Array(token.utf8)
        controller = XCUIController(initialBundleID: initialBundleID)
    }

    func start() throws {
        guard listener == nil else { return }
        guard let networkPort = NWEndpoint.Port(rawValue: port) else {
            throw RunnerError("PORT_INVALID", "Runner TCP port is invalid", recoverable: false)
        }
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: networkPort)
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                self?.accept(connection)
            }
        }
        listener.stateUpdateHandler = { [weak self] state in
            guard case .failed = state else { return }
            Task { @MainActor in
                self?.stop()
            }
        }
        listener.start(queue: networkQueue)
        self.listener = listener
    }

    func waitUntilStopped() async {
        if stopped { return }
        await withCheckedContinuation { continuation in
            stopHandlers.append { continuation.resume() }
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        stopStream()
        connection?.cancel()
        connection = nil
        listener?.cancel()
        listener = nil
        for handler in stopHandlers { handler() }
        stopHandlers.removeAll()
    }

    private func accept(_ candidate: NWConnection) {
        connection?.cancel()
        connection = candidate
        decoder = RunnerFrameDecoder()
        authenticated = false
        candidate.stateUpdateHandler = { [weak self, weak candidate] state in
            guard case .failed = state else { return }
            Task { @MainActor in
                guard self?.connection === candidate else { return }
                self?.disconnectCurrentConnection()
            }
        }
        candidate.start(queue: networkQueue)
        receive(on: candidate)
    }

    private func disconnectCurrentConnection() {
        stopStream()
        connection?.cancel()
        connection = nil
        authenticated = false
        decoder = RunnerFrameDecoder()
    }

    private func receive(on candidate: NWConnection) {
        candidate.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self, weak candidate]
            data,
            _,
            isComplete,
            error in
            Task { @MainActor in
                guard let self, let candidate, self.connection === candidate else { return }
                if let data, !data.isEmpty {
                    self.consume(data)
                }
                if isComplete || error != nil {
                    self.disconnectCurrentConnection()
                } else {
                    self.receive(on: candidate)
                }
            }
        }
    }

    private func consume(_ data: Data) {
        do {
            for frame in try decoder.append(data) {
                guard frame.kind == .request else {
                    throw RunnerError(
                        "PROTOCOL_DIRECTION",
                        "The host may send request frames only",
                        recoverable: false
                    )
                }
                handle(frame.payload)
            }
        } catch {
            sendFailure(id: "unknown", error: error)
            disconnectCurrentConnection()
        }
    }

    private func handle(_ payload: Data) {
        let request: RunnerRequest
        do {
            request = try JSONDecoder().decode(RunnerRequest.self, from: payload)
        } catch {
            sendFailure(
                id: "unknown",
                error: RunnerError("PROTOCOL_INVALID_REQUEST", "Runner request is malformed")
            )
            return
        }
        guard request.protocolVersion == RunnerProtocol.version else {
            sendFailure(
                id: request.id,
                error: RunnerError(
                    "PROTOCOL_VERSION_UNSUPPORTED",
                    "Runner protocol \(request.protocolVersion) is not supported",
                    recoverable: false
                )
            )
            return
        }
        guard authenticated || request.method == "authenticate" else {
            sendFailure(
                id: request.id,
                error: RunnerError(
                    "AUTHENTICATION_REQUIRED",
                    "authenticate must be the first runner request",
                    recoverable: false
                )
            )
            disconnectCurrentConnection()
            return
        }

        do {
            switch request.method {
            case "authenticate":
                try authenticate(request)
            case "health":
                sendSuccess(id: request.id, result: health())
            case "selectApp":
                let bundleID = try request.params.requiredString("bundleId")
                sendSuccess(
                    id: request.id,
                    result: try controller.selectApplication(bundleID: bundleID)
                )
            case "screenshot":
                let quality = request.params["quality"]?.stringValue ?? "full"
                let screenshot = try controller.screenshot(preview: quality == "preview")
                sendSuccess(
                    id: request.id,
                    result: [
                        "format": "png",
                        "data": screenshot.data.base64EncodedString(),
                        "width": screenshot.image.size.width * screenshot.image.scale,
                        "height": screenshot.image.size.height * screenshot.image.scale,
                        "scale": screenshot.image.scale,
                        "timestampMicros": screenshot.timestampMicros,
                        "capturePath": screenshot.capturePath,
                    ]
                )
            case "snapshot":
                sendSuccess(
                    id: request.id,
                    result: try controller.snapshot(
                        maxDepth: request.params["maxDepth"]?.intValue ?? 50,
                        maxChildren: request.params["maxChildren"]?.intValue ?? 1_000
                    )
                )
            case "find":
                sendSuccess(
                    id: request.id,
                    result: try controller.find(
                        selector: try selector(request.params),
                        timeout: request.params["timeout"]?.doubleValue ?? 0
                    )
                )
            case "elementAtPoint":
                sendSuccess(
                    id: request.id,
                    result: try controller.element(at: directPoint(request.params))
                )
            case "wait":
                sendSuccess(
                    id: request.id,
                    result: try controller.wait(
                        selector: try selector(request.params),
                        shouldExist: request.params["exists"]?.boolValue ?? true,
                        timeout: request.params["timeout"]?.doubleValue ?? 10
                    )
                )
            case "tap":
                try controller.tap(directPoint(request.params))
                sendSuccess(id: request.id, result: ["accepted": true])
            case "longPress":
                try controller.longPress(
                    directPoint(request.params),
                    duration: request.params["duration"]?.doubleValue ?? 0.5
                )
                sendSuccess(id: request.id, result: ["accepted": true])
            case "drag", "swipe":
                try controller.drag(
                    from: try request.params.normalizedPoint("from"),
                    to: try request.params.normalizedPoint("to"),
                    duration: request.params["duration"]?.doubleValue
                        ?? (request.method == "swipe" ? 0 : 0.5)
                )
                sendSuccess(id: request.id, result: ["accepted": true])
            case "typeText":
                try controller.typeText(try request.params.requiredString("text"))
                sendSuccess(id: request.id, result: ["accepted": true])
            case "pressButton":
                try controller.pressButton(try request.params.requiredString("button"))
                sendSuccess(id: request.id, result: ["accepted": true])
            case "setOrientation":
                try controller.setOrientation(try request.params.requiredString("orientation"))
                sendSuccess(id: request.id, result: ["accepted": true])
            case "activateApp":
                try controller.activateApplication()
                sendSuccess(id: request.id, result: ["accepted": true])
            case "terminateApp":
                try controller.terminateApplication()
                sendSuccess(id: request.id, result: ["accepted": true])
            case "startStream":
                sendSuccess(id: request.id, result: try startStream(request.params))
            case "stopStream":
                stopStream()
                sendSuccess(id: request.id, result: ["stopped": true])
            case "requestKeyframe":
                encoder.forceKeyframe()
                sendSuccess(id: request.id, result: ["accepted": true])
            case "shutdown":
                sendSuccess(id: request.id, result: ["accepted": true])
                DispatchQueue.main.async { [weak self] in self?.stop() }
            default:
                throw RunnerError("METHOD_NOT_FOUND", "Unknown runner method: \(request.method)")
            }
        } catch {
            sendFailure(id: request.id, error: error)
        }
    }

    private func authenticate(_ request: RunnerRequest) throws {
        guard !authenticated else {
            throw RunnerError("ALREADY_AUTHENTICATED", "Runner connection is already authenticated")
        }
        let supplied = Array(try request.params.requiredString("token").utf8)
        guard constantTimeEqual(supplied, token) else {
            sendFailure(
                id: request.id,
                error: RunnerError("AUTHENTICATION_FAILED", "Runner authentication failed", recoverable: false)
            )
            return
        }
        authenticated = true
        sendSuccess(
            id: request.id,
            result: [
                "protocolVersion": RunnerProtocol.version,
                "source": "ios-xcui",
                "capabilities": capabilities(),
            ]
        )
    }

    private func capabilities() -> [String: Any] {
        [
            "capture": [
                "h264": true,
                "screenshot": true,
                "targetFPS": 60,
                "performanceQualified": false,
            ],
            "accessibility": ["snapshot": true, "source": "ios-xcui", "uikitProbe": false],
            "input": [
                "rawTouch": false,
                "tap": true,
                "longPress": true,
                "drag": true,
                "swipe": true,
                "text": true,
                "buttons": controller.reportedButtons,
            ],
            "lifecycle": ["activate": true, "terminate": true],
            "transport": ["usb": true, "wifi": false],
        ]
    }

    private func health() -> [String: Any] {
        let elapsed = max(0.001, ProcessInfo.processInfo.systemUptime - (streamStartedAt ?? 0))
        let activeBundleID: Any = controller.activeBundleID ?? NSNull()
        return [
            "protocolVersion": RunnerProtocol.version,
            "authenticated": authenticated,
            "activeBundleId": activeBundleID,
            "streaming": streamTimer != nil,
            "privateScreenshotAvailable": controller.privateScreenshotAvailable,
            "streamedFrames": streamedFrameCount,
            "averageStreamFPS": streamStartedAt == nil ? 0 : Double(streamedFrameCount) / elapsed,
            "streamMaxLongEdge": streamMaximumLongEdge,
            "streamBitrate": streamBitrate,
            "performanceQualified": false,
        ]
    }

    private func startStream(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard connection != nil else {
            throw RunnerError("CONNECTION_CLOSED", "Runner connection is closed")
        }
        stopStream()
        streamFPS = min(max(params["fps"]?.intValue ?? 60, 1), 60)
        streamMaximumLongEdge = min(max(params["maxLongEdge"]?.intValue ?? 1_600, 320), 2_400)
        streamBitrate = min(max(params["bitrate"]?.intValue ?? 5_000_000, 500_000), 20_000_000)
        encoder.configure(bitrate: streamBitrate, frameRate: streamFPS)
        encoder.forceKeyframe()
        streamedFrameCount = 0
        streamStartedAt = ProcessInfo.processInfo.systemUptime
        lastAdaptationAt = streamStartedAt

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(
            deadline: .now(),
            repeating: .nanoseconds(Int(1_000_000_000 / streamFPS)),
            leeway: .milliseconds(1)
        )
        timer.setEventHandler { [weak self] in self?.capturePreviewFrame() }
        timer.resume()
        streamTimer = timer
        return [
            "started": true,
            "fps": streamFPS,
            "maxLongEdge": streamMaximumLongEdge,
            "bitrate": streamBitrate,
        ]
    }

    private func stopStream() {
        streamTimer?.cancel()
        streamTimer = nil
        captureInFlight = false
        streamStartedAt = nil
        lastAdaptationAt = nil
        encoder.stop()
    }

    private func capturePreviewFrame() {
        guard !captureInFlight, streamTimer != nil, connection != nil else { return }
        captureInFlight = true
        do {
            let capture = try controller.screenshot(preview: true)
            let pixelBuffer = try PixelBufferFactory.make(
                from: capture.image,
                maximumLongEdge: streamMaximumLongEdge
            )
            try encoder.encode(pixelBuffer) { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    self.captureInFlight = false
                    guard self.streamTimer != nil else { return }
                    switch result {
                    case .success(let encoded):
                        if let configuration = encoded.configuration {
                            self.send(RunnerFrame(kind: .h264Configuration, payload: configuration))
                        }
                        var payload = Data()
                        payload.appendBigEndian(capture.timestampMicros)
                        payload.append(encoded.keyframe ? 1 : 0)
                        payload.append(encoded.bytes)
                        self.send(RunnerFrame(kind: .h264Frame, payload: payload))
                        self.streamedFrameCount += 1
                        self.adaptStreamIfNeeded()
                    case .failure:
                        self.encoder.forceKeyframe()
                    }
                }
            }
        } catch {
            captureInFlight = false
        }
    }

    private func adaptStreamIfNeeded() {
        guard
            let startedAt = streamStartedAt,
            let lastAdaptationAt,
            streamMaximumLongEdge > 960
        else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - startedAt >= 5, now - lastAdaptationAt >= 5 else { return }
        let average = Double(streamedFrameCount) / max(0.001, now - startedAt)
        let floor = Double(min(streamFPS, 30))
        guard average < floor else { return }
        streamMaximumLongEdge = max(960, Int(Double(streamMaximumLongEdge) * 0.8))
        streamBitrate = max(1_000_000, Int(Double(streamBitrate) * 0.8))
        encoder.configure(bitrate: streamBitrate, frameRate: streamFPS)
        self.lastAdaptationAt = now
    }

    private func selector(_ params: [String: JSONValue]) throws -> [String: JSONValue] {
        guard let selector = params["selector"]?.objectValue else {
            throw RunnerError("SELECTOR_REQUIRED", "selector is required")
        }
        return selector
    }

    private func directPoint(_ params: [String: JSONValue]) throws -> CGPoint {
        guard
            let x = params["x"]?.doubleValue,
            let y = params["y"]?.doubleValue,
            (0...1).contains(x),
            (0...1).contains(y)
        else {
            throw RunnerError("POINT_INVALID", "x and y must be normalized values")
        }
        return CGPoint(x: x, y: y)
    }

    private func sendSuccess(id: String, result: [String: Any]) {
        do {
            send(
                RunnerFrame(
                    kind: .response,
                    payload: try jsonData(["id": id, "ok": true, "result": result])
                )
            )
        } catch {
            disconnectCurrentConnection()
        }
    }

    private func sendFailure(id: String, error: Error) {
        let runnerError =
            error as? RunnerError
            ?? RunnerError("RUNNER_OPERATION_FAILED", error.localizedDescription)
        do {
            send(
                RunnerFrame(
                    kind: .response,
                    payload: try jsonData([
                        "id": id,
                        "ok": false,
                        "error": runnerError.dictionary,
                    ])
                )
            )
        } catch {
            disconnectCurrentConnection()
        }
    }

    private func send(_ frame: RunnerFrame) {
        guard frame.payload.count <= RunnerProtocol.maximumResponsePayload else {
            disconnectCurrentConnection()
            return
        }
        connection?.send(
            content: frame.encoded,
            completion: .contentProcessed { [weak self] error in
                guard error != nil else { return }
                Task { @MainActor in self?.disconnectCurrentConnection() }
            }
        )
    }

    private func constantTimeEqual(_ lhs: [UInt8], _ rhs: [UInt8]) -> Bool {
        let length = max(lhs.count, rhs.count)
        var difference: UInt8 = 0
        for index in 0..<length {
            let left = index < lhs.count ? lhs[index] : 0
            let right = index < rhs.count ? rhs[index] : 0
            difference |= left ^ right
        }
        return difference == 0 && lhs.count == rhs.count
    }
}
