import Foundation
import Darwin

final class ProbeCoordinator: @unchecked Sendable {
    private let condition = NSCondition()
    private let ioLock = NSLock()
    private var listenerFD: Int32 = -1
    private var connectionFD: Int32 = -1
    private var port: UInt16 = 0
    private var token = ""
    private(set) var bundleID: String?
    private(set) var processID: Int?

    var bundled: Bool { dylibPath() != nil }
    var connected: Bool {
        condition.lock()
        defer { condition.unlock() }
        return connectionFD >= 0
    }

    func status() -> [String: Any] {
        [
            "schemaVersion": 1,
            "bundled": bundled,
            "connected": connected,
            "bundleId": bundleID as Any? ?? NSNull(),
            "pid": processID as Any? ?? NSNull(),
        ]
    }

    func target(udid: String) -> [String: Any] {
        if let bundleID {
            return ["schemaVersion": 1, "bundleId": bundleID, "source": "probe"]
        }
        let domain = "user/\(getuid())"
        let listing = run(
            "/usr/bin/xcrun",
            ["simctl", "spawn", udid, "launchctl", "print", domain]
        )
        guard listing.status == 0 else {
            return [
                "schemaVersion": 1,
                "bundleId": NSNull(),
                "source": "simctl",
                "error": listing.error.nonEmpty ?? "Unable to inspect Simulator applications",
            ]
        }
        for label in Self.applicationServiceLabels(listing.output) {
            let service = run(
                "/usr/bin/xcrun",
                ["simctl", "spawn", udid, "launchctl", "print", "\(domain)/\(label)"]
            )
            guard
                service.status == 0,
                let bundleID = Self.focalBundleID(service.output),
                !bundleID.hasPrefix("com.apple.")
            else {
                continue
            }
            return ["schemaVersion": 1, "bundleId": bundleID, "source": "simctl"]
        }
        return ["schemaVersion": 1, "bundleId": NSNull(), "source": "simctl"]
    }

    static func applicationServiceLabels(_ output: String) -> [String] {
        var seen = Set<String>()
        return output.split(whereSeparator: \.isNewline).compactMap { line in
            guard let start = line.range(of: "UIKitApplication:")?.lowerBound else { return nil }
            let label = String(line[start...].prefix { !$0.isWhitespace })
            guard seen.insert(label).inserted else { return nil }
            return label
        }
    }

    static func focalBundleID(_ output: String) -> String? {
        guard output.contains("spawn role = ui focal") else { return nil }
        for line in output.split(whereSeparator: \.isNewline) {
            let value = line.trimmingCharacters(in: .whitespaces)
            guard value.hasPrefix("bundle id = ") else { continue }
            return String(value.dropFirst("bundle id = ".count)).nonEmpty
        }
        return nil
    }

    func enable(udid: String, bundleID: String) throws -> [String: Any] {
        guard !bundleID.hasPrefix("com.apple.") else {
            throw SimViewError(
                "PROBE_BUNDLE_NOT_INJECTABLE",
                "Apple platform applications do not permit injected development libraries"
            )
        }
        guard let dylib = dylibPath() else {
            throw SimViewError(
                "PROBE_DISABLED",
                "The bundled SimView UIKit probe could not be found",
                details: ["action": "Run bun run build:probe or reinstall the complete SimView package."]
            )
        }
        try startListener()
        self.bundleID = bundleID
        let result = run(
            "/usr/bin/xcrun",
            ["simctl", "launch", "--terminate-running-process", udid, bundleID],
            environment: [
                "SIMCTL_CHILD_DYLD_INSERT_LIBRARIES": dylib,
                "SIMCTL_CHILD_SIMVIEW_PROBE_PORT": String(port),
                "SIMCTL_CHILD_SIMVIEW_PROBE_TOKEN": token,
            ]
        )
        guard result.status == 0 else {
            close()
            throw SimViewError(
                "PROBE_INJECTION_REJECTED",
                result.error.nonEmpty ?? "The target app could not be relaunched with the UIKit probe",
                details: ["bundleId": bundleID]
            )
        }
        let deadline = Date().addingTimeInterval(5)
        condition.lock()
        while connectionFD < 0, Date() < deadline {
            condition.wait(until: Date().addingTimeInterval(0.1))
        }
        let didConnect = connectionFD >= 0
        condition.unlock()
        guard didConnect else {
            close()
            throw SimViewError(
                "PROBE_CONNECTION_TIMEOUT",
                "The app relaunched but the UIKit probe did not connect",
                details: ["bundleId": bundleID, "dylib": dylib]
            )
        }
        return status()
    }

    func request(_ method: String, params: [String: Any] = [:]) throws -> [String: Any] {
        ioLock.lock()
        defer { ioLock.unlock() }
        condition.lock()
        let fd = connectionFD
        condition.unlock()
        guard fd >= 0 else {
            throw SimViewError("PROBE_DISABLED", "Enable the UIKit probe for a target app first")
        }
        let requestID = UUID().uuidString
        var bytes = try jsonData(["id": requestID, "method": method, "params": params])
        bytes.append(0x0a)
        guard sendAll(fd, bytes) else {
            throw SimViewError("PROBE_CONNECTION_TIMEOUT", "The UIKit probe connection closed")
        }
        let line = try readLine(fd, maximum: 8 * 1024 * 1024)
        guard
            let response = try JSONSerialization.jsonObject(with: line) as? [String: Any],
            response["id"] as? String == requestID,
            let result = response["result"] as? [String: Any]
        else {
            throw SimViewError("PROBE_PROTOCOL_MISMATCH", "The UIKit probe returned an invalid response")
        }
        return result
    }

    func disable(udid: String) throws -> [String: Any] {
        let target = bundleID
        close()
        if let target {
            let result = run(
                "/usr/bin/xcrun",
                ["simctl", "launch", "--terminate-running-process", udid, target]
            )
            guard result.status == 0 else {
                throw SimViewError(
                    "PROBE_INJECTION_REJECTED",
                    result.error.nonEmpty ?? "The target app could not be relaunched without the probe"
                )
            }
        }
        return ["schemaVersion": 1, "disabled": true, "bundleId": target as Any? ?? NSNull()]
    }

    func close() {
        condition.lock()
        if connectionFD >= 0 { Darwin.close(connectionFD) }
        if listenerFD >= 0 { Darwin.close(listenerFD) }
        connectionFD = -1
        listenerFD = -1
        port = 0
        token = ""
        bundleID = nil
        processID = nil
        condition.broadcast()
        condition.unlock()
    }

    private func startListener() throws {
        close()
        token = UUID().uuidString + UUID().uuidString
        listenerFD = socket(AF_INET, SOCK_STREAM, 0)
        guard listenerFD >= 0 else {
            throw SimViewError("PROBE_DISABLED", "Could not create the probe listener")
        }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listenerFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(listenerFD, 1) == 0 else {
            close()
            throw SimViewError("PROBE_DISABLED", "Could not bind the probe listener")
        }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                _ = getsockname(listenerFD, $0, &length)
            }
        }
        port = UInt16(bigEndian: address.sin_port)
        let listener = listenerFD
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let fd = accept(listener, nil, nil)
            guard fd >= 0 else { return }
            do {
                var timeout = timeval(tv_sec: 5, tv_usec: 0)
                setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                let line = try self.readLine(fd, maximum: 16 * 1024)
                guard
                    let hello = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                    hello["token"] as? String == self.token,
                    hello["protocolVersion"] as? Int == 1
                else {
                    Darwin.close(fd)
                    return
                }
                self.condition.lock()
                self.connectionFD = fd
                self.processID = hello["pid"] as? Int
                self.condition.broadcast()
                self.condition.unlock()
            } catch {
                Darwin.close(fd)
            }
        }
    }

    private func readLine(_ fd: Int32, maximum: Int) throws -> Data {
        var result = Data()
        var byte: UInt8 = 0
        while result.count < maximum {
            let count = Darwin.recv(fd, &byte, 1, 0)
            if count <= 0 {
                throw SimViewError("PROBE_CONNECTION_TIMEOUT", "The UIKit probe did not respond")
            }
            if byte == 0x0a { return result }
            result.append(byte)
        }
        throw SimViewError("PROBE_RESPONSE_TOO_LARGE", "The UIKit probe response exceeded the size limit")
    }

    private func sendAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            guard var pointer = raw.baseAddress else { return false }
            var remaining = raw.count
            while remaining > 0 {
                let written = Darwin.send(fd, pointer, remaining, MSG_NOSIGNAL)
                if written <= 0 { return false }
                pointer = pointer.advanced(by: written)
                remaining -= written
            }
            return true
        }
    }

    private func dylibPath() -> String? {
        let manager = FileManager.default
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardized
        let candidates = [
            ProcessInfo.processInfo.environment["SIMVIEW_PROBE_DYLIB"],
            executable.deletingLastPathComponent()
                .appendingPathComponent("libSimViewProbe.dylib").path(percentEncoded: false),
            URL(fileURLWithPath: manager.currentDirectoryPath)
                .appendingPathComponent("native/SimViewProbe/build/libSimViewProbe.dylib")
                .path(percentEncoded: false),
        ].compactMap { $0 }
        return candidates.first(where: { manager.isExecutableFile(atPath: $0) || manager.fileExists(atPath: $0) })
    }
}
