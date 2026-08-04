import Foundation

struct IOSInstalledApp: Sendable, Equatable {
    let bundleID: String
    let name: String
    let version: String?
    let build: String?
    let system: Bool
    let launchable: Bool

    var dictionary: [String: Any] {
        var result: [String: Any] = [
            "bundleId": bundleID,
            "name": name,
            "system": system,
            "launchable": launchable,
        ]
        if let version { result["version"] = version }
        if let build { result["build"] = build }
        return result
    }
}

enum IOSInstalledAppProvider {
    private static let maximumJSONBytes = 16 * 1024 * 1024

    static func apps(device: DeviceDescription) throws -> [IOSInstalledApp] {
        guard device.platform == .ios, device.kind == .physical else {
            throw SimViewError("METHOD_UNSUPPORTED", "Installed-app listing is only available for physical iOS devices")
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("simview-devicectl-apps-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = directory.appendingPathComponent("apps.json")
        let result = run(
            "/usr/bin/xcrun",
            [
                "devicectl", "device", "info", "apps",
                "--device", device.nativeIdentifier,
                "--include-all-apps",
                "--timeout", "15",
                "--json-output", output.path,
                "--quiet",
            ]
        )
        guard result.status == 0 else {
            throw SimViewError(
                "IOS_APPS_LIST_FAILED",
                result.error.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                    ?? "CoreDevice could not list installed apps"
            )
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: output.path)
        guard let size = attributes[.size] as? NSNumber,
            size.intValue > 0, size.intValue <= maximumJSONBytes
        else {
            throw SimViewError("IOS_APPS_LIST_INVALID", "CoreDevice returned an empty or oversized app listing")
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        return try parse(Data(contentsOf: output))
    }

    static func parse(_ data: Data) throws -> [IOSInstalledApp] {
        guard data.count <= maximumJSONBytes,
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let result = root["result"] as? [String: Any]
        else {
            throw SimViewError("IOS_APPS_LIST_INVALID", "CoreDevice returned malformed app JSON")
        }
        let candidates =
            (result["apps"] as? [[String: Any]])
            ?? (result["applications"] as? [[String: Any]])
            ?? []
        return candidates.compactMap(parseApp).sorted {
            if $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedSame {
                return $0.bundleID < $1.bundleID
            }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private static func parseApp(_ value: [String: Any]) -> IOSInstalledApp? {
        let bundleID = firstString(value, ["bundleIdentifier", "bundleID", "bundleId"])
        guard let bundleID, !bundleID.isEmpty, bundleID.utf8.count <= 512 else { return nil }
        let name =
            firstString(value, ["name", "displayName", "localizedName"])
            .flatMap { $0.isEmpty ? nil : $0 } ?? bundleID
        let removable = firstBool(value, ["isRemovable", "removable"])
        let builtIn = firstBool(value, ["isSystemApp", "systemApp", "builtIn"])
        let system = builtIn ?? (removable.map(!) ?? false)
        let launchable = firstBool(value, ["isLaunchable", "launchable"]) ?? true
        return IOSInstalledApp(
            bundleID: bundleID,
            name: String(name.prefix(256)),
            version: firstString(value, ["version", "shortVersionString", "CFBundleShortVersionString"]),
            build: firstString(value, ["build", "bundleVersion", "CFBundleVersion"]),
            system: system,
            launchable: launchable
        )
    }

    private static func firstString(_ value: [String: Any], _ keys: [String]) -> String? {
        for key in keys {
            if let string = value[key] as? String {
                return String(string.trimmingCharacters(in: .whitespacesAndNewlines).prefix(512))
            }
        }
        return nil
    }

    private static func firstBool(_ value: [String: Any], _ keys: [String]) -> Bool? {
        for key in keys {
            if let bool = value[key] as? Bool { return bool }
            if let number = value[key] as? NSNumber { return number.boolValue }
        }
        return nil
    }
}
