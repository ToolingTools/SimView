import XCTest

@testable import SimViewCore

final class DeviceBackendRouteTests: XCTestCase {
    func testPhysicalIOSNeverUsesSimulatorRoute() {
        XCTAssertEqual(DeviceBackendRoute(device(platform: .ios, kind: .physical)), .iosPhysical)
        XCTAssertEqual(DeviceBackendRoute(device(platform: .ios, kind: .simulator)), .iosSimulator)
        XCTAssertEqual(DeviceBackendRoute(device(platform: .android, kind: .physical)), .android)
        XCTAssertEqual(DeviceBackendRoute(device(platform: .android, kind: .emulator)), .android)
    }

    private func device(platform: DevicePlatform, kind: DeviceKind) -> DeviceDescription {
        DeviceDescription(
            id: "\(platform.rawValue):test",
            platform: platform,
            kind: kind,
            nativeIdentifier: "test",
            name: "Test",
            state: "ready",
            runtime: "Test",
            available: true,
            pixelWidth: nil,
            pixelHeight: nil,
            metadata: [:]
        )
    }
}
