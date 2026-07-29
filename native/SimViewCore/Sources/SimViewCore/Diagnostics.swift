import Foundation
import SimViewAXShim

enum Diagnostics {
    static func report() -> [String: Any] {
        let frameworks = Xcode.loadFrameworks()
        let xcode = run("/usr/bin/xcodebuild", ["-version"])
        let runtimes = run("/usr/bin/xcrun", ["simctl", "list", "runtimes", "--json"])
        let devices = (try? SimulatorRuntime.devices()) ?? []
        let signature = run("/usr/bin/codesign", ["-dv", "--verbose=2", CommandLine.arguments[0]])
        let symbols = [
            "IndigoHIDMessageForMouseNSEvent",
            "IndigoHIDMessageForButton",
            "IndigoHIDMessageForHIDArbitrary",
            "IndigoHIDMessageForKeyboardArbitrary",
        ]
        return [
            "ok": frameworks.values.contains(true) && Xcode.symbolAvailable(symbols[0]),
            "protocolVersion": 1,
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "architecture": machineArchitecture(),
            "developerDirectory": Xcode.developerDirectory(),
            "xcode": xcode.output.trimmingCharacters(in: .whitespacesAndNewlines),
            "frameworks": frameworks,
            "symbols": Dictionary(uniqueKeysWithValues: symbols.map { ($0, Xcode.symbolAvailable($0)) }),
            "runtimesAvailable": runtimes.status == 0,
            "bootedSimulators": devices.filter { $0.state == "Booted" }.map(\.dictionary),
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
}

private func machineArchitecture() -> String {
    var system = utsname()
    uname(&system)
    return withUnsafePointer(to: &system.machine) {
        $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
}
