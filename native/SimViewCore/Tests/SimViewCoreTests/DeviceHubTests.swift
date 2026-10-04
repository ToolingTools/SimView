import XCTest

@testable import SimViewCore

final class DeviceHubTests: XCTestCase {
    func testMapsSimViewOrientationNamesToDeviceHubValues() throws {
        XCTAssertEqual(try DeviceHubOrientation.cliOrientation(for: "portrait"), "portrait")
        XCTAssertEqual(
            try DeviceHubOrientation.cliOrientation(for: "portrait-upside-down"),
            "portraitUpsideDown"
        )
        XCTAssertEqual(
            try DeviceHubOrientation.cliOrientation(for: "landscape-left"),
            "landscapeRight"
        )
        XCTAssertEqual(
            try DeviceHubOrientation.cliOrientation(for: "landscape-right"),
            "landscapeLeft"
        )
    }

    func testSelectedXcodePrefersDeviceHubAndRespectsDeveloperDirectory() {
        let developer = "/tmp/Xcode-Beta.app/Contents/Developer"
        let existing = Set([
            "/tmp/Xcode-Beta.app/Contents/Applications/DeviceHub.app",
            "/tmp/Xcode-Beta.app/Contents/Developer/Applications/Simulator.app",
        ])
        let selected = Xcode.selectedUIApplication(
            developerDirectory: developer,
            fileExists: { existing.contains($0) }
        )
        XCTAssertEqual(selected?.kind, .deviceHub)
        XCTAssertEqual(selected?.path, "/tmp/Xcode-Beta.app/Contents/Applications/DeviceHub.app")
        XCTAssertEqual(
            Xcode.devicectlPath(developerDirectory: developer),
            "/tmp/Xcode-Beta.app/Contents/Developer/usr/bin/devicectl"
        )
    }

    func testNormalizesXcodeApplicationRootForms() {
        XCTAssertEqual(
            Xcode.normalizedDeveloperDirectory("/tmp/Xcode-Beta.app"),
            "/tmp/Xcode-Beta.app/Contents/Developer"
        )
        XCTAssertEqual(
            Xcode.normalizedDeveloperDirectory("/tmp/CustomXcode.app/Contents/Developer"),
            "/tmp/CustomXcode.app/Contents/Developer"
        )
    }

    func testSelectedXcodeFallsBackToLegacySimulatorWhenDeviceHubIsMissing() {
        let developer = "/tmp/Xcode-26.app/Contents/Developer"
        let selected = Xcode.selectedUIApplication(
            developerDirectory: developer,
            fileExists: { path in
                path == "/tmp/Xcode-26.app/Contents/Developer/Applications/Simulator.app"
            }
        )
        XCTAssertEqual(selected?.kind, .simulator)
        XCTAssertEqual(
            selected?.path,
            "/tmp/Xcode-26.app/Contents/Developer/Applications/Simulator.app"
        )
    }

    func testCapabilityRequiresSelectedXcodeDevicectlAndOrientationHelp() {
        var calls = 0
        let runner: DeviceHubOrientation.CommandRunner = { _, _, _ in
            calls += 1
            return ProcessResult(
                status: 0,
                output: "Set Device Orientation\nlandscapeLeft\n",
                error: ""
            )
        }
        let supported = try? DeviceHubOrientation.isSupported(
            developerDirectory: "/tmp/Xcode.app/Contents/Developer",
            fileExists: { $0.hasSuffix("/usr/bin/devicectl") },
            runCommand: runner
        )
        XCTAssertEqual(supported, true)
        XCTAssertEqual(calls, 1)

        let unavailable = try? DeviceHubOrientation.isSupported(
            developerDirectory: "/tmp/Xcode.app/Contents/Developer",
            fileExists: { _ in false },
            runCommand: runner
        )
        XCTAssertEqual(unavailable, false)
        XCTAssertEqual(calls, 1)
    }

    func testCapabilityTimeoutDoesNotSelectLegacyFallback() {
        XCTAssertThrowsError(
            try DeviceHubOrientation.isSupported(
                developerDirectory: "/tmp/Xcode.app/Contents/Developer",
                fileExists: { _ in true },
                runCommand: { _, _, _ in
                    ProcessResult(status: 124, output: "", error: "Command exceeded its deadline")
                }
            )
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "ORIENTATION_DEVICECTL_CAPABILITY_TIMEOUT")
        }
    }

    func testOperationalCapabilityFailureDoesNotSelectLegacyFallback() {
        XCTAssertThrowsError(
            try DeviceHubOrientation.isSupported(
                developerDirectory: "/tmp/Xcode.app/Contents/Developer",
                fileExists: { _ in true },
                runCommand: { _, _, _ in
                    ProcessResult(status: 1, output: "", error: "Xcode installation unavailable")
                }
            )
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "ORIENTATION_DEVICECTL_CAPABILITY_FAILED")
        }
    }

    func testSetOrientationUsesQuietJsonDeviceHubCommand() throws {
        var calls: [(String, [String], TimeInterval?)] = []
        let runner: DeviceHubOrientation.CommandRunner = { executable, arguments, timeout in
            calls.append((executable, arguments, timeout))
            if arguments.contains("--help") {
                return ProcessResult(
                    status: 0,
                    output: "Set Device Orientation\nlandscapeLeft\n",
                    error: ""
                )
            }
            return ProcessResult(status: 0, output: "{\"outcome\":\"success\"}", error: "")
        }
        XCTAssertTrue(
            try DeviceHubOrientation.setOrientation(
                udid: "ED63A17F-F1EC-4B95-B2B6-C78450FD3AE9",
                name: "landscape-right",
                developerDirectory: "/tmp/Xcode.app/Contents/Developer",
                fileExists: { $0.hasSuffix("/usr/bin/devicectl") },
                runCommand: runner
            )
        )
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[1].0, "/tmp/Xcode.app/Contents/Developer/usr/bin/devicectl")
        XCTAssertEqual(
            calls[1].1,
            [
                "--quiet", "--json-output", "-", "device", "orientation", "set",
                "--device", "ED63A17F-F1EC-4B95-B2B6-C78450FD3AE9", "landscapeLeft",
            ]
        )
        XCTAssertEqual(calls[1].2, DeviceHubOrientation.commandTimeout)
    }

    func testUnsupportedCommandReturnsFalseForLegacyFallback() throws {
        let runner: DeviceHubOrientation.CommandRunner = { _, arguments, _ in
            if arguments.contains("--help") {
                return ProcessResult(status: 0, output: "Set Device Orientation\nlandscapeLeft\n", error: "")
            }
            return ProcessResult(status: 64, output: "", error: "orientation is not supported")
        }
        XCTAssertFalse(
            try DeviceHubOrientation.setOrientation(
                udid: "fixture",
                name: "portrait",
                developerDirectory: "/tmp/Xcode.app/Contents/Developer",
                fileExists: { _ in true },
                runCommand: runner
            )
        )
    }

    func testTimeoutDoesNotSilentlyFallBackToLegacyOrientation() {
        let runner: DeviceHubOrientation.CommandRunner = { _, arguments, _ in
            if arguments.contains("--help") {
                return ProcessResult(status: 0, output: "Set Device Orientation\nlandscapeLeft\n", error: "")
            }
            return ProcessResult(status: 124, output: "", error: "Command exceeded its deadline")
        }
        XCTAssertThrowsError(
            try DeviceHubOrientation.setOrientation(
                udid: "fixture",
                name: "portrait",
                developerDirectory: "/tmp/Xcode.app/Contents/Developer",
                fileExists: { _ in true },
                runCommand: runner
            )
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "ORIENTATION_DEVICECTL_TIMEOUT")
        }
    }

    func testInvalidOrientationFailsBeforeCapabilityProbe() {
        var called = false
        XCTAssertThrowsError(
            try DeviceHubOrientation.setOrientation(
                udid: "fixture",
                name: "sideways",
                fileExists: { _ in
                    called = true
                    return true
                },
                runCommand: { _, _, _ in
                    called = true
                    return ProcessResult(status: 0, output: "", error: "")
                }
            )
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "ORIENTATION_INVALID")
        }
        XCTAssertFalse(called)
    }
}
