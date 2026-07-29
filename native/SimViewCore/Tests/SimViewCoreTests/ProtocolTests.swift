import XCTest
@testable import SimViewCore

final class ProtocolTests: XCTestCase {
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
            ProbeCoordinator.focalBundleID("""
                state = running
                bundle id = com.example.app
                spawn role = ui focal (1)
                """),
            "com.example.app"
        )
        XCTAssertNil(
            ProbeCoordinator.focalBundleID("""
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
}
