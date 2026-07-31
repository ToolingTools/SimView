import CoreVideo
import XCTest

@testable import SimViewCore

final class ProtocolTests: XCTestCase {
    func testCanonicalHelloFixtureDecodes() throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../../tests/fixtures/protocol/hello.json")
            .standardized
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as! [String: Any]
        let requestData = try JSONSerialization.data(withJSONObject: object["request"] as Any)
        let request = try Request(data: requestData)

        XCTAssertEqual(request.protocolVersion, SimViewVersion.protocolVersion)
        XCTAssertEqual(request.method, "hello")
        XCTAssertEqual(request.params["codecs"]?.arrayValue?.compactMap(\.stringValue), ["h264", "mjpeg"])
    }

    func testJSONValueRoundTrip() throws {
        let value = JSONValue.object([
            "boolean": .bool(true),
            "number": .number(42),
            "array": .array([.string("value"), .null]),
        ])
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), value)
    }

    func testMetricsKeepABoundedLatencyWindow() {
        let metrics = Metrics()
        for value in 0..<2_100 {
            metrics.didEncode(latencyMS: Double(value))
        }
        let latency = metrics.dictionary["latencyMs"] as! [String: Double]
        XCTAssertGreaterThan(latency["p50"]!, 1_000)
        XCTAssertGreaterThan(latency["p95"]!, 1_900)
    }

    func testAccessibilitySelectorRequiresAMatchingField() throws {
        XCTAssertThrowsError(try validateAccessibilitySelector([:]))
        XCTAssertNoThrow(try validateAccessibilitySelector(["identifier": "submit"]))
        XCTAssertThrowsError(try validateAccessibilitySelector(["exact": true]))
    }

    func testFindsFocalUIKitApplicationBundleID() {
        let domain = """
            50359 - UIKitApplication:com.example.app[06ff][rb-legacy]
            4747 - UIKitApplication:com.apple.mobilecal[e65c][rb-legacy]
            """
        XCTAssertEqual(
            ProbeCoordinator.applicationServiceLabels(domain),
            [
                "UIKitApplication:com.example.app[06ff][rb-legacy]",
                "UIKitApplication:com.apple.mobilecal[e65c][rb-legacy]",
            ]
        )
        XCTAssertEqual(
            ProbeCoordinator.focalBundleID(
                """
                state = running
                bundle id = com.example.app
                spawn role = ui focal (1)
                """),
            "com.example.app"
        )
        XCTAssertNil(
            ProbeCoordinator.focalBundleID(
                """
                bundle id = com.example.background
                spawn role = background (2)
                """)
        )
    }

    func testFragmentedFrames() throws {
        let encoded = WireFrame(kind: .response, payload: Data("hello".utf8)).encoded
        var decoder = FrameDecoder()
        XCTAssertTrue(try decoder.append(encoded.prefix(3)).isEmpty)
        let frames = try decoder.append(encoded.dropFirst(3))
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].kind, .response)
        XCTAssertEqual(String(data: frames[0].payload, encoding: .utf8), "hello")
    }

    func testRejectsOversizedFrame() {
        var data = Data([FrameKind.request.rawValue])
        var length = UInt32(FrameDecoder.maximumPayload + 1).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        var decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.append(data))
    }

    func testCodecNegotiationHonorsClientPreference() {
        XCTAssertEqual(preferredCodec(["h264", "mjpeg"]), "h264")
        XCTAssertEqual(preferredCodec(["mjpeg", "h264"]), "mjpeg")
        XCTAssertEqual(preferredCodec(["av1", "mjpeg"]), "mjpeg")
        XCTAssertEqual(preferredCodec([]), "mjpeg")
    }

    func testH264EncoderAcceptsABGRAPixelBuffer() async throws {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            320,
            180,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
            &pixelBuffer
        )
        XCTAssertEqual(status, kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixelBuffer)
        let encoder = H264Encoder()
        let encoded = try await encoder.encode(buffer)
        XCTAssertFalse(encoded.bytes.isEmpty)
        XCTAssertTrue(encoded.keyframe)
        await encoder.stop()
    }
}
