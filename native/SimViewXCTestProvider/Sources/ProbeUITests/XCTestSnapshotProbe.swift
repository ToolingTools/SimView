import Darwin
import Foundation
import XCTest

private let environment = ProcessInfo.processInfo.environment
private let targetBundleIdentifier = environment["SIMVIEW_XCTEST_TARGET_BUNDLE_ID"] ?? ""
private let captureCount = Int(environment["SIMVIEW_XCTEST_CAPTURE_COUNT"] ?? "2") ?? 2
private let outputMarker = "SIMVIEW_XCTEST_SNAPSHOT_V1:"
private let maximumFrameBytes = 16 * 1_024 * 1_024

@MainActor
final class XCTestSnapshotProbe: XCTestCase {
    private var retainedSnapshot: [String: Any]?

    func testSnapshotArbitraryApplication() throws {
        XCTAssertFalse(
            targetBundleIdentifier.isEmpty,
            "Run the probe through scripts/probe-xctest-accessibility.ts"
        )

        let application = XCUIApplication(bundleIdentifier: targetBundleIdentifier)
        application.activate()
        XCTAssertEqual(
            application.state,
            .runningForeground,
            "The target application did not reach the foreground"
        )

        if environment["SIMVIEW_XCTEST_MODE"] == "persistent" {
            try serve(application: application)
            return
        }

        var captures: [[String: Any]] = []
        for sequence in 0..<captureCount {
            let startedAt = Date()
            let snapshot = try application.snapshot()
            captures.append([
                "sequence": sequence,
                "captureDurationMs": Int(Date().timeIntervalSince(startedAt) * 1_000),
                "root": sanitize(snapshot.dictionaryRepresentation),
            ])
        }
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "provider": "core-simulator-xctest-probe",
            "bundleId": targetBundleIdentifier,
            "captures": captures,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])

        // xcodebuild preserves test stdout. The host harness extracts this single-line,
        // base64-encoded payload without scraping XCTest's human-oriented debug tree.
        print(outputMarker + data.base64EncodedString())
    }

    private func serve(application: XCUIApplication) throws {
        guard
            let portText = environment["SIMVIEW_XCTEST_PORT"],
            let port = UInt16(portText),
            let token = environment["SIMVIEW_XCTEST_TOKEN"],
            token.count >= 32
        else {
            XCTFail("Persistent XCTest provider configuration is incomplete")
            return
        }

        let socket = try connectToHost(port: port)
        defer { Darwin.close(socket) }
        try writeJSON(
            ["type": "hello", "protocolVersion": 1, "token": token],
            to: socket
        )

        while let request = try readJSON(from: socket) {
            let identifier = request["id"] as? String ?? ""
            switch request["method"] as? String {
            case "snapshot":
                let requestedBudget = (request["maxNodes"] as? NSNumber)?.intValue ?? 1_200
                let budget = max(1, min(requestedBudget, 5_000))
                do {
                    let result = try contractSnapshot(application: application, maxNodes: budget)
                    retainedSnapshot = result
                    try writeJSON(["id": identifier, "result": result], to: socket)
                } catch {
                    try writeJSON(
                        [
                            "id": identifier,
                            "error": [
                                "code": "XCTEST_SNAPSHOT_FAILED",
                                "message": error.localizedDescription,
                            ],
                        ],
                        to: socket
                    )
                }
            case "elementAtPoint":
                do {
                    let snapshot: [String: Any]
                    if let retainedSnapshot {
                        snapshot = retainedSnapshot
                    } else {
                        snapshot = try contractSnapshot(application: application, maxNodes: 5_000)
                        retainedSnapshot = snapshot
                    }
                    guard
                        let x = (request["x"] as? NSNumber)?.doubleValue,
                        let y = (request["y"] as? NSNumber)?.doubleValue,
                        (0...1).contains(x),
                        (0...1).contains(y),
                        let screen = snapshot["screen"] as? [String: Any],
                        let width = (screen["width"] as? NSNumber)?.doubleValue,
                        let height = (screen["height"] as? NSNumber)?.doubleValue,
                        let root = snapshot["root"] as? [String: Any],
                        let element = deepestActionableElement(
                            in: root,
                            point: CGPoint(x: x * width, y: y * height)
                        )
                    else { throw POSIXError(.EINVAL) }
                    try writeJSON(["id": identifier, "result": element], to: socket)
                } catch {
                    try writeJSON(
                        [
                            "id": identifier,
                            "error": [
                                "code": "XCTEST_ELEMENT_NOT_FOUND",
                                "message": "No retained XCTest element contains the point",
                            ],
                        ],
                        to: socket
                    )
                }
            case "ping":
                try writeJSON(["id": identifier, "result": ["ready": true]], to: socket)
            case "shutdown":
                try writeJSON(["id": identifier, "result": ["stopped": true]], to: socket)
                return
            default:
                try writeJSON(
                    [
                        "id": identifier,
                        "error": [
                            "code": "XCTEST_METHOD_UNSUPPORTED",
                            "message": "Unsupported XCTest provider method",
                        ],
                    ],
                    to: socket
                )
            }
        }
    }

    private func deepestActionableElement(
        in node: [String: Any],
        point: CGPoint
    ) -> [String: Any]? {
        guard
            let frame = node["frame"] as? [String: Any],
            let points = frame["points"] as? [String: Any],
            let x = (points["x"] as? NSNumber)?.doubleValue,
            let y = (points["y"] as? NSNumber)?.doubleValue,
            let width = (points["width"] as? NSNumber)?.doubleValue,
            let height = (points["height"] as? NSNumber)?.doubleValue,
            CGRect(x: x, y: y, width: width, height: height).contains(point)
        else { return nil }

        let children = node["children"] as? [[String: Any]] ?? []
        let matches = children.compactMap { deepestActionableElement(in: $0, point: point) }
        return matches.min { left, right in
            frameArea(left) < frameArea(right)
        } ?? (isActionable(node) ? node : nil)
    }

    private func isActionable(_ node: [String: Any]) -> Bool {
        guard let role = node["role"] as? String else { return false }
        return [
            "AXButton", "AXRadioButton", "AXCheckBox", "AXTextField", "AXTextArea",
            "AXLink", "AXSwitch", "AXTab",
        ].contains(role)
    }

    private func frameArea(_ node: [String: Any]) -> Double {
        guard
            let frame = node["frame"] as? [String: Any],
            let points = frame["points"] as? [String: Any],
            let width = (points["width"] as? NSNumber)?.doubleValue,
            let height = (points["height"] as? NSNumber)?.doubleValue
        else { return .greatestFiniteMagnitude }
        return width * height
    }

    private func contractSnapshot(
        application: XCUIApplication,
        maxNodes: Int
    ) throws -> [String: Any] {
        let snapshot = try application.snapshot()
        let screenFrame = snapshot.frame
        let snapshotID = UUID().uuidString
        var remaining = maxNodes
        var ordinal = 0
        var truncated = false
        let root = serialize(
            snapshot,
            snapshotID: snapshotID,
            screenFrame: screenFrame,
            remaining: &remaining,
            ordinal: &ordinal,
            truncated: &truncated,
            depth: 0
        )
        return [
            "schemaVersion": 1,
            "snapshotId": snapshotID,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "source": "core-simulator-xctest",
            "scope": "full",
            "screen": [
                "x": screenFrame.origin.x,
                "y": screenFrame.origin.y,
                "width": screenFrame.size.width,
                "height": screenFrame.size.height,
            ],
            "root": root,
            "stats": [
                "nodeCount": ordinal,
                "truncated": truncated,
                "quality": truncated ? "partial" : "complete",
                "capturedBudget": maxNodes,
                "provider": "core-simulator-xctest",
            ],
        ]
    }

    private func serialize(
        _ snapshot: any XCUIElementSnapshot,
        snapshotID: String,
        screenFrame: CGRect,
        remaining: inout Int,
        ordinal: inout Int,
        truncated: inout Bool,
        depth: Int
    ) -> [String: Any] {
        guard remaining > 0, depth <= 48 else {
            truncated = true
            return [:]
        }
        let current = ordinal
        ordinal += 1
        remaining -= 1

        var node: [String: Any] = [
            "ref": "ax:\(snapshotID):\(current)",
            "role": roleName(snapshot.elementType),
            "enabled": snapshot.isEnabled,
            "selected": snapshot.isSelected,
            "focused": snapshot.hasFocus,
            "frame": frameDictionary(snapshot.frame, screenFrame: screenFrame),
            "visibleFraction": visibleFraction(snapshot.frame, screenFrame: screenFrame),
        ]
        setIfPresent(snapshot.identifier, key: "identifier", in: &node)
        setIfPresent(snapshot.label, key: "label", in: &node)
        setIfPresent(snapshot.title, key: "title", in: &node)
        setIfPresent(snapshot.placeholderValue, key: "placeholder", in: &node)
        if let value = snapshot.value {
            setIfPresent(String(describing: value), key: "value", in: &node)
        }

        var children: [[String: Any]] = []
        for child in snapshot.children {
            guard remaining > 0 else {
                truncated = true
                break
            }
            let serialized = serialize(
                child,
                snapshotID: snapshotID,
                screenFrame: screenFrame,
                remaining: &remaining,
                ordinal: &ordinal,
                truncated: &truncated,
                depth: depth + 1
            )
            if !serialized.isEmpty { children.append(serialized) }
        }
        if !children.isEmpty { node["children"] = children }
        return node
    }

    private func frameDictionary(_ frame: CGRect, screenFrame: CGRect) -> [String: Any] {
        let width = screenFrame.width
        let height = screenFrame.height
        return [
            "points": [
                "x": frame.origin.x,
                "y": frame.origin.y,
                "width": frame.width,
                "height": frame.height,
            ],
            "normalized": [
                "x": width > 0 ? (frame.minX - screenFrame.minX) / width : 0,
                "y": height > 0 ? (frame.minY - screenFrame.minY) / height : 0,
                "width": width > 0 ? frame.width / width : 0,
                "height": height > 0 ? frame.height / height : 0,
            ],
        ]
    }

    private func visibleFraction(_ frame: CGRect, screenFrame: CGRect) -> Double {
        let area = frame.width * frame.height
        guard area > 0 else { return 0 }
        let intersection = frame.intersection(screenFrame)
        guard !intersection.isNull else { return 0 }
        return max(0, min(1, intersection.width * intersection.height / area))
    }

    private func roleName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .application: "AXApplication"
        case .window: "AXWindow"
        case .group: "AXGroup"
        case .button: "AXButton"
        case .radioButton: "AXRadioButton"
        case .radioGroup: "AXRadioGroup"
        case .checkBox: "AXCheckBox"
        case .navigationBar: "AXNavigationBar"
        case .tabBar: "AXTabGroup"
        case .tabGroup: "AXTabGroup"
        case .tab: "AXTab"
        case .toolbar: "AXToolbar"
        case .toolbarButton: "AXButton"
        case .staticText: "AXStaticText"
        case .textField: "AXTextField"
        case .secureTextField: "AXTextField"
        case .textView: "AXTextArea"
        case .image: "AXImage"
        case .link: "AXLink"
        case .switch: "AXSwitch"
        case .scrollView: "AXScrollArea"
        case .table: "AXTable"
        case .collectionView: "AXList"
        case .cell: "AXCell"
        case .keyboard: "AXKeyboard"
        case .key: "AXButton"
        default: "AXUnknown"
        }
    }

    private func setIfPresent(_ value: String?, key: String, in node: inout [String: Any]) {
        guard let value, !value.isEmpty else { return }
        node[key] = value
    }

    private func connectToHost(port: UInt16) throws -> Int32 {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw POSIXError(.ENOTCONN) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        guard inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) == 1 else {
            Darwin.close(descriptor)
            throw POSIXError(.EINVAL)
        }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard result == 0 else {
            let code = errno
            Darwin.close(descriptor)
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .ENOTCONN)
        }
        return descriptor
    }

    private func readJSON(from socket: Int32) throws -> [String: Any]? {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(4_096)
        var byte: UInt8 = 0
        while bytes.count < maximumFrameBytes {
            let count = Darwin.read(socket, &byte, 1)
            if count == 0 { return bytes.isEmpty ? nil : try decodeJSON(bytes) }
            if count < 0 {
                if errno == EINTR { continue }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            if byte == 0x0A { return try decodeJSON(bytes) }
            bytes.append(byte)
        }
        throw POSIXError(.EMSGSIZE)
    }

    private func decodeJSON(_ bytes: [UInt8]) throws -> [String: Any] {
        guard
            let value = try JSONSerialization.jsonObject(with: Data(bytes)) as? [String: Any]
        else { throw POSIXError(.EBADMSG) }
        return value
    }

    private func writeJSON(_ value: [String: Any], to socket: Int32) throws {
        var data = try JSONSerialization.data(withJSONObject: value)
        data.append(0x0A)
        try data.withUnsafeBytes { rawBuffer in
            guard var pointer = rawBuffer.baseAddress else { return }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let count = Darwin.write(socket, pointer, remaining)
                if count < 0 {
                    if errno == EINTR { continue }
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                remaining -= count
                pointer = pointer.advanced(by: count)
            }
        }
    }

    private func sanitize(_ value: Any) -> Any {
        switch value {
        case let dictionary as [AnyHashable: Any]:
            var result: [String: Any] = [:]
            for (key, child) in dictionary {
                result[normalizeKey(key)] = sanitize(child)
            }
            return result
        case let values as [Any]:
            return values.map(sanitize)
        case let string as String:
            return string
        case let number as NSNumber:
            return number
        case let value as NSValue:
            if String(cString: value.objCType).contains("CGRect") {
                let frame = value.cgRectValue
                return [
                    "x": frame.origin.x,
                    "y": frame.origin.y,
                    "width": frame.size.width,
                    "height": frame.size.height,
                ]
            }
            return value.description
        case _ as NSNull:
            return NSNull()
        default:
            return String(describing: value)
        }
    }

    private func normalizeKey(_ key: AnyHashable) -> String {
        let description = String(describing: key)
        let prefix = "XCUIElementAttributeName(_rawValue: "
        guard description.hasPrefix(prefix), description.hasSuffix(")") else {
            return description
        }
        return String(description.dropFirst(prefix.count).dropLast())
    }
}
