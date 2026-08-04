import Foundation
import XCTest

@testable import SimViewCore

final class IOSInstalledAppsTests: XCTestCase {
    func testParsesCoreDeviceAppVariants() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "result": [
                "apps": [
                    [
                        "bundleIdentifier": "dev.example.beta",
                        "name": "Beta",
                        "version": "1.2",
                        "build": "9",
                        "isRemovable": true,
                        "isLaunchable": true,
                    ],
                    [
                        "bundleID": "com.apple.Preferences",
                        "displayName": "Settings",
                        "isSystemApp": true,
                    ],
                ]
            ]
        ])

        let apps = try IOSInstalledAppProvider.parse(data)
        XCTAssertEqual(apps.count, 2)
        XCTAssertEqual(apps[0].bundleID, "dev.example.beta")
        XCTAssertEqual(apps[0].version, "1.2")
        XCTAssertFalse(apps[0].system)
        XCTAssertTrue(apps[1].system)
    }

    func testRejectsMalformedAndOversizedListings() {
        XCTAssertThrowsError(try IOSInstalledAppProvider.parse(Data("[]".utf8)))
        XCTAssertThrowsError(try IOSInstalledAppProvider.parse(Data(repeating: 0, count: 16 * 1024 * 1024 + 1)))
    }
}
