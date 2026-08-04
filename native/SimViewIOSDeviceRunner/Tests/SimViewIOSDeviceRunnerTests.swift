import XCTest

@MainActor
final class SimViewIOSDeviceRunnerTests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        executionTimeAllowance = 86_400
    }

    func testServe() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard
            let portString = environment["SIMVIEW_RUNNER_PORT"],
            let port = UInt16(portString),
            let token = environment["SIMVIEW_RUNNER_TOKEN"]
        else {
            throw XCTSkip(
                "SIMVIEW_RUNNER_PORT and SIMVIEW_RUNNER_TOKEN are supplied by simview-core"
            )
        }

        let server = try RunnerServer(
            port: port,
            token: token,
            initialBundleID: environment["SIMVIEW_TARGET_BUNDLE_ID"]
        )
        addTeardownBlock { @MainActor in server.stop() }
        try server.start()
        await server.waitUntilStopped()
    }

    func testProtocolFrameRoundTrip() throws {
        let original = RunnerFrame(kind: .request, payload: Data("{}".utf8))
        var decoder = RunnerFrameDecoder()
        XCTAssertTrue(try decoder.append(original.encoded.prefix(3)).isEmpty)
        let decoded = try decoder.append(original.encoded.dropFirst(3))
        XCTAssertEqual(decoded.count, 1)
        XCTAssertEqual(decoded.first?.kind, .request)
        XCTAssertEqual(decoded.first?.payload, original.payload)
    }

    func testProtocolRejectsOversizedFramesBeforeBufferingPayload() throws {
        var encoded = Data([RunnerFrameKind.request.rawValue])
        var length = UInt32(RunnerProtocol.maximumRequestPayload + 1).bigEndian
        withUnsafeBytes(of: &length) { encoded.append(contentsOf: $0) }
        var decoder = RunnerFrameDecoder()
        XCTAssertThrowsError(try decoder.append(encoded)) { error in
            XCTAssertEqual((error as? RunnerError)?.code, "PROTOCOL_FRAME_TOO_LARGE")
        }
    }

    func testNormalizedPointValidation() throws {
        let valid: [String: JSONValue] = [
            "point": .object(["x": .number(0.25), "y": .number(0.75)])
        ]
        XCTAssertEqual(try valid.normalizedPoint("point"), CGPoint(x: 0.25, y: 0.75))

        let invalid: [String: JSONValue] = [
            "point": .object(["x": .number(-0.1), "y": .number(0.5)])
        ]
        XCTAssertThrowsError(try invalid.normalizedPoint("point"))
    }
}
