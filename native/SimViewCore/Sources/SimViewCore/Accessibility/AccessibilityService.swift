import Foundation
import SimViewAXShim

func validateAccessibilitySelector(_ selector: [String: Any]) throws {
    let fields = ["ref", "identifier", "role", "name", "value"]
    let hasMatchingField = fields.contains { key in
        guard let value = selector[key] as? String else { return false }
        return !value.isEmpty
    }
    guard hasMatchingField else {
        throw SimViewError(
            "PARAMETER_INVALID",
            "An accessibility selector requires ref, identifier, role, name, or value"
        )
    }
}

final class AccessibilityService: @unchecked Sendable {
    private var screenBounds: [String: (width: Double, height: Double)] = [:]
    private let observation: AccessibilityObservationCoordinator
    private var observedUDID: String?
    private(set) var observationStrategy = "snapshot-diff"

    init(observation: AccessibilityObservationCoordinator = AccessibilityObservationCoordinator()) {
        self.observation = observation
    }

    var available: Bool { SVAccessibilityBridge.isAvailable() }

    @discardableResult
    func startObservation(udid: String, onEvent: @escaping @Sendable () -> Void) -> Bool {
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
        guard let device = SimulatorRuntime.object(udid: udid) else {
            throw SimViewError("DEVICE_NOT_BOOTED", "Simulator \(udid) is unavailable")
        }
        do {
            var snapshot = try SVAccessibilityBridge.snapshot(
                forDevice: device,
                maxNodes: UInt(max(1, min(maxNodes, 5_000)))
            )
            if scope == "interactive", let root = snapshot["root"] as? [String: Any] {
                snapshot["root"] = interactiveTree(root) ?? root
            }
            if let screen = snapshot["screen"] as? [String: Any],
                let width = number(screen["width"]),
                let height = number(screen["height"])
            {
                screenBounds[udid] = (width, height)
            }
            snapshot["scope"] = scope
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

    private func interactiveTree(_ node: [String: Any]) -> [String: Any]? {
        var value = node
        let children = childDictionaries(node).compactMap(interactiveTree)
        let role = (node["role"] as? String ?? "").lowercased()
        let actions = node["actions"] as? [String] ?? []
        let usefulRole = [
            "button", "checkbox", "link", "menu", "radio", "search", "slider",
            "switch", "textfield", "textarea", "tab", "statictext", "heading",
        ].contains { role.contains($0) }
        let useful =
            usefulRole
            || !actions.isEmpty
            || node["identifier"] != nil
            || node["label"] != nil
            || node["title"] != nil
            || !children.isEmpty
        guard useful, node["hidden"] as? Bool != true else { return nil }
        if children.isEmpty { value.removeValue(forKey: "children") } else { value["children"] = children }
        return value
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
