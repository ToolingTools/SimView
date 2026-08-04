import Darwin
import Foundation

struct IOSPhysicalDeviceProvider: DeviceProvider {
    static let maximumJSONBytes = 8 * 1024 * 1024

    private let command: @Sendable (String, [String]) -> ProcessResult
    private let runnerReadiness: @Sendable (String) -> String

    init(
        command: @escaping @Sendable (String, [String]) -> ProcessResult = { run($0, $1) },
        runnerReadiness: @escaping @Sendable (String) -> String = { _ in "unknown" }
    ) {
        self.command = command
        self.runnerReadiness = runnerReadiness
    }

    func devices() throws -> [DeviceDescription] {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("simview-devicectl-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let outputURL = directory.appendingPathComponent("devices.json")
        let result = command(
            "/usr/bin/xcrun",
            [
                "devicectl", "list", "devices", "--timeout", "10",
                "--json-output", outputURL.path, "--quiet",
            ]
        )
        guard result.status == 0 else {
            throw SimViewError(
                "IOS_DEVICE_DISCOVERY_FAILED",
                Self.bounded(result.error) ?? "CoreDevice could not list physical iOS devices"
            )
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        guard let size = attributes[.size] as? NSNumber,
            size.intValue > 0,
            size.intValue <= Self.maximumJSONBytes
        else {
            throw SimViewError(
                "IOS_DEVICE_DISCOVERY_INVALID",
                "CoreDevice returned an empty or oversized device listing"
            )
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputURL.path)
        let usbIdentifiers = Set(
            (try? USBMuxClient().devices())?.filter {
                $0.connectionType.caseInsensitiveCompare("USB") == .orderedSame
            }.map { USBMuxClient.canonicalUDID($0.serialNumber) } ?? []
        )
        return try Self.parseDevices(
            Data(contentsOf: outputURL),
            runnerReadiness: runnerReadiness,
            usbConnected: { usbIdentifiers.contains(USBMuxClient.canonicalUDID($0)) }
        )
    }

    static func parseDevices(
        _ data: Data,
        runnerReadiness: @Sendable (String) -> String = { _ in "unknown" },
        usbConnected: @Sendable (String) -> Bool = { _ in false }
    ) throws -> [DeviceDescription] {
        guard data.count <= maximumJSONBytes else {
            throw SimViewError("IOS_DEVICE_DISCOVERY_INVALID", "CoreDevice returned malformed JSON")
        }
        let root: [String: Any]
        do {
            let object = try JSONSerialization.jsonObject(with: data)
            guard let dictionary = object as? [String: Any] else { throw CocoaError(.fileReadCorruptFile) }
            root = dictionary
        } catch {
            throw SimViewError("IOS_DEVICE_DISCOVERY_INVALID", "CoreDevice returned malformed JSON")
        }
        if let info = root["info"] as? [String: Any],
            let outcome = string(info["outcome"]),
            normalized(outcome) != "success"
        {
            throw SimViewError("IOS_DEVICE_DISCOVERY_FAILED", "CoreDevice device discovery did not succeed")
        }
        guard let result = root["result"] as? [String: Any],
            let records = result["devices"] as? [[String: Any]]
        else {
            throw SimViewError("IOS_DEVICE_DISCOVERY_INVALID", "CoreDevice JSON did not contain a device list")
        }
        return records.compactMap {
            describe($0, runnerReadiness: runnerReadiness, usbConnected: usbConnected)
        }
    }

    private static func describe(
        _ record: [String: Any],
        runnerReadiness: @Sendable (String) -> String,
        usbConnected: @Sendable (String) -> Bool
    ) -> DeviceDescription? {
        let connection = record["connectionProperties"] as? [String: Any] ?? [:]
        let properties = record["deviceProperties"] as? [String: Any] ?? [:]
        let hardware = record["hardwareProperties"] as? [String: Any] ?? [:]

        guard normalized(string(hardware["platform"])) == "ios",
            normalized(string(hardware["reality"])) == "physical",
            let udid = boundedIdentifier(string(hardware["udid"]))
        else { return nil }

        let transport = bounded(string(connection["transportType"])) ?? "unknown"
        let pairing = bounded(string(connection["pairingState"])) ?? "unknown"
        let developerMode = bounded(string(properties["developerModeStatus"])) ?? "unknown"
        let tunnel = bounded(string(connection["tunnelState"])) ?? "unknown"
        let locked = boolean(properties["isLocked"]) ?? boolean(connection["isLocked"])
        let ddiAvailable = boolean(properties["ddiServicesAvailable"])
        let runnerState = bounded(runnerReadiness(udid)) ?? "unknown"
        let connectedThroughUSBMux = usbConnected(udid)

        let state: String
        if locked == true {
            state = "locked"
        } else if normalized(pairing) != "paired" {
            state = normalized(pairing) == "unknown" ? "unknown" : "unpaired"
        } else if normalized(developerMode) != "enabled" {
            state = normalized(developerMode) == "unknown" ? "unknown" : "developer-mode-disabled"
        } else if !isUSBTransport(transport), !connectedThroughUSBMux {
            state = normalized(transport) == "unknown" ? "unknown" : "unsupported-transport"
        } else {
            state = "ready"
        }

        var metadata: [String: String] = [
            "pairingState": pairing,
            "developerModeStatus": developerMode,
            "transport": transport,
            "tunnelState": tunnel,
            "runnerReady": runnerState,
            "usbmuxUSB": String(connectedThroughUSBMux),
        ]
        insertBounded(record["identifier"], as: "coreDeviceIdentifier", into: &metadata)
        insertBounded(hardware["productType"], as: "productType", into: &metadata)
        insertBounded(hardware["hardwareModel"], as: "hardwareModel", into: &metadata)
        insertBounded(record["visibilityClass"], as: "visibilityClass", into: &metadata)
        if let locked { metadata["locked"] = String(locked) }
        if let ddiAvailable { metadata["ddiServicesAvailable"] = String(ddiAvailable) }

        let osVersion = bounded(string(properties["osVersionNumber"]))
        let name =
            bounded(string(properties["name"]))
            ?? bounded(string(hardware["marketingName"]))
            ?? udid
        return DeviceDescription(
            id: "ios:\(udid)",
            platform: .ios,
            kind: .physical,
            nativeIdentifier: udid,
            name: name,
            state: state,
            runtime: osVersion.map { "iOS \($0)" } ?? "iOS",
            available: state == "ready",
            pixelWidth: nil,
            pixelHeight: nil,
            metadata: metadata
        )
    }

    private static func insertBounded(_ value: Any?, as key: String, into metadata: inout [String: String]) {
        if let value = bounded(string(value)) { metadata[key] = value }
    }

    private static func string(_ value: Any?) -> String? {
        switch value {
        case let value as String: value
        case let value as NSNumber: value.stringValue
        default: nil
        }
    }

    private static func boolean(_ value: Any?) -> Bool? {
        switch value {
        case let value as Bool: value
        case let value as NSNumber: value.boolValue
        case let value as String where ["true", "yes", "1"].contains(normalized(value)): true
        case let value as String where ["false", "no", "0"].contains(normalized(value)): false
        default: nil
        }
    }

    private static func boundedIdentifier(_ value: String?) -> String? {
        guard let value = bounded(value),
            value.unicodeScalars.allSatisfy({
                CharacterSet.alphanumerics.contains($0) || $0 == "-"
            })
        else { return nil }
        return value
    }

    private static func bounded(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 256,
            !trimmed.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { return nil }
        return trimmed
    }

    private static func normalized(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "unknown"
    }

    private static func isUSBTransport(_ value: String) -> Bool {
        ["usb", "wired"].contains(normalized(value))
    }
}
