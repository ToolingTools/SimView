import Foundation

enum DevicePlatform: String, Sendable {
    case ios
    case android
}

enum DeviceKind: String, Sendable {
    case simulator
    case emulator
    case physical
}

struct DeviceDescription: Sendable {
    let id: String
    let platform: DevicePlatform
    let kind: DeviceKind
    let nativeIdentifier: String
    let name: String
    let state: String
    let runtime: String
    let available: Bool
    let pixelWidth: Int?
    let pixelHeight: Int?
    let metadata: [String: String]

    var udid: String? { platform == .ios ? nativeIdentifier : nil }
    var serial: String? { platform == .android ? nativeIdentifier : nil }

    var dictionary: [String: Any] {
        var result: [String: Any] = [
            "id": id,
            "platform": platform.rawValue,
            "kind": kind.rawValue,
            "name": name,
            "state": state,
            "runtime": runtime,
            "available": available,
            "metadata": metadata,
            "capabilities": capabilities,
        ]
        if let udid { result["udid"] = udid }
        if let serial { result["serial"] = serial }
        if let pixelWidth { result["pixelWidth"] = pixelWidth }
        if let pixelHeight { result["pixelHeight"] = pixelHeight }
        return result
    }

    var capabilities: [String: Any] {
        switch platform {
        case .ios:
            [
                "capture": ["h264": true, "mjpeg": true, "screenshot": true],
                "input": [
                    "touch": true,
                    "rawTouch": true,
                    "text": "unicode",
                    "buttons": ["home", "lock", "volume-up", "volume-down", "action"],
                ],
                "orientation": true,
                "accessibility": true,
                "androidContext": false,
                "uikitProbe": true,
            ]
        case .android:
            [
                "capture": ["h264": true, "mjpeg": true, "screenshot": true],
                "input": [
                    "touch": true,
                    // Discrete ADB input is always available. Continuous touch
                    // is enabled in the capture response only after the agent
                    // has authenticated for this exact device.
                    "rawTouch": false,
                    "text": "ascii",
                    "buttons": ["back", "home", "overview", "lock", "volume-up", "volume-down"],
                ],
                "orientation": kind == .emulator,
                "accessibility": true,
                "androidContext": true,
                "uikitProbe": false,
            ]
        }
    }
}

protocol DeviceProvider {
    func devices() throws -> [DeviceDescription]
}

enum DeviceRuntime {
    static func devices() throws -> [DeviceDescription] {
        var result: [DeviceDescription] = []
        var iosFailure: Error?
        var androidFailure: Error?
        var iosSucceeded = false
        var androidSucceeded = false
        do {
            result.append(contentsOf: try IOSDeviceProvider().devices())
            iosSucceeded = true
        } catch {
            iosFailure = error
        }
        do {
            result.append(contentsOf: try AndroidDeviceProvider().devices())
            androidSucceeded = true
        } catch {
            androidFailure = error
        }
        if !iosSucceeded, !androidSucceeded, let failure = iosFailure ?? androidFailure { throw failure }
        return result
    }

    static func select(requested: String?, configured: String?) throws -> DeviceDescription {
        let all = try devices()
        if let identifier = requested ?? configured {
            let normalized = identifier.contains(":") ? identifier : "ios:\(identifier)"
            guard let selected = all.first(where: { $0.id == normalized }) else {
                throw SimViewError(
                    "DEVICE_NOT_AVAILABLE",
                    "Device \(identifier) is unavailable",
                    details: ["devices": all.map(\.dictionary)]
                )
            }
            guard selected.available else {
                throw SimViewError(
                    "DEVICE_NOT_READY",
                    "Device \(identifier) is \(selected.state)",
                    details: ["device": selected.dictionary]
                )
            }
            return selected
        }

        let ready = all.filter(\.available)
        guard ready.count == 1, let selected = ready.first else {
            let message =
                ready.isEmpty
                ? "No booted iOS Simulator or ready Android device was found"
                : "More than one device is available; specify a device ID"
            throw SimViewError("DEVICE_SELECTION_REQUIRED", message, details: ready.map(\.dictionary))
        }
        return selected
    }
}

struct IOSDeviceProvider: DeviceProvider {
    func devices() throws -> [DeviceDescription] {
        try SimulatorRuntime.devices().map { device in
            DeviceDescription(
                id: "ios:\(device.udid)",
                platform: .ios,
                kind: .simulator,
                nativeIdentifier: device.udid,
                name: device.name,
                state: normalizedIOSState(device.state),
                runtime: device.runtime,
                available: device.state == "Booted",
                pixelWidth: nil,
                pixelHeight: nil,
                metadata: ["simulatorState": device.state]
            )
        }
    }
}

private func normalizedIOSState(_ state: String) -> String {
    switch state.lowercased() {
    case "booted": "ready"
    case "booting", "creating": "booting"
    case "shutdown", "shut down": "shutdown"
    default: "unknown"
    }
}
