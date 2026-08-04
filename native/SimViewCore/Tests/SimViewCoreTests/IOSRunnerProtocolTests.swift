import Foundation
import XCTest

@testable import SimViewCore

final class IOSRunnerProtocolTests: XCTestCase {
    func testRunnerProtocolVersionIsIndependentAndPinned() {
        XCTAssertEqual(IOSRunnerConnection.protocolVersion, 1)
        XCTAssertNotEqual(IOSRunnerConnection.protocolVersion, SimViewVersion.protocolVersion)
    }
}
