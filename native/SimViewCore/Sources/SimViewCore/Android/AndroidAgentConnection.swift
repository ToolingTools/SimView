import Darwin
import Foundation

final class AndroidAgentConnection: @unchecked Sendable {
    typealias ConfigurationHandler = @Sendable (Data) -> Void
    typealias FrameHandler = @Sendable (UInt64, Bool, Data) -> Void
    typealias FailureHandler = @Sendable (Error) -> Void

    private static let magic: UInt32 = 0x5356_4131
    private static let maximumPayload = 32 * 1024 * 1024

    private let lifecycle: AndroidAgentLifecycle
    private let token: String
    private let writeLock = NSLock()
    private let stateLock = NSLock()
    private let acknowledgement = NSCondition()
    private var pendingAcknowledgement: UInt8?
    private var acknowledgementError: String?
    private var fd: Int32 = -1
    private var stopped = false
    private let readerQueue = DispatchQueue(label: "dev.simview.android.agent.reader", qos: .userInteractive)
    private let onConfiguration: ConfigurationHandler
    private let onFrame: FrameHandler
    private let onFailure: FailureHandler

    init(
        lifecycle: AndroidAgentLifecycle,
        token: String,
        onConfiguration: @escaping ConfigurationHandler,
        onFrame: @escaping FrameHandler,
        onFailure: @escaping FailureHandler
    ) {
        self.lifecycle = lifecycle
        self.token = token
        self.onConfiguration = onConfiguration
        self.onFrame = onFrame
        self.onFailure = onFailure
    }

    deinit { stop() }

    func connect(port: Int, timeout: TimeInterval = 5) throws {
        let deadline = Date().addingTimeInterval(timeout)
        var lastError = "Connection refused"
        repeat {
            let candidate = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard candidate >= 0 else {
                throw SimViewError("ANDROID_AGENT_SOCKET_FAILED", String(cString: strerror(errno)))
            }
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(port).bigEndian
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
            let status = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(candidate, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            if status == 0 {
                fd = candidate
                do {
                    try authenticate()
                    readerQueue.async { [weak self] in self?.readEvents() }
                    return
                } catch {
                    lastError = (error as? SimViewError)?.message ?? error.localizedDescription
                    Darwin.close(candidate)
                    fd = -1
                    Thread.sleep(forTimeInterval: 0.05)
                    continue
                }
            }
            lastError = String(cString: strerror(errno))
            Darwin.close(candidate)
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        throw SimViewError("ANDROID_AGENT_CONNECT_FAILED", lastError)
    }

    func startCapture(width: Int, height: Int, bitrate: Int = 8_000_000, frameRate: Int = 60) throws {
        var command = Data([0x10])
        command.appendBigEndian(UInt32(width))
        command.appendBigEndian(UInt32(height))
        command.appendBigEndian(UInt32(bitrate))
        command.appendBigEndian(UInt32(frameRate))
        try sendCommand(command)
    }

    func requestKeyframe() throws { try sendCommand(Data([0x11])) }

    func touch(phase: String, x: Double, y: Double, width: Int, height: Int) throws {
        let phaseValue: UInt8
        switch phase {
        case "down": phaseValue = 0
        case "move": phaseValue = 1
        case "up": phaseValue = 2
        case "cancel": phaseValue = 3
        default: throw SimViewError("PARAMETER_INVALID", "Unknown touch phase \(phase)")
        }
        var command = Data([0x20, phaseValue])
        command.appendFloat(Float(x * Double(max(1, width - 1))))
        command.appendFloat(Float(y * Double(max(1, height - 1))))
        try sendCommand(command)
    }

    func tap(x: Double, y: Double, duration: Double, width: Int, height: Int) throws {
        var command = Data([0x21])
        command.appendFloat(Float(x * Double(max(1, width - 1))))
        command.appendFloat(Float(y * Double(max(1, height - 1))))
        command.appendBigEndian(UInt32(max(1, Int(duration * 1_000))))
        try sendCommand(command)
    }

    func swipe(
        fromX: Double, fromY: Double, toX: Double, toY: Double, duration: Double,
        width: Int, height: Int
    ) throws {
        let steps = max(2, min(120, Int(duration * 60)))
        try touch(phase: "down", x: fromX, y: fromY, width: width, height: height)
        for index in 1..<steps {
            let progress = Double(index) / Double(steps)
            try touch(
                phase: "move",
                x: fromX + (toX - fromX) * progress,
                y: fromY + (toY - fromY) * progress,
                width: width,
                height: height
            )
            Thread.sleep(forTimeInterval: duration / Double(steps))
        }
        try touch(phase: "up", x: toX, y: toY, width: width, height: height)
    }

    func typeText(_ text: String) throws -> String {
        guard text.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7E }) else {
            throw SimViewError("INPUT_TEXT_UNSUPPORTED", "The Android agent currently supports ASCII text")
        }
        let bytes = Data(text.utf8)
        guard bytes.count <= Int(UInt16.max) else {
            throw SimViewError("PARAMETER_INVALID", "Text input exceeds the Android agent limit")
        }
        var command = Data([0x22])
        command.appendBigEndian(UInt16(bytes.count))
        command.append(bytes)
        try sendCommand(command)
        return "android-key-character-map"
    }

    func pressButton(_ button: String) throws {
        let value: UInt8
        switch button {
        case "back": value = 0
        case "home": value = 1
        case "overview", "appSwitch": value = 2
        case "lock", "power": value = 3
        case "volume-up", "volumeUp": value = 4
        case "volume-down", "volumeDown": value = 5
        default: throw SimViewError("INPUT_BUTTON_UNSUPPORTED", "Android does not support button \(button)")
        }
        try sendCommand(Data([0x23, value]))
    }

    func stop() {
        stateLock.lock()
        let shouldStop = !stopped
        stopped = true
        let socket = fd
        fd = -1
        stateLock.unlock()
        guard shouldStop else { return }
        if socket >= 0 {
            _ = try? sendTo(socket, data: Data([0x7F]))
            Darwin.shutdown(socket, SHUT_RDWR)
            Darwin.close(socket)
        }
        lifecycle.stop()
    }

    var diagnostics: String? { lifecycle.lastDiagnostics }

    private func authenticate() throws {
        var request = Data()
        request.appendBigEndian(Self.magic)
        request.appendBigEndian(UInt32(AndroidAgentLifecycle.protocolVersion))
        request.appendBigEndian(UInt32(token.utf8.count))
        request.append(Data(token.utf8))
        try send(request)
        let response = try readExactly(12)
        try AndroidAgentHandshake.validate(response)
    }

    private func readEvents() {
        do {
            while !isStopped {
                let event = try readExactly(1)[0]
                switch event {
                case 0x40:
                    let first = try readLengthPrefixedData()
                    let second = try readLengthPrefixedData()
                    onConfiguration(try H264Normalizer.configuration(csd0: first, csd1: second))
                case 0x41:
                    let header = try readExactly(13)
                    let timestamp = header.uint64(at: 0)
                    let keyframe = header[8] != 0
                    let length = Int(header.uint32(at: 9))
                    guard length <= Self.maximumPayload else {
                        throw SimViewError("ANDROID_AGENT_FRAME_TOO_LARGE", "Android frame exceeds 32 MiB")
                    }
                    onFrame(timestamp, keyframe, try H264Normalizer.accessUnit(try readExactly(length)))
                case 0x42:
                    let response = try readExactly(2)
                    let command = response[0]
                    let message = response[1] == 0 ? nil : try readJavaUTF()
                    acknowledgement.lock()
                    guard pendingAcknowledgement == command else {
                        acknowledgement.unlock()
                        throw SimViewError(
                            "ANDROID_AGENT_PROTOCOL_INVALID",
                            "Unexpected acknowledgement for command \(command)"
                        )
                    }
                    acknowledgementError = message
                    pendingAcknowledgement = nil
                    acknowledgement.broadcast()
                    acknowledgement.unlock()
                case 0x4F:
                    let message = try readJavaUTF()
                    throw SimViewError("ANDROID_AGENT_CAPTURE_FAILED", message)
                default:
                    throw SimViewError("ANDROID_AGENT_PROTOCOL_INVALID", "Unknown Android agent event \(event)")
                }
            }
        } catch {
            if !isStopped {
                acknowledgement.lock()
                acknowledgementError =
                    (error as? SimViewError)?.message ?? error.localizedDescription
                pendingAcknowledgement = nil
                acknowledgement.broadcast()
                acknowledgement.unlock()
                onFailure(error)
            }
        }
    }

    private var isStopped: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopped
    }

    private func readLengthPrefixedData() throws -> Data {
        let length = Int(try readExactly(4).uint32(at: 0))
        guard length <= Self.maximumPayload else {
            throw SimViewError("ANDROID_AGENT_FRAME_TOO_LARGE", "Android payload exceeds 32 MiB")
        }
        return try readExactly(length)
    }

    private func readJavaUTF() throws -> String {
        let length = Int(try readExactly(2).uint16(at: 0))
        return String(data: try readExactly(length), encoding: .utf8) ?? "Android agent failed"
    }

    private func readExactly(_ count: Int) throws -> Data {
        guard count >= 0 else { throw SimViewError("ANDROID_AGENT_PROTOCOL_INVALID", "Negative payload size") }
        if count == 0 { return Data() }
        var result = Data(count: count)
        var offset = 0
        while offset < count {
            let read = result.withUnsafeMutableBytes { raw in
                Darwin.recv(fd, raw.baseAddress!.advanced(by: offset), count - offset, 0)
            }
            if read < 0, errno == EINTR { continue }
            guard read > 0 else {
                let reason = read == 0 ? "peer closed the socket" : String(cString: strerror(errno))
                throw SimViewError(
                    "ANDROID_AGENT_DISCONNECTED",
                    "The Android agent disconnected: \(reason)"
                )
            }
            offset += read
        }
        return result
    }

    private func send(_ data: Data) throws {
        writeLock.lock()
        defer { writeLock.unlock() }
        try sendTo(fd, data: data)
    }

    private func sendCommand(_ data: Data, timeout: TimeInterval = 3) throws {
        guard let command = data.first else {
            throw SimViewError("ANDROID_AGENT_PROTOCOL_INVALID", "Android agent command is empty")
        }
        writeLock.lock()
        defer { writeLock.unlock() }
        acknowledgement.lock()
        pendingAcknowledgement = command
        acknowledgementError = nil
        acknowledgement.unlock()
        do {
            try sendTo(fd, data: data)
        } catch {
            acknowledgement.lock()
            pendingAcknowledgement = nil
            acknowledgement.unlock()
            throw error
        }
        acknowledgement.lock()
        let deadline = Date().addingTimeInterval(timeout)
        while pendingAcknowledgement != nil, acknowledgement.wait(until: deadline) {}
        let error = acknowledgementError
        let timedOut = pendingAcknowledgement != nil
        pendingAcknowledgement = nil
        acknowledgement.unlock()
        if timedOut {
            throw SimViewError(
                "ANDROID_AGENT_COMMAND_TIMEOUT",
                "Android agent did not acknowledge command \(command)"
            )
        }
        if let error {
            throw SimViewError("ANDROID_INPUT_REJECTED", error)
        }
    }

    private func sendTo(_ socket: Int32, data: Data) throws {
        guard socket >= 0 else { throw SimViewError("ANDROID_AGENT_DISCONNECTED", "Android agent is not connected") }
        let sent = data.withUnsafeBytes { raw -> Bool in
            guard var base = raw.baseAddress else { return data.isEmpty }
            var remaining = raw.count
            while remaining > 0 {
                let count = Darwin.send(socket, base, remaining, MSG_NOSIGNAL)
                if count < 0, errno == EINTR { continue }
                if count <= 0 { return false }
                base = base.advanced(by: count)
                remaining -= count
            }
            return true
        }
        guard sent else { throw SimViewError("ANDROID_AGENT_DISCONNECTED", "Could not write to Android agent") }
    }
}

enum H264Normalizer {
    static func configuration(csd0: Data, csd1: Data) throws -> Data {
        let first = nalUnits(csd0)
        let second = nalUnits(csd1)
        guard let sps = (first + second).first(where: { ($0.first ?? 0) & 0x1F == 7 }),
            let pps = (first + second).first(where: { ($0.first ?? 0) & 0x1F == 8 }),
            sps.count >= 4, sps.count <= Int(UInt16.max), pps.count <= Int(UInt16.max)
        else {
            throw SimViewError(
                "ANDROID_H264_CONFIGURATION_INVALID", "Android encoder returned invalid AVC configuration")
        }
        var result = Data([1, sps[1], sps[2], sps[3], 0xFF, 0xE1])
        result.appendBigEndian(UInt16(sps.count))
        result.append(sps)
        result.append(1)
        result.appendBigEndian(UInt16(pps.count))
        result.append(pps)
        return result
    }

    static func accessUnit(_ data: Data) throws -> Data {
        if isValidAVCC(data) { return data }
        let units = nalUnits(data)
        guard !units.isEmpty else {
            throw SimViewError("ANDROID_H264_FRAME_INVALID", "Android encoder returned an empty AVC frame")
        }
        var result = Data()
        result.reserveCapacity(data.count + units.count * 4)
        for unit in units {
            result.appendBigEndian(UInt32(unit.count))
            result.append(unit)
        }
        return result
    }

    static func nalUnits(_ data: Data) -> [Data] {
        if let units = avccUnits(data) { return units }
        var starts: [(offset: Int, prefix: Int)] = []
        let bytes = [UInt8](data)
        var index = 0
        while index + 3 < bytes.count {
            if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 {
                starts.append((index, 3))
                index += 3
            } else if index + 4 <= bytes.count, bytes[index] == 0, bytes[index + 1] == 0,
                bytes[index + 2] == 0, bytes[index + 3] == 1
            {
                starts.append((index, 4))
                index += 4
            } else {
                index += 1
            }
        }
        if starts.isEmpty { return data.isEmpty ? [] : [data] }
        return starts.enumerated().compactMap { position, start in
            let lower = start.offset + start.prefix
            let upper = position + 1 < starts.count ? starts[position + 1].offset : data.count
            return lower < upper ? data.subdata(in: lower..<upper) : nil
        }
    }

    private static func avccUnits(_ data: Data) -> [Data]? {
        var result: [Data] = []
        var offset = 0
        while offset + 4 <= data.count {
            let length = Int(data.uint32(at: offset))
            guard length > 0, offset + 4 + length <= data.count else { return nil }
            result.append(data.subdata(in: (offset + 4)..<(offset + 4 + length)))
            offset += 4 + length
        }
        return offset == data.count && !result.isEmpty ? result : nil
    }

    private static func isValidAVCC(_ data: Data) -> Bool {
        var offset = 0
        var count = 0
        while offset + 4 <= data.count {
            let length = Int(data.uint32(at: offset))
            guard length > 0, offset + 4 + length <= data.count else { return false }
            offset += 4 + length
            count += 1
        }
        return count > 0 && offset == data.count
    }
}

enum AndroidAgentHandshake {
    static func validate(_ response: Data) throws {
        guard response.count == 12,
            response.uint32(at: 0) == 0x5356_4131,
            response.uint32(at: 4) == UInt32(AndroidAgentLifecycle.protocolVersion),
            response.uint32(at: 8) == 0
        else {
            throw SimViewError(
                "ANDROID_AGENT_AUTHENTICATION_FAILED",
                "The Android agent rejected the protocol version or token",
                recoverable: false
            )
        }
    }
}

private extension Data {
    mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
        var bigEndian = value.bigEndian
        Swift.withUnsafeBytes(of: &bigEndian) { append(contentsOf: $0) }
    }

    mutating func appendFloat(_ value: Float) { appendBigEndian(value.bitPattern) }

    func uint16(at offset: Int) -> UInt16 {
        subdata(in: offset..<(offset + 2)).withUnsafeBytes { $0.loadUnaligned(as: UInt16.self).bigEndian }
    }

    func uint32(at offset: Int) -> UInt32 {
        subdata(in: offset..<(offset + 4)).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
    }

    func uint64(at offset: Int) -> UInt64 {
        subdata(in: offset..<(offset + 8)).withUnsafeBytes { $0.loadUnaligned(as: UInt64.self).bigEndian }
    }
}
