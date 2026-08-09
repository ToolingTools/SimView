import XCTest

@testable import SimViewCore

final class NativeInputTests: XCTestCase {
    func testLiteralTextAcceptsPrintableUnicode() throws {
        XCTAssertNoThrow(try validateLiteralTextInput("Dinner with friends £42.80 🍽️"))
    }

    func testLiteralTextRejectsControlCharacters() throws {
        for value in ["\n", "\t", "\u{8}", "hello\rworld"] {
            XCTAssertThrowsError(try validateLiteralTextInput(value)) { error in
                XCTAssertEqual((error as? SimViewError)?.code, "SPECIAL_KEY_REQUIRES_PRESS_KEY")
            }
        }
    }
}
