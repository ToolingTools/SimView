import Foundation
import XCTest

@testable import SimViewCore

final class DeviceHubPasteboardTests: XCTestCase {
    private let developerDirectory = "/tmp/Xcode-27.app/Contents/Developer"
    private let executable = "/tmp/Xcode-27.app/Contents/Developer/usr/bin/devicectl"

    func testCopyUsesSelectedXcodeAndPreservesUTF8Input() throws {
        var calls: [(String, [String], Data?, TimeInterval?)] = []
        let runner: DeviceHubPasteboard.CommandRunner = { executable, arguments, input, timeout in
            calls.append((executable, arguments, input, timeout))
            if arguments.contains("--help") {
                return ProcessResult(
                    status: 0,
                    output: "Reads data from stdin\nUSAGE: devicectl device pasteboard copy --device <udid>",
                    error: ""
                )
            }
            return ProcessResult(status: 0, output: "", error: "")
        }

        XCTAssertTrue(
            try DeviceHubPasteboard.copy(
                udid: "fixture-udid",
                text: "Café €",
                developerDirectory: developerDirectory,
                fileExists: { $0 == executable },
                runCommand: runner
            )
        )
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].0, executable)
        XCTAssertEqual(calls[0].1, ["device", "pasteboard", "copy", "--help"])
        XCTAssertEqual(calls[0].3, DeviceHubPasteboard.capabilityTimeout)
        XCTAssertEqual(
            calls[1].1,
            ["device", "pasteboard", "copy", "--device", "fixture-udid", "--quiet", "--timeout", "5"]
        )
        XCTAssertEqual(calls[1].2, Data("Café €".utf8))
        XCTAssertEqual(calls[1].3, DeviceHubPasteboard.commandTimeout)
    }

    func testMissingOrUnsupportedDeviceHubAllowsLegacyFallback() throws {
        var calls = 0
        let runner: DeviceHubPasteboard.CommandRunner = { _, _, _, _ in
            calls += 1
            return ProcessResult(status: 64, output: "", error: "unknown command pasteboard")
        }
        XCTAssertFalse(
            try DeviceHubPasteboard.copy(
                udid: "fixture",
                text: "Café",
                developerDirectory: developerDirectory,
                fileExists: { _ in false },
                runCommand: runner
            )
        )
        XCTAssertEqual(calls, 0)
        XCTAssertFalse(
            try DeviceHubPasteboard.copy(
                udid: "fixture",
                text: "Café",
                developerDirectory: developerDirectory,
                fileExists: { $0 == executable },
                runCommand: runner
            )
        )
        XCTAssertEqual(calls, 1)
    }

    func testGenericParentHelpDoesNotClaimPasteboardCapability() throws {
        let supportedWords = "Commands: pasteboard, copy, device"
        XCTAssertFalse(
            try DeviceHubPasteboard.copy(
                udid: "fixture",
                text: "Café",
                developerDirectory: developerDirectory,
                fileExists: { $0 == executable },
                runCommand: { _, _, _, _ in
                    ProcessResult(status: 0, output: supportedWords, error: "")
                }
            )
        )
    }

    func testCapabilityTimeoutDoesNotAllowFallback() {
        XCTAssertThrowsError(
            try DeviceHubPasteboard.copy(
                udid: "fixture",
                text: "Café",
                developerDirectory: developerDirectory,
                fileExists: { _ in true },
                runCommand: { _, _, _, _ in
                    ProcessResult(status: 124, output: "", error: "Command exceeded its deadline")
                }
            )
        ) { error in
            XCTAssertEqual(
                (error as? SimViewError)?.code,
                "PASTEBOARD_DEVICECTL_CAPABILITY_TIMEOUT"
            )
        }
    }

    func testCopyTimeoutDoesNotAllowFallback() {
        var calls = 0
        XCTAssertThrowsError(
            try DeviceHubPasteboard.copy(
                udid: "fixture",
                text: "Café",
                developerDirectory: developerDirectory,
                fileExists: { _ in true },
                runCommand: { _, arguments, _, _ in
                    calls += 1
                    if arguments.contains("--help") {
                        return ProcessResult(
                            status: 0,
                            output: "Reads data from stdin\nUSAGE: devicectl device pasteboard copy --device <udid>",
                            error: ""
                        )
                    }
                    return ProcessResult(status: 124, output: "", error: "Command exceeded its deadline")
                }
            )
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "PASTEBOARD_DEVICECTL_TIMEOUT")
        }
        XCTAssertEqual(calls, 2)
    }

    func testOperationalCopyFailureDoesNotAllowFallback() {
        var calls = 0
        XCTAssertThrowsError(
            try DeviceHubPasteboard.copy(
                udid: "fixture",
                text: "Café",
                developerDirectory: developerDirectory,
                fileExists: { _ in true },
                runCommand: { _, arguments, _, _ in
                    calls += 1
                    if arguments.contains("--help") {
                        return ProcessResult(
                            status: 0,
                            output: "Reads data from stdin\nUSAGE: devicectl device pasteboard copy --device <udid>",
                            error: ""
                        )
                    }
                    return ProcessResult(status: 1, output: "", error: "device unavailable")
                }
            )
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "PASTEBOARD_DEVICECTL_FAILED")
        }
        XCTAssertEqual(calls, 2)
    }
}
