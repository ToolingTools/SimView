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
    let availability: IOSAccessibilityProviderAvailability
    let reason: String?
}

protocol XCTestAccessibilityProviding: AnyObject {
    func snapshot(maxNodes: Int, timeout: TimeInterval) throws -> [String: Any]
    func elementAtPoint(x: Double, y: Double, timeout: TimeInterval) throws -> [String: Any]
    func stop()
}
