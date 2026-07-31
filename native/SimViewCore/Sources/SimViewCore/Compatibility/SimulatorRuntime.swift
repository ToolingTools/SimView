import Foundation
import ObjectiveC

struct SimulatorDevice {
    let udid: String
    let name: String
    let state: String
    let runtime: String

    var dictionary: [String: Any] {
        ["udid": udid, "name": name, "state": state, "runtime": runtime]
    }
}

enum SimulatorRuntime {
    static func devices() throws -> [SimulatorDevice] {
        let result = run("/usr/bin/xcrun", ["simctl", "list", "devices", "--json"])
        guard result.status == 0 else {
            throw SimViewError(
                "SIMULATOR_SERVICE_UNAVAILABLE",
                result.error.nonEmpty ?? "CoreSimulator could not list devices",
                details: ["action": "Open Xcode once and verify xcrun simctl list succeeds."]
            )
        }
        guard
            let root = try JSONSerialization.jsonObject(with: Data(result.output.utf8)) as? [String: Any],
            let byRuntime = root["devices"] as? [String: [[String: Any]]]
        else {
            throw SimViewError("SIMULATOR_RESPONSE_INVALID", "simctl returned an unexpected device payload")
        }
        return byRuntime.flatMap { runtime, devices in
            devices.compactMap { device in
                guard
                    device["isAvailable"] as? Bool != false,
                    let udid = device["udid"] as? String,
                    let name = device["name"] as? String,
                    let state = device["state"] as? String
                else { return nil }
                return SimulatorDevice(udid: udid, name: name, state: state, runtime: runtime)
            }
        }
    }

    static func booted(preferredUDID: String?) throws -> SimulatorDevice {
        let booted = try devices().filter { $0.state == "Booted" }
        if let preferredUDID {
            guard let selected = booted.first(where: { $0.udid == preferredUDID }) else {
                throw SimViewError("DEVICE_NOT_BOOTED", "Simulator \(preferredUDID) is not booted")
            }
            return selected
        }
        guard booted.count == 1, let selected = booted.first else {
            let message =
                booted.isEmpty
                ? "No booted iOS Simulator was found"
                : "More than one simulator is booted; specify a UDID"
            throw SimViewError("DEVICE_SELECTION_REQUIRED", message, details: booted.map(\.dictionary))
        }
        return selected
    }

    static func object(udid: String) -> NSObject? {
        Xcode.loadFrameworks()
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let shared = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard
            let context = contextClass.perform(shared, with: Xcode.developerDirectory(), with: nil)?
                .takeUnretainedValue() as? NSObject,
            let deviceSet = context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?
                .takeUnretainedValue() as? NSObject,
            let devices = deviceSet.value(forKey: "devices") as? [NSObject]
        else { return nil }
        return devices.first {
            ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid
        }
    }
}
