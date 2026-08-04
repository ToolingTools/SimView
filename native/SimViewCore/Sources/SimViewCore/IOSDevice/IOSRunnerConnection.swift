import Darwin
import Foundation

final class IOSRunnerConnection: @unchecked Sendable {
    typealias ConfigurationHandler = @Sendable (Data) -> Void
    typealias FrameHandler = @Sendable (UInt64, Bool, Data) -> Void
    typealias FailureHandler = @Sendable (Error) -> Void

    static let protocolVersion = 1
    private static let maximumControlPayload = 4 * 1024 * 1024
    private static let maximumRunnerPayload = 64 * 1024 * 1024

    private final class Pending: @unchecked Sendable {
        let semaphore = DispatchSemaphore(value: 0)
        var result: [String: Any]?
        var error: Error?
    }

    private let writeLock = NSLock()
    private let stateLock = NSLock()
    private let pendingLock = NSLock()
    private var pending: [String: Pending] = [:]
    private var fd: Int32 = -1
    private var stopped = false
    private var nextRequestID: UInt64 = 1
    private let readerQueue = DispatchQueue(label: "dev.simview.ios.runner.reader", qos: .userInteractive)
    private let onConfiguration: ConfigurationHandler
    private let onFrame: FrameHandler
    private let onFailure: FailureHandler

    init(
        onConfiguration: @escaping ConfigurationHandler,
        onFrame: @escaping FrameHandler,
        onFailure: @escaping FailureHandler
    ) {
        self.onConfiguration = onConfiguration
        self.onFrame = onFrame
        self.onFailure = onFailure
    }

    deinit { stop(sendShutdown: false) }

    func connect(udid: String, port: UInt16, token: String, timeout: TimeInterval = 10) throws {
        guard token.utf8.count >= 32 else {
            throw SimViewError("TOKEN_INVALID", "The iOS runner token must contain at least 32 bytes")
        }
        let tunnel = try USBMuxClient(timeout: timeout).connect(udid: udid, port: port)
        fd = try tunnel.takeDescriptor()
        readerQueue.async { [weak self] in self?.readFrames() }
        do {
            let result = try request("authenticate", params: ["token": token], timeout: timeout)
            guard (result["protocolVersion"] as? NSNumber)?.intValue == Self.protocolVersion,
                result["source"] as? String == "ios-xcui"
            else {
                throw SimViewError(
                    "IOS_RUNNER_PROTOCOL_UNSUPPORTED",
                    "The iOS runner returned an incompatible protocol version",
                    recoverable: false
                )
            }
        } catch {
            stop(sendShutdown: false)
            throw error
        }
    }

    func health() throws -> [String: Any] { try request("health") }

    func selectApp(_ bundleID: String) throws -> [String: Any] {
        try request("selectApp", params: ["bundleId": bundleID])
    }

    func screenshot(quality: String = "full") throws -> (data: Data, metadata: [String: Any]) {
        let result = try request("screenshot", params: ["quality": quality], timeout: 15)
        guard result["format"] as? String == "png",
            let encoded = result["data"] as? String,
            let bytes = Data(base64Encoded: encoded),
            bytes.count <= Self.maximumRunnerPayload
        else {
            throw SimViewError("IOS_RUNNER_SCREENSHOT_INVALID", "The iOS runner returned an invalid PNG")
        }
        return (bytes, result)
    }

    func snapshot(maxDepth: Int? = nil, maxChildren: Int? = nil) throws -> [String: Any] {
        var params: [String: Any] = [:]
        if let maxDepth { params["maxDepth"] = maxDepth }
        if let maxChildren { params["maxChildren"] = maxChildren }
        return try request("snapshot", params: params, timeout: 15)
    }

    func elementAtPoint(x: Double, y: Double) throws -> [String: Any] {
        try request("elementAtPoint", params: ["x": x, "y": y], timeout: 10)
    }

    func find(selector: [String: Any], timeout: TimeInterval? = nil) throws -> [String: Any] {
        var params: [String: Any] = ["selector": selector]
        if let timeout { params["timeout"] = timeout }
        return try request("find", params: params, timeout: (timeout ?? 5) + 2)
    }

    func wait(selector: [String: Any], exists: Bool, timeout: TimeInterval) throws -> [String: Any] {
        try request(
            "wait",
            params: ["selector": selector, "exists": exists, "timeout": timeout],
            timeout: timeout + 2
        )
    }

    func tap(x: Double, y: Double, duration: Double? = nil) throws {
        var params: [String: Any] = ["x": x, "y": y]
        if let duration { params["duration"] = duration }
        _ = try request("tap", params: params)
    }

    func longPress(x: Double, y: Double, duration: Double) throws {
        _ = try request("longPress", params: ["x": x, "y": y, "duration": duration])
    }

    func swipe(
        fromX: Double, fromY: Double, toX: Double, toY: Double, duration: Double
    ) throws {
        _ = try request(
            "swipe",
            params: [
                "from": ["x": fromX, "y": fromY],
                "to": ["x": toX, "y": toY],
                "duration": duration,
            ]
        )
    }

    func typeText(_ text: String) throws {
        _ = try request("typeText", params: ["text": text])
    }

    func pressButton(_ button: String) throws {
        _ = try request("pressButton", params: ["button": button])
    }

    func setOrientation(_ orientation: String) throws {
        _ = try request("setOrientation", params: ["orientation": orientation])
    }

    func activateApp() throws { _ = try request("activateApp") }
    func terminateApp() throws { _ = try request("terminateApp") }

    func startStream(
        framesPerSecond: Int = 60,
        maxLongEdge: Int = 1_600,
        bitrate: Int = 8_000_000
    ) throws -> [String: Any] {
        try request(
            "startStream",
            params: [
                "fps": framesPerSecond,
                "maxLongEdge": maxLongEdge,
                "bitrate": bitrate,
            ],
            timeout: 15
        )
    }

    func stopStream() throws { _ = try request("stopStream") }
    func requestKeyframe() throws { _ = try request("requestKeyframe") }

    func stop(sendShutdown: Bool = true) {
        stateLock.lock()
        let shouldStop = !stopped
        stateLock.unlock()
        guard shouldStop else { return }
        if sendShutdown { _ = try? request("shutdown", timeout: 1) }

        stateLock.lock()
        stopped = true
        let socket = fd
        fd = -1
        stateLock.unlock()
        if socket >= 0 {
            Darwin.shutdown(socket, SHUT_RDWR)
            Darwin.close(socket)
        }
        failPending(SimViewError("IOS_RUNNER_DISCONNECTED", "The iOS runner connection closed"))
    }

    private func request(
        _ method: String,
        params: [String: Any] = [:],
        timeout: TimeInterval = 5
    ) throws -> [String: Any] {
        let requestID = allocateRequestID()
        let waiter = Pending()
        pendingLock.lock()
        pending[requestID] = waiter
        pendingLock.unlock()
        do {
            let payload = try JSONSerialization.data(
                withJSONObject: [
                    "id": requestID,
                    "protocolVersion": Self.protocolVersion,
                    "method": method,
                    "params": params,
                ],
                options: [.sortedKeys]
            )
            guard payload.count <= Self.maximumControlPayload else {
                throw SimViewError("IOS_RUNNER_REQUEST_TOO_LARGE", "The iOS runner request exceeds 4 MiB")
            }
            try send(kind: 0x01, payload: payload)
        } catch {
            pendingLock.lock()
            pending.removeValue(forKey: requestID)
            pendingLock.unlock()
            throw error
        }
        guard waiter.semaphore.wait(timeout: .now() + timeout) == .success else {
            pendingLock.lock()
            pending.removeValue(forKey: requestID)
            pendingLock.unlock()
            throw SimViewError("IOS_RUNNER_TIMEOUT", "The iOS runner timed out while handling \(method)")
        }
        if let error = waiter.error { throw error }
        guard let result = waiter.result else {
            throw SimViewError("IOS_RUNNER_PROTOCOL_INVALID", "The iOS runner returned an empty response")
        }
        return result
    }

    private func allocateRequestID() -> String {
        stateLock.lock()
        defer { stateLock.unlock() }
        let value = nextRequestID
        nextRequestID &+= 1
        return "host-\(value)"
    }

    private func send(kind: UInt8, payload: Data) throws {
        stateLock.lock()
        let socket = fd
        let unavailable = stopped || socket < 0
        stateLock.unlock()
        guard !unavailable else {
            throw SimViewError("IOS_RUNNER_DISCONNECTED", "The iOS runner is not connected")
        }
        var frame = Data([kind])
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        frame.append(payload)
        writeLock.lock()
        defer { writeLock.unlock() }
        let success = frame.withUnsafeBytes { raw -> Bool in
            guard var pointer = raw.baseAddress else { return frame.isEmpty }
            var remaining = raw.count
            while remaining > 0 {
                let written = Darwin.send(socket, pointer, remaining, MSG_NOSIGNAL)
                if written < 0, errno == EINTR { continue }
                if written <= 0 { return false }
                pointer = pointer.advanced(by: written)
                remaining -= written
            }
            return true
        }
        guard success else {
            throw SimViewError("IOS_RUNNER_DISCONNECTED", "Could not write to the iOS runner")
        }
    }

    private func readFrames() {
        do {
            while !isStopped {
                let header = try readExactly(5)
                let kind = header[0]
                let length = Int(
                    header.subdata(in: 1..<5).withUnsafeBytes {
                        $0.loadUnaligned(as: UInt32.self).bigEndian
                    })
                let maximum = kind == 0x02 ? Self.maximumRunnerPayload : Self.maximumRunnerPayload
                guard length <= maximum else {
                    throw SimViewError("IOS_RUNNER_FRAME_TOO_LARGE", "The iOS runner frame exceeds 64 MiB")
                }
                let payload = try readExactly(length)
                switch kind {
                case 0x02:
                    try acceptResponse(payload)
                case 0x10:
                    onConfiguration(payload)
                case 0x11:
                    guard payload.count >= 9 else {
                        throw SimViewError("IOS_RUNNER_PROTOCOL_INVALID", "The iOS runner sent an invalid H.264 frame")
                    }
                    let timestamp = payload.subdata(in: 0..<8).withUnsafeBytes {
                        $0.loadUnaligned(as: UInt64.self).bigEndian
                    }
                    onFrame(timestamp, payload[8] != 0, Data(payload.dropFirst(9)))
                default:
                    throw SimViewError("IOS_RUNNER_PROTOCOL_INVALID", "Unknown iOS runner frame kind \(kind)")
                }
            }
        } catch {
            if !isStopped {
                failPending(error)
                onFailure(error)
            }
        }
    }

    private func acceptResponse(_ data: Data) throws {
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let requestID = response["id"] as? String,
            let ok = response["ok"] as? Bool
        else {
            throw SimViewError("IOS_RUNNER_PROTOCOL_INVALID", "The iOS runner returned malformed JSON")
        }
        pendingLock.lock()
        let waiter = pending.removeValue(forKey: requestID)
        pendingLock.unlock()
        guard let waiter else { return }
        if ok {
            waiter.result = response["result"] as? [String: Any] ?? [:]
        } else if let value = response["error"] as? [String: Any] {
            waiter.error = SimViewError(
                value["code"] as? String ?? "IOS_RUNNER_ERROR",
                value["message"] as? String ?? "The iOS runner rejected the request",
                recoverable: value["recoverable"] as? Bool ?? true
            )
        } else {
            waiter.error = SimViewError("IOS_RUNNER_PROTOCOL_INVALID", "The iOS runner returned an invalid error")
        }
        waiter.semaphore.signal()
    }

    private func readExactly(_ count: Int) throws -> Data {
        stateLock.lock()
        let socket = fd
        stateLock.unlock()
        guard socket >= 0 else {
            throw SimViewError("IOS_RUNNER_DISCONNECTED", "The iOS runner is not connected")
        }
        var result = Data(count: count)
        var offset = 0
        while offset < count {
            let read = result.withUnsafeMutableBytes { raw in
                Darwin.recv(socket, raw.baseAddress!.advanced(by: offset), count - offset, 0)
            }
            if read < 0, errno == EINTR { continue }
            guard read > 0 else {
                let reason = read == 0 ? "connection closed" : String(cString: strerror(errno))
                throw SimViewError("IOS_RUNNER_DISCONNECTED", "The iOS runner disconnected: \(reason)")
            }
            offset += read
        }
        return result
    }

    private var isStopped: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopped
    }

    private func failPending(_ error: Error) {
        pendingLock.lock()
        let values = Array(pending.values)
        pending.removeAll()
        pendingLock.unlock()
        for waiter in values {
            waiter.error = error
            waiter.semaphore.signal()
        }
    }
}
