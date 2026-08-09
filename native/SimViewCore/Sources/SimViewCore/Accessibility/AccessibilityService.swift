import Foundation
import SimViewAXShim

private let accessibilityRootRetryAttempts = 3
private let accessibilityRootRetryDelay: TimeInterval = 0.025

func isTransientRootOnlyAccessibilitySnapshot(_ snapshot: [String: Any]) -> Bool {
    guard
        let root = snapshot["root"] as? [String: Any],
        let stats = snapshot["stats"] as? [String: Any],
        (stats["truncated"] as? Bool) != true,
        (stats["nodeCount"] as? NSNumber)?.intValue == 1,
        ((root["children"] as? [Any])?.isEmpty ?? true)
    else { return false }

    let role = (root["role"] as? String ?? "").lowercased()
    guard role.contains("application") else { return false }

    let meaningfulKeys = ["identifier", "label", "title", "value", "help", "placeholder"]
    let hasMeaningfulText = meaningfulKeys.contains { key in
        guard let value = root[key] as? String else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let hasActions = (root["actions"] as? [Any])?.isEmpty == false
    guard !hasMeaningfulText, !hasActions else { return false }

    guard let points = (root["frame"] as? [String: Any])?["points"] as? [String: Any] else {
        return true
    }
    let width = (points["width"] as? NSNumber)?.doubleValue ?? 0
    let height = (points["height"] as? NSNumber)?.doubleValue ?? 0
    return width <= 0 || height <= 0
}

func captureAccessibilitySnapshotWithRetry(
    maximumAttempts: Int = accessibilityRootRetryAttempts,
    delay: () -> Void = { Thread.sleep(forTimeInterval: accessibilityRootRetryDelay) },
    capture: () throws -> [String: Any]
) throws -> [String: Any] {
    let attempts = max(1, maximumAttempts)
    var lastTransientSnapshot: [String: Any]?
    for attempt in 1...attempts {
        let snapshot = try capture()
        guard isTransientRootOnlyAccessibilitySnapshot(snapshot) else { return snapshot }
        lastTransientSnapshot = snapshot
        if attempt < attempts { delay() }
    }

    guard var snapshot = lastTransientSnapshot else {
        throw SimViewError(
            "ACCESSIBILITY_UNAVAILABLE",
            "Accessibility translation did not produce a usable snapshot"
        )
    }
    var stats = snapshot["stats"] as? [String: Any] ?? [:]
    stats["quality"] = "degraded"
    stats["reason"] = "root-only-application"
    snapshot["stats"] = stats
    return snapshot
}

func validateAccessibilitySelector(_ selector: [String: Any]) throws {
    let fields = ["ref", "identifier", "role", "name", "value", "placeholder"]
    let hasMatchingField = fields.contains { key in
        guard let value = selector[key] as? String else { return false }
        return !value.isEmpty
    }
    guard hasMatchingField else {
        throw SimViewError(
            "PARAMETER_INVALID",
            "An accessibility selector requires ref, identifier, role, name, value, or placeholder"
        )
    }
}

func normalizedAccessibilityTextValue(_ value: Any?) -> String? {
    SVAccessibilityStringValue(value)
}

func projectAccessibilitySnapshot(
    _ input: [String: Any],
    scope: String
) throws -> [String: Any] {
    guard ["full", "visible", "interactive"].contains(scope) else {
        throw SimViewError(
            "PARAMETER_INVALID",
            "accessibility scope must be full, visible, or interactive"
        )
    }
    guard let root = input["root"] as? [String: Any] else { return input }

    var snapshot = input
    let classified = classifyAccessibilitySnapshot(snapshot)
    snapshot = classified.snapshot

    let projectedRoot: [String: Any]?
    switch scope {
    case "full":
        projectedRoot = root
    case "visible":
        projectedRoot = projectAccessibilityNode(root, visibleOnly: true, interactiveOnly: false)
    default:
        projectedRoot = projectAccessibilityNode(root, visibleOnly: true, interactiveOnly: true)
    }
    snapshot["root"] = projectedRoot ?? rootWithoutChildren(root)

    var stats = snapshot["stats"] as? [String: Any] ?? [:]
    let capturedCount = (stats["nodeCount"] as? NSNumber)?.intValue ?? countAccessibilityNodes(root)
    let projectedCount = countAccessibilityNodes(snapshot["root"] as? [String: Any] ?? [:])
    stats["projectedNodeCount"] = projectedCount
    stats["droppedChildCount"] = max(0, capturedCount - projectedCount)
    stats["provider"] = stats["provider"] ?? snapshot["source"] ?? "core-simulator-ax"
    snapshot["stats"] = stats
    snapshot["scope"] = scope
    return snapshot
}

func classifyAccessibilitySnapshot(
    _ input: [String: Any]
) -> (snapshot: [String: Any], hollowContainerCount: Int) {
    guard let root = input["root"] as? [String: Any] else { return (input, 0) }
    let hollowCount = countHollowAccessibilityContainers(root)
    var snapshot = input
    var stats = snapshot["stats"] as? [String: Any] ?? [:]
    stats["hollowContainerCount"] = hollowCount
    stats["provider"] = stats["provider"] ?? snapshot["source"] ?? "core-simulator-ax"
    if hollowCount > 0, (stats["truncated"] as? Bool) != true {
        stats["quality"] = "degraded"
        stats["reason"] = "hollow-native-containers"
    }
    snapshot["stats"] = stats
    return (snapshot, hollowCount)
}

private func projectAccessibilityNode(
    _ node: [String: Any],
    visibleOnly: Bool,
    interactiveOnly: Bool
) -> [String: Any]? {
    guard node["hidden"] as? Bool != true else { return nil }
    let children = accessibilityChildDictionaries(node).compactMap {
        projectAccessibilityNode($0, visibleOnly: visibleOnly, interactiveOnly: interactiveOnly)
    }
    let isVisible = !visibleOnly || accessibilityNodeIsVisible(node)
    let isUseful = !interactiveOnly || accessibilityNodeIsInteractive(node)
    guard !children.isEmpty || (isVisible && isUseful) else { return nil }

    var value = node
    if children.isEmpty {
        value.removeValue(forKey: "children")
    } else {
        value["children"] = children
    }
    return value
}

private func accessibilityNodeIsVisible(_ node: [String: Any]) -> Bool {
    if let fraction = accessibilityNumber(node["visibleFraction"]) { return fraction > 0 }
    return accessibilityFrameHasPositiveArea(node)
}

private func accessibilityNodeIsInteractive(_ node: [String: Any]) -> Bool {
    let role = (node["role"] as? String ?? "").lowercased()
    let usefulRoles = [
        "button", "checkbox", "link", "menu", "radio", "search", "slider",
        "switch", "textfield", "textarea", "tab", "statictext", "heading",
    ]
    return usefulRoles.contains { role.contains($0) }
        || (node["actions"] as? [Any])?.isEmpty == false
        || ["identifier", "label", "title"].contains { node[$0] != nil }
}

private func countHollowAccessibilityContainers(_ node: [String: Any]) -> Int {
    let children = accessibilityChildDictionaries(node)
    var count = children.reduce(0) { $0 + countHollowAccessibilityContainers($1) }
    guard accessibilityNodeIsVisible(node), hollowContainerKind(node) != nil else { return count }
    let hasExpectedDescendant = children.contains { accessibilitySubtreeHasActionableNode($0) }
    if !hasExpectedDescendant { count += 1 }
    return count
}

private func hollowContainerKind(_ node: [String: Any]) -> String? {
    let description = ["role", "subrole", "roleDescription", "label", "title"]
        .compactMap { node[$0] as? String }
        .joined(separator: " ")
        .lowercased()
        .replacingOccurrences(of: "_", with: " ")
    if description.contains("tabgroup") || description.contains("tab group")
        || description.contains("tab bar")
    {
        return "tab"
    }
    if description.contains("navigation bar") || description.contains("nav bar")
        || description.contains("toolbar")
    {
        return "navigation"
    }
    return nil
}

private func accessibilitySubtreeHasActionableNode(_ node: [String: Any]) -> Bool {
    let role = (node["role"] as? String ?? "").lowercased()
    if ["button", "radio", "tab", "menu"].contains(where: role.contains)
        || (node["actions"] as? [Any])?.isEmpty == false
    {
        return true
    }
    return accessibilityChildDictionaries(node).contains(where: accessibilitySubtreeHasActionableNode)
}

private func accessibilityFrameHasPositiveArea(_ node: [String: Any]) -> Bool {
    guard let points = (node["frame"] as? [String: Any])?["points"] as? [String: Any] else {
        return false
    }
    return (accessibilityNumber(points["width"]) ?? 0) > 0
        && (accessibilityNumber(points["height"]) ?? 0) > 0
}

private func countAccessibilityNodes(_ node: [String: Any]) -> Int {
    guard !node.isEmpty else { return 0 }
    return 1 + accessibilityChildDictionaries(node).reduce(0) { $0 + countAccessibilityNodes($1) }
}

private func rootWithoutChildren(_ root: [String: Any]) -> [String: Any] {
    var value = root
    value.removeValue(forKey: "children")
    return value
}

private func accessibilityNumber(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
}

private func accessibilityChildDictionaries(_ node: [String: Any]) -> [[String: Any]] {
    (node["children"] as? [Any] ?? []).compactMap { child in
        if let child = child as? [String: Any] { return child }
        if let child = child as? NSDictionary { return child as? [String: Any] }
        return nil
    }
}

final class AccessibilityService: @unchecked Sendable {
    private var screenBounds: [String: (width: Double, height: Double)] = [:]
    private var xctestProviders: [String: XCTestAccessibilityProviderSession] = [:]
    private var xctestBundleIDs: [String: String] = [:]
    private let observation: AccessibilityObservationCoordinator
    private var observedUDID: String?
    private(set) var observationStrategy = "snapshot-diff"

    init(observation: AccessibilityObservationCoordinator = AccessibilityObservationCoordinator()) {
        self.observation = observation
    }

    deinit {
        for provider in xctestProviders.values { provider.stop() }
    }

    var available: Bool {
        SVAccessibilityBridge.isAvailable()
            || XCTestAccessibilityProviderSession.availability().availability == .ready
    }

    func providerStatus(udid: String, assessLegacy: Bool = true) -> [String: Any] {
        if xctestProviders[udid] != nil {
            var result: [String: Any] = [
                "schemaVersion": 1,
                "status": "enhanced-ready",
                "activeProvider": IOSAccessibilityProviderKind.xctest.rawValue,
            ]
            if let bundleID = xctestBundleIDs[udid] { result["bundleId"] = bundleID }
            return result
        }
        let availability = XCTestAccessibilityProviderSession.availability()
        guard assessLegacy else {
            return [
                "schemaVersion": 1,
                "status": "native-ready",
                "activeProvider": IOSAccessibilityProviderKind.axp.rawValue,
                "xctestAvailability": availability.availability.rawValue,
            ]
        }
        do {
            let legacy = try captureLegacySnapshot(udid: udid, maxNodes: 240)
            let classified = classifyAccessibilitySnapshot(legacy).snapshot
            let stats = classified["stats"] as? [String: Any] ?? [:]
            let quality = stats["quality"] as? String ?? "complete"
            if quality != "degraded" && quality != "partial" {
                return [
                    "schemaVersion": 1,
                    "status": "native-ready",
                    "activeProvider": IOSAccessibilityProviderKind.axp.rawValue,
                    "legacyQuality": quality,
                    "reason": availability.reason ?? "xctest-primary-available",
                ].compactMapValues { $0 }
            }
            return [
                "schemaVersion": 1,
                "status": "unavailable",
                "activeProvider": IOSAccessibilityProviderKind.axp.rawValue,
                "legacyQuality": quality,
                "reason": availability.reason ?? "xctest-provider-unavailable",
            ]
        } catch {
            return [
                "schemaVersion": 1,
                "status": "unavailable",
                "activeProvider": IOSAccessibilityProviderKind.axp.rawValue,
                "reason": error.localizedDescription,
            ]
        }
    }

    func enableXCTestProvider(udid: String, bundleID: String) throws -> [String: Any] {
        if xctestBundleIDs[udid] != bundleID {
            xctestProviders.removeValue(forKey: udid)?.stop()
            xctestBundleIDs.removeValue(forKey: udid)
        }
        if xctestProviders[udid] == nil {
            xctestProviders[udid] = try XCTestAccessibilityProviderSession.start(
                udid: udid,
                targetBundleID: bundleID
            )
            xctestBundleIDs[udid] = bundleID
        }
        // XCTest snapshots do not emit AXP revision events. Keeping the legacy
        // observer active makes every wait take the bounded AXP fallback path
        // and can also inject unrelated revisions into the XCTest session.
        stopObservation(udid: udid)
        var status = providerStatus(udid: udid, assessLegacy: false)
        status["bundleId"] = bundleID
        return status
    }

    func disableXCTestProvider(udid: String) -> [String: Any] {
        xctestProviders.removeValue(forKey: udid)?.stop()
        xctestBundleIDs.removeValue(forKey: udid)
        return providerStatus(udid: udid, assessLegacy: false)
    }

    @discardableResult
    func startObservation(udid: String, onEvent: @escaping @Sendable () -> Void) -> Bool {
        if xctestProviders[udid] != nil {
            stopObservation(udid: udid)
            observationStrategy = "snapshot-diff"
            return false
        }
        if observedUDID == udid { return observationStrategy == "ios-axp" }
        if let observedUDID, let device = SimulatorRuntime.object(udid: observedUDID) {
            SVAccessibilityBridge.stopObservingDevice(device)
        }
        guard let device = SimulatorRuntime.object(udid: udid) else {
            observationStrategy = "snapshot-diff"
            return false
        }
        let started: Bool
        do {
            try SVAccessibilityBridge.startObservingDevice(device, handler: onEvent)
            started = true
        } catch {
            started = false
        }
        observedUDID = started ? udid : nil
        observationStrategy = started ? "ios-axp" : "snapshot-diff"
        return started
    }

    func stopObservation(udid: String? = nil) {
        guard let observedUDID, udid == nil || udid == observedUDID else { return }
        if let device = SimulatorRuntime.object(udid: observedUDID) {
            SVAccessibilityBridge.stopObservingDevice(device)
        }
        self.observedUDID = nil
        observationStrategy = "snapshot-diff"
    }

    func snapshot(
        udid: String,
        scope: String = "interactive",
        maxNodes: Int = 1_200
    ) throws -> [String: Any] {
        do {
            let captured: [String: Any]
            if let provider = xctestProviders[udid] {
                do {
                    captured = try provider.snapshot(maxNodes: maxNodes, timeout: 5)
                } catch {
                    provider.stop()
                    xctestProviders.removeValue(forKey: udid)
                    xctestBundleIDs.removeValue(forKey: udid)
                    captured = try captureLegacySnapshot(udid: udid, maxNodes: maxNodes)
                }
            } else {
                captured = try captureLegacySnapshot(udid: udid, maxNodes: maxNodes)
            }
            let snapshot = try projectAccessibilitySnapshot(captured, scope: scope)
            if let screen = snapshot["screen"] as? [String: Any],
                let width = number(screen["width"]),
                let height = number(screen["height"])
            {
                screenBounds[udid] = (width, height)
            }
            return snapshot
        } catch let error as SimViewError {
            throw error
        } catch {
            throw SimViewError(
                "ACCESSIBILITY_UNAVAILABLE",
                error.localizedDescription,
                details: ["udid": udid]
            )
        }
    }

    func elementAtPoint(udid: String, x: Double, y: Double) throws -> [String: Any] {
        if let provider = xctestProviders[udid] {
            return try provider.elementAtPoint(x: x, y: y, timeout: 5)
        }
        guard let device = SimulatorRuntime.object(udid: udid) else {
            throw SimViewError("DEVICE_NOT_BOOTED", "Simulator \(udid) is unavailable")
        }
        let bounds: (width: Double, height: Double)
        if let cached = screenBounds[udid] {
            bounds = cached
        } else {
            _ = try snapshot(udid: udid, scope: "visible", maxNodes: 1)
            guard let cached = screenBounds[udid] else {
                throw SimViewError(
                    "ACCESSIBILITY_COORDINATES_UNAVAILABLE",
                    "Accessibility screen bounds are missing"
                )
            }
            bounds = cached
        }
        do {
            let value = try SVAccessibilityBridge.element(
                forDevice: device,
                x: x * bounds.width,
                y: y * bounds.height,
                screenWidth: bounds.width,
                screenHeight: bounds.height
            )
            return value
        } catch let error as SimViewError {
            throw error
        } catch {
            throw SimViewError("ACCESSIBILITY_UNAVAILABLE", error.localizedDescription)
        }
    }

    private func captureLegacySnapshot(udid: String, maxNodes: Int) throws -> [String: Any] {
        guard let device = SimulatorRuntime.object(udid: udid) else {
            throw SimViewError("DEVICE_NOT_BOOTED", "Simulator \(udid) is unavailable")
        }
        let boundedMaxNodes = UInt(max(1, min(maxNodes, 5_000)))
        return try captureAccessibilitySnapshotWithRetry {
            try SVAccessibilityBridge.snapshot(forDevice: device, maxNodes: boundedMaxNodes)
        }
    }

    func find(
        udid: String,
        selector: [String: Any],
        scope: String = "visible"
    ) throws -> [String: Any] {
        try validateAccessibilitySelector(selector)
        let bridgedSnapshot = try snapshot(udid: udid, scope: scope)
        let snapshot =
            try JSONSerialization.jsonObject(
                with: JSONSerialization.data(withJSONObject: bridgedSnapshot)
            ) as? [String: Any] ?? bridgedSnapshot
        guard let root = snapshot["root"] as? [String: Any] else {
            throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "Accessibility snapshot has no root")
        }
        var matches: [[String: Any]] = []
        collectMatches(root, selector: selector, matches: &matches)
        return [
            "schemaVersion": 1,
            "snapshotId": snapshot["snapshotId"] as Any,
            "selector": selector,
            "matches": matches,
            "count": matches.count,
            "nodeCount": snapshot["stats"] as Any,
        ]
    }

    func wait(
        udid: String,
        selector: [String: Any],
        state: String,
        timeoutMs: Int
    ) throws -> [String: Any] {
        guard state == "visible" || state == "hidden" else {
            throw SimViewError(
                "PARAMETER_INVALID",
                "accessibility.wait state must be visible or hidden"
            )
        }
        let deadline = Date().addingTimeInterval(Double(max(1, min(timeoutMs, 30_000))) / 1_000)
        var revision: String?
        var lastCount = 0
        var lastSnapshot: [String: Any] = [:]
        var lastMatches: [[String: Any]] = []
        repeat {
            let remaining = max(0, deadline.timeIntervalSinceNow)
            let observed = try observation.observe(
                afterRevision: revision,
                scope: "visible",
                maxNodes: 5_000,
                settleQuietMilliseconds: 75,
                maximumWaitMilliseconds: min(500, Int(remaining * 1_000)),
                strategy: "snapshot-diff"
            ) { [weak self] scope, maxNodes in
                guard let self else {
                    throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "Accessibility service is unavailable")
                }
                return try self.snapshot(udid: udid, scope: scope, maxNodes: maxNodes)
            }
            revision = observed.revision
            lastSnapshot = observed.snapshot
            lastMatches = []
            if let root = observed.snapshot["root"] as? [String: Any] {
                collectMatches(root, selector: selector, matches: &lastMatches)
            }
            lastCount = lastMatches.count
            let satisfied = state == "hidden" ? lastCount == 0 : lastCount > 0
            if satisfied {
                return [
                    "schemaVersion": 1,
                    "state": state,
                    "satisfied": true,
                    "count": lastCount,
                    "snapshotId": lastSnapshot["snapshotId"] as Any,
                    "matches": lastMatches,
                ]
            }
        } while Date() < deadline
        throw SimViewError(
            "ACCESSIBILITY_REQUEST_TIMEOUT",
            "Timed out waiting for accessibility element to become \(state)",
            details: ["selector": selector, "state": state, "lastCount": lastCount]
        )
    }

    private func collectMatches(
        _ node: [String: Any],
        selector: [String: Any],
        matches: inout [[String: Any]]
    ) {
        let exact = selector["exact"] as? Bool ?? true
        let fields: [(String, [String])] = [
            ("ref", ["ref"]),
            ("identifier", ["identifier"]),
            ("role", ["role"]),
            ("name", ["label", "title"]),
            ("value", ["value"]),
            ("placeholder", ["placeholder"]),
        ]
        let matched = fields.allSatisfy { selectorKey, nodeKeys in
            guard let expected = string(selector[selectorKey]) else { return true }
            return nodeKeys.contains { nodeKey in
                guard let actual = string(node[nodeKey]) else { return false }
                return exact
                    ? actual.caseInsensitiveCompare(expected) == .orderedSame
                    : actual.localizedCaseInsensitiveContains(expected)
            }
        }
        if matched { matches.append(node) }
        for child in childDictionaries(node) {
            collectMatches(child, selector: selector, matches: &matches)
        }
    }

    private func number(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        return nil
    }

    private func string(_ value: Any?) -> String? {
        if let value = value as? String { return value }
        if let value = value as? NSString { return value as String }
        return nil
    }

    private func childDictionaries(_ node: [String: Any]) -> [[String: Any]] {
        (node["children"] as? [Any] ?? []).compactMap { child in
            if let child = child as? [String: Any] { return child }
            if let child = child as? NSDictionary { return child as? [String: Any] }
            return nil
        }
    }
}
