import Foundation
import XCTest

@testable import SimViewCore

final class IOSRunnerLifecycleTests: XCTestCase {
    func testTeamSelectionParsesOnlyAppleDevelopmentIdentities() {
        let identities = """
              1) ABC "Apple Development: Example One (ABCDE12345)"
              2) DEF "Apple Distribution: Example One (ABCDE12345)"
              3) GHI "Apple Development: Example Two (ZYXWV98765)"
            """
        XCTAssertEqual(
            IOSRunnerLifecycle.developmentTeams(from: identities),
            Set(["ABCDE12345", "ZYXWV98765"])
        )
    }

    func testPrivateSessionFileInjectsTokenAndUsesMode0600() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("simview-runner-lifecycle-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let template = directory.appendingPathComponent("template.xctestrun")
        let output = directory.appendingPathComponent("session.xctestrun")
        let source: [String: Any] = [
            "SimViewIOSDeviceRunner": ["EnvironmentVariables": ["EXISTING": "yes"]],
            "__xctestrun_metadata__": ["FormatVersion": 2],
        ]
        try PropertyListSerialization.data(fromPropertyList: source, format: .xml, options: 0)
            .write(to: template)

        try IOSRunnerLifecycle.writeSessionXCTestRun(
            template: template,
            output: output,
            port: 12_345,
            token: String(repeating: "t", count: 64),
            appBundleID: "dev.example.app"
        )

        let attributes = try FileManager.default.attributesOfItem(atPath: output.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let result =
            try PropertyListSerialization.propertyList(
                from: Data(contentsOf: output), options: [], format: nil) as! [String: Any]
        let target = result["SimViewIOSDeviceRunner"] as! [String: Any]
        let variables = target["EnvironmentVariables"] as! [String: String]
        XCTAssertEqual(variables["SIMVIEW_RUNNER_PORT"], "12345")
        XCTAssertEqual(variables["SIMVIEW_TARGET_BUNDLE_ID"], "dev.example.app")
        XCTAssertEqual(variables["SIMVIEW_RUNNER_TOKEN"], String(repeating: "t", count: 64))
    }
}
