import Foundation

enum IOSAccessibilityProviderKind: String, Sendable {
    case axp = "core-simulator-ax"
    case xctest = "core-simulator-xctest"
}

enum IOSAccessibilityProviderAvailability: String, Sendable {
    case ready
    case unavailable
}

struct IOSAccessibilityProviderStatus: Sendable {
    let kind: IOSAccessibilityProviderKind
    let availability: IOSAccessibilityProviderAvailability
    let reason: String?

    var dictionary: [String: Any] {
        var result: [String: Any] = [
            "provider": kind.rawValue,
            "availability": availability.rawValue,
        ]
        if let reason { result["reason"] = reason }
        return result
    }
}

protocol IOSAccessibilityProviding: AnyObject {
    var kind: IOSAccessibilityProviderKind { get }
    var status: IOSAccessibilityProviderStatus { get }

    func snapshot(maxNodes: Int, timeout: TimeInterval) throws -> [String: Any]
    func elementAtPoint(x: Double, y: Double, timeout: TimeInterval) throws -> [String: Any]
    func stop()
}

enum IOSAccessibilityProviderSelection: Equatable, Sendable {
    case axp
    case xctest
    case unavailable(reason: String)
}

enum IOSAccessibilityProviderRouter {
    static func selection(
        legacySnapshot: [String: Any]?,
        xctestStatus: IOSAccessibilityProviderStatus,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> IOSAccessibilityProviderSelection {
        let requested = environment["SIMVIEW_IOS_AX_PROVIDER"]?.lowercased() ?? "auto"
        switch requested {
        case "axp":
            return .axp
        case "xctest":
            guard xctestStatus.availability == .ready else {
                return .unavailable(reason: xctestStatus.reason ?? "xctest-provider-unavailable")
            }
            return .xctest
        case "auto":
            if xctestStatus.availability == .ready { return .xctest }
            guard legacySnapshotIsDegraded(legacySnapshot) else { return .axp }
            return .unavailable(reason: xctestStatus.reason ?? "xctest-provider-unavailable")
        default:
            return .unavailable(reason: "invalid-provider-override")
        }
    }

    static func legacySnapshotIsDegraded(_ snapshot: [String: Any]?) -> Bool {
        guard let snapshot else { return true }
        let quality = (snapshot["stats"] as? [String: Any])?["quality"] as? String
        return quality == "degraded" || quality == "partial"
    }
}
