import Darwin
import Foundation
import XCTest

@testable import SimViewCore

private final class FailingPointProvider: XCTestAccessibilityProviding {
    private(set) var pointRequestCount = 0
    private(set) var stopCount = 0

    func snapshot(bundleID _: String, maxNodes _: Int, timeout _: TimeInterval) throws -> [String: Any] {
        [:]
    }

    func elementAtPoint(bundleID _: String, x _: Double, y _: Double, timeout _: TimeInterval) throws -> [String: Any] {
        pointRequestCount += 1
        throw SimViewError("XCTEST_PROVIDER_DISCONNECTED", "Provider disconnected")
    }

    func stop() {
        stopCount += 1
    }
}

private final class CountingProvider: XCTestAccessibilityProviding {
    private(set) var stopCount = 0
    private(set) var targets: [String] = []
    var afterSnapshot: (() -> Void)?

    func snapshot(bundleID: String, maxNodes _: Int, timeout _: TimeInterval) throws -> [String: Any] {
        targets.append(bundleID)
        afterSnapshot?()
        return ["source": "core-simulator-xctest", "root": ["role": "AXApplication", "label": bundleID]]
    }

    func elementAtPoint(bundleID _: String, x _: Double, y _: Double, timeout _: TimeInterval) throws -> [String: Any] {
        [:]
    }

    func stop() { stopCount += 1 }
}

final class XCTestAccessibilityProviderTests: XCTestCase {
    func testSnapshotsFollowForegroundWithoutRestartingProvider() throws {
        let provider = CountingProvider()
        var foreground: String? = "dev.example.first"
        var starts = 0
        let service = AccessibilityService(foregroundBundleID: { _ in foreground }) { _, _ in
            starts += 1
            return provider
        }
        _ = try service.enableXCTestProvider(udid: "test", bundleID: "dev.example.first")
        for bundleID in ["dev.example.first", "dev.example.second", "dev.example.first"] {
            foreground = bundleID
            let snapshot = try service.snapshot(udid: "test")
            XCTAssertEqual((snapshot["root"] as? [String: Any])?["label"] as? String, bundleID)
        }
        XCTAssertEqual(provider.targets, ["dev.example.first", "dev.example.second", "dev.example.first"])
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(provider.stopCount, 0)
        foreground = nil
        XCTAssertThrowsError(try service.snapshot(udid: "test"))
        XCTAssertEqual(provider.targets.count, 3)
        XCTAssertEqual(provider.stopCount, 0)
        foreground = "dev.example.second"
        _ = try service.snapshot(udid: "test")
        XCTAssertEqual(provider.targets.last, "dev.example.second")
    }

    func testForegroundChangeDuringSnapshotDiscardsResultAndKeepsProvider() throws {
        let provider = CountingProvider()
        var foreground = "dev.example.first"
        let service = AccessibilityService(foregroundBundleID: { _ in foreground }) { _, _ in provider }
        _ = try service.enableXCTestProvider(udid: "test", bundleID: foreground)
        provider.afterSnapshot = { foreground = "dev.example.second" }
        XCTAssertThrowsError(try service.snapshot(udid: "test"))
        XCTAssertEqual(provider.stopCount, 0)
        provider.afterSnapshot = nil
        let recovered = try service.snapshot(udid: "test")
        XCTAssertEqual((recovered["root"] as? [String: Any])?["label"] as? String, foreground)
    }

    func testShutdownStopsAllProvidersIdempotently() throws {
        let provider = CountingProvider()
        let service = AccessibilityService(foregroundBundleID: { _ in "dev.example.app" }) { _, _ in provider }
        _ = try service.enableXCTestProvider(udid: "test-simulator", bundleID: "dev.example.app")

        service.shutdown()
        service.shutdown()

        XCTAssertEqual(provider.stopCount, 1)
        XCTAssertEqual(
            service.providerStatus(udid: "test-simulator", assessLegacy: false)["status"] as? String,
            "native-ready"
        )
    }

    func testStopTerminatesReapsProcessAndRemovesConfiguration() throws {
        var sockets: [Int32] = [0, 0]
        XCTAssertEqual(Darwin.socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
        defer { Darwin.close(sockets[1]) }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "trap 'exit 77' TERM; while true; do :; done"]
        try process.run()
        defer {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }

        let configurationURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            "simview-xctest-test-\(UUID().uuidString).xctestrun"
        )
        defer { try? FileManager.default.removeItem(at: configurationURL) }
        try Data("test".utf8).write(to: configurationURL)
        let session = XCTestAccessibilityProviderSession(
            connection: sockets[0],
            process: process,
            configuredXCTestRunURL: configurationURL
        )

        let startedAt = Date()
        session.stop()
        session.stop()

        XCTAssertFalse(process.isRunning)
        XCTAssertEqual(process.terminationReason, .uncaughtSignal)
        XCTAssertEqual(process.terminationStatus, SIGKILL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: configurationURL.path))
        XCTAssertLessThan(Date().timeIntervalSince(startedAt), 4.5)
    }

    func testPointFailureStopsAndEvictsProviderBeforeLegacyFallback() throws {
        let provider = FailingPointProvider()
        let service = AccessibilityService(foregroundBundleID: { _ in "dev.example.app" }) { _, _ in provider }
        _ = try service.enableXCTestProvider(udid: "missing-simulator", bundleID: "dev.example.app")

        XCTAssertThrowsError(try service.elementAtPoint(udid: "missing-simulator", x: 0.5, y: 0.5))
        XCTAssertThrowsError(try service.elementAtPoint(udid: "missing-simulator", x: 0.5, y: 0.5))
        XCTAssertEqual(provider.pointRequestCount, 1)
        XCTAssertEqual(provider.stopCount, 1)
    }

    func testRuntimeConfigurationAddsPrivateSessionValuesAndAbsolutePaths() throws {
        let source: [String: Any] = [
            "ProviderTests": [
                "EnvironmentVariables": ["TERM": "dumb"],
                "TestHostPath": "__TESTROOT__/Debug-iphonesimulator/Runner.app",
                "TestBundlePath": "__TESTHOST__/PlugIns/Tests.xctest",
            ],
            "__xctestrun_metadata__": ["FormatVersion": 1],
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: source,
            format: .binary,
            options: 0
        )
        let root = URL(fileURLWithPath: "/private/tmp/provider")
        let artifacts = XCTestProviderArtifacts(
            xctestrunURL: root.appendingPathComponent("Provider.xctestrun"),
            productsURL: root.appendingPathComponent("Debug-iphonesimulator")
        )

        let configured = try XCTestProviderConfiguration.configuredXCTestRun(
            source: data,
            artifacts: artifacts,
            targetBundleID: "dev.example.app",
            port: 41_234,
            token: String(repeating: "a", count: 64)
        )
        let decoded = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: configured, options: [], format: nil)
                as? [String: Any]
        )
        let target = try XCTUnwrap(decoded["ProviderTests"] as? [String: Any])
        let environment = try XCTUnwrap(target["EnvironmentVariables"] as? [String: String])
        XCTAssertEqual(environment["TERM"], "dumb")
        XCTAssertEqual(environment["SIMVIEW_XCTEST_MODE"], "persistent")
        XCTAssertEqual(environment["SIMVIEW_XCTEST_TARGET_BUNDLE_ID"], "dev.example.app")
        XCTAssertEqual(environment["SIMVIEW_XCTEST_PORT"], "41234")
        XCTAssertEqual(environment["SIMVIEW_XCTEST_TOKEN"], String(repeating: "a", count: 64))
        XCTAssertEqual(
            target["TestHostPath"] as? String,
            "/private/tmp/provider/Debug-iphonesimulator/Runner.app"
        )
        XCTAssertEqual(
            target["TestBundlePath"] as? String,
            "/private/tmp/provider/Debug-iphonesimulator/SimViewXCTestProbeUITests-Runner.app/PlugIns/Tests.xctest"
        )
    }

    func testMessageCodecRoundTripsPartialSocketWrites() throws {
        var sockets: [Int32] = [0, 0]
        XCTAssertEqual(Darwin.socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
        defer {
            Darwin.close(sockets[0])
            Darwin.close(sockets[1])
        }

        try XCTestProviderMessageCodec.write(
            ["id": "7", "result": ["ready": true]],
            to: sockets[0],
            timeout: 1
        )
        let decoded = try XCTestProviderMessageCodec.read(from: sockets[1], timeout: 1)
        XCTAssertEqual(decoded["id"] as? String, "7")
        XCTAssertEqual((decoded["result"] as? [String: Any])?["ready"] as? Bool, true)
    }

    func testPersistentProviderAgainstSimulatorWhenConfigured() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let udid = environment["SIMVIEW_XCTEST_INTEGRATION_UDID"],
            let bundleID = environment["SIMVIEW_XCTEST_INTEGRATION_BUNDLE_ID"]
        else { throw XCTSkip("Set XCTest provider integration environment variables") }

        let session = try XCTestAccessibilityProviderSession.start(
            udid: udid,
            targetBundleID: bundleID,
            startupTimeout: 45
        )
        defer { session.stop() }
        let first = try session.snapshot(bundleID: bundleID, maxNodes: 5_000, timeout: 5)
        let second = try session.snapshot(bundleID: bundleID, maxNodes: 5_000, timeout: 5)
        XCTAssertEqual(first["source"] as? String, "core-simulator-xctest")
        XCTAssertEqual(second["source"] as? String, "core-simulator-xctest")
        XCTAssertNotEqual(first["snapshotId"] as? String, second["snapshotId"] as? String)
        XCTAssertGreaterThan(
            ((first["stats"] as? [String: Any])?["nodeCount"] as? NSNumber)?.intValue ?? 0,
            1
        )
        let tab = try session.elementAtPoint(bundleID: bundleID, x: 0.42, y: 0.94, timeout: 5)
        XCTAssertEqual(tab["label"] as? String, "Expenses")
    }
}
