import Darwin
import Foundation

private let xctestProviderProtocolVersion = 1
private let xctestProviderMaximumFrameBytes = 16 * 1_024 * 1_024

struct XCTestProviderArtifacts: Sendable {
    let xctestrunURL: URL
    let productsURL: URL

    static func locate(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        executableURL: URL = URL(fileURLWithPath: CommandLine.arguments[0])
    ) -> XCTestProviderArtifacts? {
        let fileManager = FileManager.default
        let candidates: [URL] = [
            environment["SIMVIEW_XCTEST_PROVIDER_XCTESTRUN"].map {
                URL(fileURLWithPath: $0)
            },
            executableURL.deletingLastPathComponent().appendingPathComponent(
                "xctest-provider/SimViewXCTestProvider.xctestrun"
            ),
        ].compactMap { $0 }
        guard let xctestrunURL = candidates.first(where: { fileManager.fileExists(atPath: $0.path) })
        else { return nil }
        return XCTestProviderArtifacts(
            xctestrunURL: xctestrunURL,
            productsURL: xctestrunURL.deletingLastPathComponent().appendingPathComponent(
                "Debug-iphonesimulator"
            )
        )
    }
}

enum XCTestProviderConfiguration {
    static func configuredXCTestRun(
        source: Data,
        artifacts: XCTestProviderArtifacts,
        targetBundleID: String,
        port: UInt16,
        token: String
    ) throws -> Data {
        guard
            var root = try PropertyListSerialization.propertyList(from: source, options: [], format: nil)
                as? [String: Any]
        else { throw providerError("XCTEST_CONFIGURATION_INVALID", "Invalid xctestrun plist") }

        root = replaceTestPaths(in: root, artifacts: artifacts) as? [String: Any] ?? root
        guard let key = root.keys.first(where: { $0 != "__xctestrun_metadata__" }),
            var configuration = root[key] as? [String: Any]
        else { throw providerError("XCTEST_CONFIGURATION_INVALID", "No XCTest target found") }

        var environment = configuration["EnvironmentVariables"] as? [String: String] ?? [:]
        environment["SIMVIEW_XCTEST_MODE"] = "persistent"
        environment["SIMVIEW_XCTEST_TARGET_BUNDLE_ID"] = targetBundleID
        environment["SIMVIEW_XCTEST_PORT"] = String(port)
        environment["SIMVIEW_XCTEST_TOKEN"] = token
        environment.removeValue(forKey: "SIMVIEW_XCTEST_CAPTURE_COUNT")
        configuration["EnvironmentVariables"] = environment
        configuration["DefaultTestExecutionTimeAllowance"] = 86_400
        root[key] = configuration
        return try PropertyListSerialization.data(
            fromPropertyList: root,
            format: .binary,
            options: 0
        )
    }

    private static func replaceTestPaths(
        in value: Any,
        artifacts: XCTestProviderArtifacts
    ) -> Any {
        switch value {
        case let dictionary as [String: Any]:
            return dictionary.mapValues { replaceTestPaths(in: $0, artifacts: artifacts) }
        case let values as [Any]:
            return values.map { replaceTestPaths(in: $0, artifacts: artifacts) }
        case let text as String:
            let testRoot = artifacts.xctestrunURL.deletingLastPathComponent().path
            let testHost = artifacts.productsURL
                .appendingPathComponent("SimViewXCTestProbeUITests-Runner.app").path
            return
                text
                .replacingOccurrences(of: "__TESTROOT__", with: testRoot)
                .replacingOccurrences(of: "__TESTHOST__", with: testHost)
        default:
            return value
        }
    }
}

final class XCTestAccessibilityProviderSession: IOSAccessibilityProviding, @unchecked Sendable {
    let kind = IOSAccessibilityProviderKind.xctest
    let status = IOSAccessibilityProviderStatus(kind: .xctest, availability: .ready, reason: nil)

    private let lock = NSLock()
    private let connection: Int32
    private let process: Process
    private let configuredXCTestRunURL: URL
    private var nextRequestID = 0
    private var stopped = false

    static func availability(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> IOSAccessibilityProviderStatus {
        guard XCTestProviderArtifacts.locate(environment: environment) != nil else {
            return IOSAccessibilityProviderStatus(
                kind: .xctest,
                availability: .unavailable,
                reason: "xctest-provider-artifacts-missing"
            )
        }
        return IOSAccessibilityProviderStatus(kind: .xctest, availability: .ready, reason: nil)
    }

    static func start(
        udid: String,
        targetBundleID: String,
        artifacts: XCTestProviderArtifacts? = XCTestProviderArtifacts.locate(),
        startupTimeout: TimeInterval = 30
    ) throws -> XCTestAccessibilityProviderSession {
        guard let artifacts else {
            throw providerError(
                "XCTEST_PROVIDER_UNAVAILABLE",
                "Packaged XCTest provider artifacts are missing"
            )
        }
        let listener = try LoopbackListener()
        let token =
            UUID().uuidString.replacingOccurrences(of: "-", with: "")
            + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let source = try Data(contentsOf: artifacts.xctestrunURL)
        let configured = try XCTestProviderConfiguration.configuredXCTestRun(
            source: source,
            artifacts: artifacts,
            targetBundleID: targetBundleID,
            port: listener.port,
            token: token
        )
        let temporaryURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            "simview-xctest-\(UUID().uuidString).xctestrun"
        )
        try configured.write(to: temporaryURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: temporaryURL.path
        )

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = [
            "xcodebuild", "test-without-building",
            "-xctestrun", temporaryURL.path,
            "-destination", "platform=iOS Simulator,id=\(udid)",
            "-only-testing:SimViewXCTestProbeUITests/XCTestSnapshotProbe/testSnapshotArbitraryApplication",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let connection = try listener.accept(timeout: startupTimeout)
            let hello = try XCTestProviderMessageCodec.read(from: connection, timeout: startupTimeout)
            guard
                hello["type"] as? String == "hello",
                (hello["protocolVersion"] as? NSNumber)?.intValue == xctestProviderProtocolVersion,
                let receivedToken = hello["token"] as? String,
                constantTimeEqual(receivedToken, token)
            else {
                Darwin.close(connection)
                throw providerError("XCTEST_AUTHENTICATION_FAILED", "Invalid XCTest provider hello")
            }
            return XCTestAccessibilityProviderSession(
                connection: connection,
                process: process,
                configuredXCTestRunURL: temporaryURL
            )
        } catch {
            if process.isRunning { process.terminate() }
            try? FileManager.default.removeItem(at: temporaryURL)
            throw error
        }
    }

    private init(connection: Int32, process: Process, configuredXCTestRunURL: URL) {
        self.connection = connection
        self.process = process
        self.configuredXCTestRunURL = configuredXCTestRunURL
    }

    deinit { stop() }

    func snapshot(maxNodes: Int, timeout: TimeInterval) throws -> [String: Any] {
        try request(
            method: "snapshot",
            parameters: ["maxNodes": max(1, min(maxNodes, 5_000))],
            timeout: timeout
        )
    }

    func elementAtPoint(x: Double, y: Double, timeout: TimeInterval) throws -> [String: Any] {
        try request(
            method: "elementAtPoint",
            parameters: ["x": x, "y": y],
            timeout: timeout
        )
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        stopped = true
        if process.isRunning {
            _ = try? requestLocked(method: "shutdown", parameters: [:], timeout: 1)
        }
        Darwin.shutdown(connection, SHUT_RDWR)
        Darwin.close(connection)
        if process.isRunning { process.terminate() }
        try? FileManager.default.removeItem(at: configuredXCTestRunURL)
    }

    private func request(
        method: String,
        parameters: [String: Any],
        timeout: TimeInterval
    ) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped, process.isRunning else {
            throw providerError("XCTEST_PROVIDER_STOPPED", "XCTest provider session is stopped")
        }
        return try requestLocked(method: method, parameters: parameters, timeout: timeout)
    }

    private func requestLocked(
        method: String,
        parameters: [String: Any],
        timeout: TimeInterval
    ) throws -> [String: Any] {
        nextRequestID += 1
        let identifier = String(nextRequestID)
        var request = parameters
        request["id"] = identifier
        request["method"] = method
        try XCTestProviderMessageCodec.write(request, to: connection, timeout: timeout)
        let response = try XCTestProviderMessageCodec.read(from: connection, timeout: timeout)
        guard response["id"] as? String == identifier else {
            throw providerError("XCTEST_PROTOCOL_INVALID", "Mismatched XCTest provider response")
        }
        if let error = response["error"] as? [String: Any] {
            throw providerError(
                error["code"] as? String ?? "XCTEST_PROVIDER_ERROR",
                error["message"] as? String ?? "XCTest provider request failed"
            )
        }
        guard let result = response["result"] as? [String: Any] else {
            throw providerError("XCTEST_PROTOCOL_INVALID", "XCTest provider result is missing")
        }
        return result
    }
}

enum XCTestProviderMessageCodec {
    static func read(from descriptor: Int32, timeout: TimeInterval) throws -> [String: Any] {
        try configureTimeout(descriptor, timeout: timeout, option: SO_RCVTIMEO)
        var bytes: [UInt8] = []
        bytes.reserveCapacity(4_096)
        var byte: UInt8 = 0
        while bytes.count < xctestProviderMaximumFrameBytes {
            let count = Darwin.read(descriptor, &byte, 1)
            if count == 0 {
                throw providerError("XCTEST_PROVIDER_DISCONNECTED", "XCTest provider disconnected")
            }
            if count < 0 {
                if errno == EINTR { continue }
                throw providerError("XCTEST_PROVIDER_READ_FAILED", String(cString: strerror(errno)))
            }
            if byte == 0x0A {
                guard
                    let value = try JSONSerialization.jsonObject(with: Data(bytes)) as? [String: Any]
                else { throw providerError("XCTEST_PROTOCOL_INVALID", "Invalid JSON frame") }
                return value
            }
            bytes.append(byte)
        }
        throw providerError("XCTEST_FRAME_TOO_LARGE", "XCTest provider frame exceeded 16 MiB")
    }

    static func write(_ value: [String: Any], to descriptor: Int32, timeout: TimeInterval) throws {
        try configureTimeout(descriptor, timeout: timeout, option: SO_SNDTIMEO)
        var data = try JSONSerialization.data(withJSONObject: value)
        guard data.count < xctestProviderMaximumFrameBytes else {
            throw providerError("XCTEST_FRAME_TOO_LARGE", "XCTest provider frame exceeded 16 MiB")
        }
        data.append(0x0A)
        try data.withUnsafeBytes { rawBuffer in
            guard var pointer = rawBuffer.baseAddress else { return }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let count = Darwin.write(descriptor, pointer, remaining)
                if count < 0 {
                    if errno == EINTR { continue }
                    throw providerError("XCTEST_PROVIDER_WRITE_FAILED", String(cString: strerror(errno)))
                }
                remaining -= count
                pointer = pointer.advanced(by: count)
            }
        }
    }

    private static func configureTimeout(_ descriptor: Int32, timeout: TimeInterval, option: Int32)
        throws
    {
        var value = timeval(
            tv_sec: Int(timeout),
            tv_usec: Int32((timeout - floor(timeout)) * 1_000_000)
        )
        guard
            setsockopt(
                descriptor,
                SOL_SOCKET,
                option,
                &value,
                socklen_t(MemoryLayout<timeval>.size)
            ) == 0
        else { throw providerError("XCTEST_SOCKET_FAILED", String(cString: strerror(errno))) }
    }
}

private final class LoopbackListener {
    let descriptor: Int32
    let port: UInt16

    init() throws {
        let socketDescriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else {
            throw providerError("XCTEST_SOCKET_FAILED", String(cString: strerror(errno)))
        }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(socketDescriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Darwin.listen(socketDescriptor, 1) == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(socketDescriptor)
            throw providerError("XCTEST_SOCKET_FAILED", message)
        }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let readAddress = withUnsafeMutablePointer(to: &actual) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(socketDescriptor, $0, &length)
            }
        }
        guard readAddress == 0 else {
            Darwin.close(socketDescriptor)
            throw providerError("XCTEST_SOCKET_FAILED", String(cString: strerror(errno)))
        }
        descriptor = socketDescriptor
        port = UInt16(bigEndian: actual.sin_port)
    }

    deinit { Darwin.close(descriptor) }

    func accept(timeout: TimeInterval) throws -> Int32 {
        var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let milliseconds = Int32(max(1, min(timeout * 1_000, Double(Int32.max))))
        guard Darwin.poll(&pollDescriptor, 1, milliseconds) > 0 else {
            throw providerError("XCTEST_START_TIMEOUT", "XCTest provider did not connect")
        }
        let connection = Darwin.accept(descriptor, nil, nil)
        guard connection >= 0 else {
            throw providerError("XCTEST_SOCKET_FAILED", String(cString: strerror(errno)))
        }
        return connection
    }
}

private func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8)
    let right = Array(rhs.utf8)
    var difference = UInt8(left.count == right.count ? 0 : 1)
    let count = max(left.count, right.count)
    for index in 0..<count {
        difference |= (index < left.count ? left[index] : 0) ^ (index < right.count ? right[index] : 0)
    }
    return difference == 0
}

private func providerError(_ code: String, _ message: String) -> SimViewError {
    SimViewError(code, message)
}
