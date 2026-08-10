import Foundation

final class AndroidAccessibilityService: @unchecked Sendable {
    private let client: ADBClient
    private let serial: String
    private weak var agent: AndroidAgentConnection?
    private let observation: AccessibilityObservationCoordinator

    init(
        client: ADBClient,
        serial: String,
        agent: AndroidAgentConnection? = nil,
        observation: AccessibilityObservationCoordinator = AccessibilityObservationCoordinator()
    ) {
        self.client = client
        self.serial = serial
        self.agent = agent
        self.observation = observation
    }

    var observationStrategy: String { agent == nil ? "snapshot-diff" : "android-shell-dump" }

    func snapshot(
        scope: String = "interactive", maxNodes: Int = 1_200, timeout: TimeInterval = 15
    ) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(max(0.1, timeout))
        var latestSnapshot: [String: Any]?
        for attempt in 0..<3 {
            let (xml, source) = try captureHierarchy(deadline: deadline)
            let snapshot = try parsedSnapshot(
                xml, scope: scope, maxNodes: maxNodes, source: source)
            latestSnapshot = snapshot
            guard shouldRetry(snapshot), attempt < 2 else { return snapshot }
            let delay = min(0.15, 0.05 * pow(2, Double(attempt)))
            guard deadline.timeIntervalSinceNow > delay else { return snapshot }
            Thread.sleep(forTimeInterval: delay)
        }
        return latestSnapshot!
    }

    private func captureHierarchy(deadline: Date) throws -> (xml: Data, source: String) {
        if let agent {
            let xml = try agent.accessibilitySnapshot(timeout: max(0.1, deadline.timeIntervalSinceNow))
            return (xml, "android-agent-shell")
        }
        let remotePath = "/data/local/tmp/simview-\(UUID().uuidString.lowercased()).xml"
        defer {
            _ = try? client.execute(
                ["shell", "rm", "-f", remotePath], serial: serial, timeout: 2)
        }
        let dump = try client.require(
            ["shell", "uiautomator", "dump", "--compressed", remotePath],
            serial: serial,
            timeout: max(0.1, deadline.timeIntervalSinceNow)
        )
        _ = dump
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else {
            throw SimViewError("ACCESSIBILITY_REQUEST_TIMEOUT", "UIAutomator exceeded its deadline")
        }
        let xml = try client.require(
            ["exec-out", "cat", remotePath],
            serial: serial,
            timeout: remaining
        ).output
        guard xml.count <= 8 * 1024 * 1024 else {
            throw SimViewError("ACCESSIBILITY_RESPONSE_TOO_LARGE", "UIAutomator hierarchy exceeds 8 MiB")
        }
        return (xml, "android-uiautomator")
    }

    private func shouldRetry(_ snapshot: [String: Any]) -> Bool {
        guard let stats = snapshot["stats"] as? [String: Any] else { return false }
        return stats["quality"] as? String == "degraded"
            && stats["reason"] as? String == "root-only-or-zero-sized-hierarchy"
    }

    private func parsedSnapshot(
        _ xml: Data,
        scope: String,
        maxNodes: Int,
        source: String
    ) throws -> [String: Any] {
        let snapshotID = UUID().uuidString.lowercased()
        let parser = AndroidHierarchyParser(maxNodes: max(1, min(maxNodes, 5_000)))
        let root = try parser.parse(xml, referencePrefix: "android:\(snapshotID)")
        let display = displayBounds(root)
        let framedRoot = applyingFrames(to: root, display: display)
        let selectedRoot = scope == "interactive" ? interactiveTree(framedRoot) ?? framedRoot : framedRoot
        let quality: String
        let reason: String?
        if parser.nodeCount <= 1 || display.width <= 0 || display.height <= 0 {
            quality = "degraded"
            reason = "root-only-or-zero-sized-hierarchy"
        } else if parser.truncated {
            quality = "partial"
            reason = "node-budget-exhausted"
        } else {
            quality = "complete"
            reason = nil
        }
        var stats: [String: Any] = [
            "nodeCount": parser.nodeCount,
            "truncated": parser.truncated,
            "quality": quality,
            "capturedBudget": max(1, min(maxNodes, 5_000)),
        ]
        if let reason { stats["reason"] = reason }
        return [
            "schemaVersion": 1,
            "snapshotId": snapshotID,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "source": source,
            "scope": scope,
            "screen": ["x": 0, "y": 0, "width": display.width, "height": display.height],
            "root": selectedRoot,
            "stats": stats,
        ]
    }

    func elementAtPoint(x: Double, y: Double) throws -> [String: Any] {
        let value = try snapshot(scope: "visible", maxNodes: 5_000)
        guard let root = value["root"] as? [String: Any],
            let screen = value["screen"] as? [String: Any],
            let width = screen["width"] as? Int,
            let height = screen["height"] as? Int
        else { throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "UIAutomator returned no hierarchy") }
        let point = (x: x * Double(width), y: y * Double(height))
        var candidates: [([String: Any], Double)] = []
        collectContaining(root, point: point, candidates: &candidates)
        guard let match = candidates.min(by: { $0.1 < $1.1 })?.0 else {
            throw SimViewError("ACCESSIBILITY_ELEMENT_NOT_FOUND", "No Android element contains this point")
        }
        return match
    }

    func find(
        selector: [String: Any], scope: String = "visible", timeout: TimeInterval = 15
    ) throws -> [String: Any] {
        try validateAccessibilitySelector(selector)
        let value = try snapshot(scope: scope, maxNodes: 5_000, timeout: timeout)
        guard let root = value["root"] as? [String: Any] else {
            throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "UIAutomator returned no hierarchy")
        }
        var matches: [[String: Any]] = []
        collectMatches(root, selector: selector, matches: &matches)
        let stats = value["stats"] as? [String: Any]
        return [
            "schemaVersion": 1,
            "snapshotId": value["snapshotId"] as Any,
            "selector": selector,
            "matches": matches,
            "count": matches.count,
            "nodeCount": stats?["nodeCount"] ?? 0,
            "truncated": stats?["truncated"] ?? false,
        ]
    }

    func wait(selector: [String: Any], state: String, timeoutMs: Int) throws -> [String: Any] {
        guard state == "visible" || state == "hidden" else {
            throw SimViewError("PARAMETER_INVALID", "accessibility.wait state must be visible or hidden")
        }
        try validateAccessibilitySelector(selector)
        let deadline = Date().addingTimeInterval(Double(max(1, min(timeoutMs, 30_000))) / 1_000)
        var revision: String?
        var lastCount = 0
        while Date() < deadline {
            let remaining = max(0, deadline.timeIntervalSinceNow)
            let observed = try observation.observe(
                afterRevision: revision,
                scope: "visible",
                maxNodes: 5_000,
                settleQuietMilliseconds: 75,
                maximumWaitMilliseconds: min(500, Int(remaining * 1_000)),
                strategy: observationStrategy
            ) { [weak self] scope, maxNodes in
                guard let self else {
                    throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "Accessibility service is unavailable")
                }
                let snapshotTimeout = deadline.timeIntervalSinceNow
                guard snapshotTimeout > 0 else {
                    throw SimViewError(
                        "ACCESSIBILITY_REQUEST_TIMEOUT",
                        "Android accessibility snapshot exceeded its deadline")
                }
                return try self.snapshot(scope: scope, maxNodes: maxNodes, timeout: snapshotTimeout)
            }
            revision = observed.revision
            var matches: [[String: Any]] = []
            if let root = observed.snapshot["root"] as? [String: Any] {
                collectMatches(root, selector: selector, matches: &matches)
            }
            lastCount = matches.count
            if (state == "visible" && lastCount > 0) || (state == "hidden" && lastCount == 0) {
                return [
                    "schemaVersion": 1,
                    "state": state,
                    "satisfied": true,
                    "count": lastCount,
                    "snapshotId": observed.snapshot["snapshotId"] as Any,
                    "matches": matches,
                ]
            }
            if observed.timedOut { break }
        }
        throw SimViewError(
            "ACCESSIBILITY_REQUEST_TIMEOUT",
            "Timed out waiting for Android accessibility element to become \(state)",
            details: ["state": state, "lastCount": lastCount]
        )
    }

    func context() throws -> [String: Any] {
        let commands = [
            ["shell", "dumpsys", "activity", "activities"],
            ["shell", "dumpsys", "window", "windows"],
        ]
        for command in commands {
            guard let result = try? client.require(command, serial: serial),
                let component = Self.foregroundComponent(in: result.text)
            else { continue }
            return [
                "source": "adb-dumpsys",
                "package": component.package,
                "activity": component.activity,
            ]
        }
        return ["source": "adb-dumpsys", "package": NSNull(), "activity": NSNull()]
    }

    static func foregroundComponent(in text: String) -> (package: String, activity: String)? {
        let pattern =
            #"(?:topResumedActivity|mResumedActivity|mCurrentFocus|mFocusedApp).*?\s([A-Za-z0-9._]+)/([A-Za-z0-9._$]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(
                in: text,
                range: NSRange(text.startIndex..., in: text)
            ),
            let packageRange = Range(match.range(at: 1), in: text),
            let activityRange = Range(match.range(at: 2), in: text)
        else { return nil }
        return (String(text[packageRange]), String(text[activityRange]))
    }

    private func displayBounds(_ root: [String: Any]) -> (width: Int, height: Int) {
        var maximumX = 0
        var maximumY = 0
        visit(root) { node in
            guard let bounds = node["bounds"] as? [String: Any] else { return }
            maximumX = max(maximumX, (bounds["x"] as? Int ?? 0) + (bounds["width"] as? Int ?? 0))
            maximumY = max(maximumY, (bounds["y"] as? Int ?? 0) + (bounds["height"] as? Int ?? 0))
        }
        return (maximumX, maximumY)
    }

    private func applyingFrames(
        to node: [String: Any], display: (width: Int, height: Int)
    ) -> [String: Any] {
        var value = node
        if let bounds = node["bounds"] as? [String: Any],
            let x = bounds["x"] as? Int, let y = bounds["y"] as? Int,
            let width = bounds["width"] as? Int, let height = bounds["height"] as? Int,
            display.width > 0, display.height > 0
        {
            value["frame"] = [
                "points": ["x": x, "y": y, "width": width, "height": height],
                "normalized": [
                    "x": Double(x) / Double(display.width),
                    "y": Double(y) / Double(display.height),
                    "width": Double(width) / Double(display.width),
                    "height": Double(height) / Double(display.height),
                ],
            ]
        }
        value["children"] = childDictionaries(node).map { applyingFrames(to: $0, display: display) }
        return value
    }

    private func interactiveTree(_ node: [String: Any]) -> [String: Any]? {
        var value = node
        let children = childDictionaries(node).compactMap(interactiveTree)
        let interactive =
            (node["actions"] as? [String] ?? []).isEmpty == false
            || node["identifier"] != nil || node["label"] != nil || node["value"] != nil
            || !children.isEmpty
        guard interactive, node["hidden"] as? Bool != true else { return nil }
        value["children"] = children
        return value
    }

    private func collectContaining(
        _ node: [String: Any],
        point: (x: Double, y: Double),
        candidates: inout [([String: Any], Double)]
    ) {
        if let bounds = node["bounds"] as? [String: Any],
            let x = bounds["x"] as? Int, let y = bounds["y"] as? Int,
            let width = bounds["width"] as? Int, let height = bounds["height"] as? Int,
            width > 0, height > 0,
            point.x >= Double(x), point.x <= Double(x + width),
            point.y >= Double(y), point.y <= Double(y + height)
        {
            candidates.append((node, Double(width * height)))
        }
        for child in childDictionaries(node) {
            collectContaining(child, point: point, candidates: &candidates)
        }
    }

    private func collectMatches(
        _ node: [String: Any], selector: [String: Any], matches: inout [[String: Any]]
    ) {
        let exact = selector["exact"] as? Bool ?? true
        let fields: [(String, [String])] = [
            ("ref", ["ref"]), ("identifier", ["identifier"]), ("role", ["role"]),
            ("name", ["label", "title"]), ("value", ["value"]),
        ]
        let matched = fields.allSatisfy { selectorKey, nodeKeys in
            guard let expected = selector[selectorKey] as? String else { return true }
            return nodeKeys.contains { key in
                guard let actual = node[key] as? String else { return false }
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

    private func visit(_ node: [String: Any], body: ([String: Any]) -> Void) {
        body(node)
        for child in childDictionaries(node) { visit(child, body: body) }
    }

    private func childDictionaries(_ node: [String: Any]) -> [[String: Any]] {
        node["children"] as? [[String: Any]] ?? []
    }
}

private final class AndroidHierarchyNode {
    private static let boundsExpression = try! NSRegularExpression(
        pattern: #"\[(-?[0-9]+),(-?[0-9]+)\]\[(-?[0-9]+),(-?[0-9]+)\]"#
    )

    let attributes: [String: String]
    var children: [AndroidHierarchyNode] = []

    init(attributes: [String: String]) { self.attributes = attributes }

    func dictionary(ref: String) -> [String: Any] {
        let parsedBounds = Self.bounds(attributes["bounds"] ?? "")
        var actions: [String] = []
        if attributes["clickable"] == "true" { actions.append("click") }
        if attributes["long-clickable"] == "true" { actions.append("longClick") }
        if attributes["scrollable"] == "true" { actions.append("scroll") }
        if attributes["editable"] == "true" { actions.append("setText") }
        var result: [String: Any] = [
            "ref": ref,
            "role": attributes["class"] ?? "android.view.View",
            "package": attributes["package"] ?? "",
            "enabled": attributes["enabled"] != "false",
            "selected": attributes["selected"] == "true",
            "focused": attributes["focused"] == "true",
            "checked": attributes["checked"] == "true",
            "hidden": attributes["visible-to-user"] == "false",
            "actions": actions,
            "bounds": parsedBounds,
            "children": children.enumerated().map { index, child in
                child.dictionary(ref: "\(ref).\(index)")
            },
        ]
        if let identifier = attributes["resource-id"], !identifier.isEmpty { result["identifier"] = identifier }
        if let label = attributes["content-desc"], !label.isEmpty { result["label"] = label }
        if let text = attributes["text"], !text.isEmpty { result["value"] = text }
        return result
    }

    private static func bounds(_ value: String) -> [String: Int] {
        guard
            let match = boundsExpression.firstMatch(
                in: value, range: NSRange(value.startIndex..., in: value))
        else { return ["x": 0, "y": 0, "width": 0, "height": 0] }
        let values = (1...4).compactMap { index -> Int? in
            guard let range = Range(match.range(at: index), in: value) else { return nil }
            return Int(value[range])
        }
        guard values.count == 4 else { return ["x": 0, "y": 0, "width": 0, "height": 0] }
        return [
            "x": values[0], "y": values[1],
            "width": max(0, values[2] - values[0]), "height": max(0, values[3] - values[1]),
        ]
    }
}

final class AndroidHierarchyParser: NSObject, XMLParserDelegate {
    private let maximumNodes: Int
    private var stack: [AndroidHierarchyNode] = []
    private var root: AndroidHierarchyNode?
    private var parseError: Error?
    private(set) var nodeCount = 0
    private(set) var truncated = false

    init(maxNodes: Int) { self.maximumNodes = maxNodes }

    func parse(_ data: Data, referencePrefix: String = "android") throws -> [String: Any] {
        let parser = XMLParser(data: data)
        parser.delegate = self
        guard parser.parse(), let root else {
            throw SimViewError(
                "ACCESSIBILITY_RESPONSE_INVALID",
                parseError?.localizedDescription ?? parser.parserError?.localizedDescription
                    ?? "UIAutomator returned invalid XML"
            )
        }
        return root.dictionary(ref: "\(referencePrefix):0")
    }

    func parser(
        _ parser: XMLParser,
        didStartElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?,
        attributes attributeDict: [String: String] = [:]
    ) {
        guard elementName == "node" else { return }
        guard nodeCount < maximumNodes else {
            truncated = true
            stack.append(AndroidHierarchyNode(attributes: ["class": "simview.TruncatedNode"]))
            return
        }
        let node = AndroidHierarchyNode(attributes: attributeDict)
        if let parent = stack.last { parent.children.append(node) } else { root = node }
        stack.append(node)
        nodeCount += 1
    }

    func parser(
        _ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?
    ) {
        if elementName == "node", !stack.isEmpty { stack.removeLast() }
    }

    func parser(_ parser: XMLParser, parseErrorOccurred parseError: Error) {
        self.parseError = parseError
    }
}
