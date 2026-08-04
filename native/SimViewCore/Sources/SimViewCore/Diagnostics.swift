import Foundation
import SimViewAXShim

enum Diagnostics {
    static func report() -> [String: Any] {
        let frameworks = Xcode.loadFrameworks()
        let xcode = run("/usr/bin/xcodebuild", ["-version"])
        let runtimes = run("/usr/bin/xcrun", ["simctl", "list", "runtimes", "--json"])
        let devices = (try? SimulatorRuntime.devices()) ?? []
        let adbPath = ADBResolver.resolve()
        let adb = try? ADBClient(executable: adbPath)
        let adbVersionResult = adb.flatMap { try? $0.execute(["version"], timeout: 5) }
        let adbOperational = adbVersionResult?.status == 0
        let adbVersion = adbVersionResult?.text
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let androidDiscovery: (devices: [DeviceDescription], error: String?) = {
            guard let adb, adbOperational else { return ([], adbVersionResult?.error.nonEmpty) }
            do {
                return (try AndroidDeviceProvider(client: adb).devices(), nil)
            } catch {
                return ([], (error as? SimViewError)?.message ?? error.localizedDescription)
            }
        }()
        let androidDevices = androidDiscovery.devices
        let signature = run("/usr/bin/codesign", ["-dv", "--verbose=2", CommandLine.arguments[0]])
        let symbols = [
            "IndigoHIDMessageForMouseNSEvent",
            "IndigoHIDMessageForButton",
            "IndigoHIDMessageForHIDArbitrary",
            "IndigoHIDMessageForKeyboardArbitrary",
        ]
        return [
            "ok": (frameworks.values.contains(true) && Xcode.symbolAvailable(symbols[0]))
                || adbOperational,
            "protocolVersion": SimViewVersion.protocolVersion,
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "architecture": machineArchitecture(),
            "developerDirectory": Xcode.developerDirectory(),
            "xcode": xcode.output.trimmingCharacters(in: .whitespacesAndNewlines),
            "frameworks": frameworks,
            "symbols": Dictionary(uniqueKeysWithValues: symbols.map { ($0, Xcode.symbolAvailable($0)) }),
            "runtimesAvailable": runtimes.status == 0,
            "bootedSimulators": devices.filter { $0.state == "Booted" }.map(\.dictionary),
            "android": [
                "adbPath": adbPath as Any? ?? NSNull(),
                "available": adbPath != nil,
                "operational": adbOperational,
                "version": adbVersion as Any? ?? NSNull(),
                "agent": [
                    "protocolVersion": AndroidAgentLifecycle.protocolVersion,
                    "packaged": AndroidAgentLifecycle.packagedAgentURL() != nil,
                ],
                "devices": androidDevices.map(\.dictionary),
                "errors": androidDiagnosticErrors(
                    adbPath: adbPath,
                    operational: adbOperational,
                    failure: androidDiscovery.error,
                    devices: androidDevices
                ),
            ],
            "capture": [
                "simulatorKit": NSClassFromString("SimServiceContext") != nil,
                "screenCaptureKitFallback": true,
            ],
            "input": [
                "indigoTouch": Xcode.symbolAvailable("IndigoHIDMessageForMouseNSEvent"),
                "indigoKeyboard": Xcode.symbolAvailable("IndigoHIDMessageForKeyboardArbitrary"),
            ],
            "accessibility": [
                "available": SVAccessibilityBridge.isAvailable(),
                "translationFramework": FileManager.default.fileExists(
                    atPath: "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework"
                ),
            ],
            "codeSignature": [
                "signed": signature.status == 0,
                "details": [signature.output, signature.error]
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines),
            ],
            "errors": diagnosticErrors(frameworks: frameworks, runtimesStatus: runtimes.status),
        ]
    }

    private static func diagnosticErrors(frameworks: [String: Bool], runtimesStatus: Int32) -> [[String: Any]] {
        var errors: [[String: Any]] = []
        if !frameworks.values.contains(true) {
            errors.append([
                "code": "FRAMEWORK_NOT_FOUND",
                "message": "Simulator private frameworks could not be loaded",
                "action": "Select a full Xcode installation with xcode-select.",
            ])
        }
        if runtimesStatus != 0 {
            errors.append([
                "code": "SIMULATOR_SERVICE_UNAVAILABLE",
                "message": "CoreSimulator could not list installed runtimes",
                "action": "Open Xcode and install an iOS Simulator runtime.",
            ])
        }
        return errors
    }

    private static func androidDiagnosticErrors(
        adbPath: String?, operational: Bool, failure: String?, devices: [DeviceDescription]
    ) -> [[String: Any]] {
        guard adbPath != nil else {
            return [
                [
                    "code": "ADB_NOT_FOUND",
                    "message": "Android SDK Platform Tools were not found",
                    "action": "Install Platform Tools or set SIMVIEW_ADB_PATH.",
                ]
            ]
        }
        guard operational else {
            return [
                [
                    "code": "ADB_COMMAND_FAILED",
                    "message": failure ?? "ADB could not query its local server",
                    "action": "Run adb devices -l and resolve the reported Platform Tools error.",
                ]
            ]
        }
        return devices.compactMap { device in
            guard !device.available else { return nil }
            let action: String
            switch device.state {
            case "unauthorized":
                action = "Unlock the device and accept its ADB authorization prompt."
            case "offline":
                action = "Reconnect the transport, then verify it with adb devices -l."
            case "booting":
                action = "Wait for Android to finish booting and report sys.boot_completed=1."
            default:
                action = "Inspect the transport with adb devices -l."
            }
            return [
                "code": "ANDROID_DEVICE_\(device.state.uppercased())",
                "message": "\(device.id) is \(device.state)",
                "action": action,
            ]
        }
    }
}

private func machineArchitecture() -> String {
    var system = utsname()
    uname(&system)
    return withUnsafePointer(to: &system.machine) {
        $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
}
