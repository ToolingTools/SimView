import Darwin
import Foundation
import SimViewAXShim

/// The AX frontmost process is authoritative. Launch service roles describe
/// launch policy and can remain "ui focal" for multiple background apps.
enum SimulatorForegroundApplication {
    static func bundleID(udid: String) -> String? {
        guard let device = Xcode.object(udid: udid),
            let pid = SVAccessibilityBridge.frontmostProcessID(forDevice: device)?.intValue
        else { return nil }
        let listing = run(
            "/usr/bin/xcrun",
            ["simctl", "spawn", udid, "launchctl", "print", "user/\(getuid())"]
        )
        guard listing.status == 0,
            let bundleID = bundleID(in: listing.output, processID: pid),
            SVAccessibilityBridge.frontmostProcessID(forDevice: device)?.intValue == pid
        else { return nil }
        return bundleID
    }

    static func bundleID(in listing: String, processID: Int) -> String? {
        guard processID > 0 else { return nil }
        var matches = Set<String>()
        for line in listing.split(whereSeparator: \.isNewline) {
            let fields = line.split(whereSeparator: \.isWhitespace)
            guard fields.count == 3, Int(fields[0]) == processID,
                fields[2].hasPrefix("UIKitApplication:")
            else { continue }
            let application = fields[2].dropFirst("UIKitApplication:".count)
            guard let suffix = application.firstIndex(of: "[") else { continue }
            let bundleID = String(application[..<suffix])
            guard !bundleID.isEmpty else { continue }
            matches.insert(bundleID)
        }
        return matches.count == 1 ? matches.first : nil
    }
}
