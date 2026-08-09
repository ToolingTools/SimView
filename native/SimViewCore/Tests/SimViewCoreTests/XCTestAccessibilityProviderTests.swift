import Darwin
import Foundation
import XCTest

@testable import SimViewCore

final class XCTestAccessibilityProviderTests: XCTestCase {
    func testRouterUsesXCTestAsPrimaryForCompleteSnapshot() {
        let status = IOSAccessibilityProviderStatus(
            kind: .xctest,
            availability: .ready,
            reason: nil
        )
        let selection = IOSAccessibilityProviderRouter.selection(
            legacySnapshot: ["stats": ["quality": "complete"]],
            xctestStatus: status,
            environment: [:]
        )
        XCTAssertEqual(selection, .xctest)
    }

    func testRouterUsesXCTestForDegradedSnapshot() {
        let status = IOSAccessibilityProviderStatus(
            kind: .xctest,
            availability: .ready,
            reason: nil
        )
        let selection = IOSAccessibilityProviderRouter.selection(
            legacySnapshot: ["stats": ["quality": "degraded"]],
            xctestStatus: status,
            environment: [:]
        )
        XCTAssertEqual(selection, .xctest)
    }

    func testRouterFallsBackToAXPWhenXCTestIsUnavailableAndLegacyIsComplete() {
        let status = IOSAccessibilityProviderStatus(
            kind: .xctest,
            availability: .unavailable,
            reason: "artifacts-missing"
        )
        let selection = IOSAccessibilityProviderRouter.selection(
            legacySnapshot: ["stats": ["quality": "complete"]],
            xctestStatus: status,
            environment: [:]
        )
        XCTAssertEqual(selection, .axp)
    }

    func testRouterFailsClosedWhenForcedProviderIsUnavailable() {
        let status = IOSAccessibilityProviderStatus(
            kind: .xctest,
            availability: .unavailable,
            reason: "artifacts-missing"
        )
        let selection = IOSAccessibilityProviderRouter.selection(
            legacySnapshot: ["stats": ["quality": "complete"]],
            xctestStatus: status,
            environment: ["SIMVIEW_IOS_AX_PROVIDER": "xctest"]
        )
        XCTAssertEqual(selection, .unavailable(reason: "artifacts-missing"))
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
        let first = try session.snapshot(maxNodes: 5_000, timeout: 5)
        let second = try session.snapshot(maxNodes: 5_000, timeout: 5)
        XCTAssertEqual(first["source"] as? String, "core-simulator-xctest")
        XCTAssertEqual(second["source"] as? String, "core-simulator-xctest")
        XCTAssertNotEqual(first["snapshotId"] as? String, second["snapshotId"] as? String)
        XCTAssertGreaterThan(
            ((first["stats"] as? [String: Any])?["nodeCount"] as? NSNumber)?.intValue ?? 0,
            1
        )
        let tab = try session.elementAtPoint(x: 0.42, y: 0.94, timeout: 5)
        XCTAssertEqual(tab["label"] as? String, "Expenses")
    }
}
