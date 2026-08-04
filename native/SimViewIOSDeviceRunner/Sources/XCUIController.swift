import Foundation
import UIKit
import XCTest

@MainActor
final class XCUIController {
    struct CapturedScreenshot {
        let data: Data
        let image: UIImage
        let capturePath: String
        let timestampMicros: UInt64
    }

    private(set) var activeBundleID: String?

    init(initialBundleID: String?) {
        activeBundleID = initialBundleID?.isEmpty == false ? initialBundleID : nil
    }

    var privateScreenshotAvailable: Bool {
        guard let application = optionalApplication else { return false }
        return SVPrivateScreenshotAvailable(application)
    }

    var reportedButtons: [String] {
        if #available(iOS 16.0, *) {
            return [("home", 1), ("volume-up", 2), ("volume-down", 3), ("action", 4), ("camera", 5)]
                .compactMap { name, rawValue in
                    guard
                        let button = XCUIDevice.Button(rawValue: rawValue),
                        XCUIDevice.shared.hasHardwareButton(button)
                    else { return nil }
                    return name
                }
        }
        return ["home"]
    }

    func selectApplication(bundleID: String) throws -> [String: Any] {
        guard isValidBundleID(bundleID) else {
            throw RunnerError("BUNDLE_ID_INVALID", "bundleId is not a valid application identifier")
        }
        activeBundleID = bundleID
        return ["accepted": true, "appBundleId": bundleID]
    }

    func screenshot(preview: Bool) throws -> CapturedScreenshot {
        if preview, let application = resolvedApplication(),
            SVPrivateScreenshotAvailable(application)
        {
            var error: NSError?
            if let data = SVPrivateScreenshotPNG(application, 1, &error),
                let image = UIImage(data: data)
            {
                return CapturedScreenshot(
                    data: data,
                    image: image,
                    capturePath: "private-xctest",
                    timestampMicros: monotonicTimestampMicros()
                )
            }
        }

        let result = XCUIScreen.main.screenshot()
        return CapturedScreenshot(
            data: result.pngRepresentation,
            image: result.image,
            capturePath: "public-xcui",
            timestampMicros: monotonicTimestampMicros()
        )
    }

    func snapshot(maxDepth: Int, maxChildren: Int) throws -> [String: Any] {
        let application = try requiredApplication()
        let snapshot: XCUIElementSnapshot
        do {
            snapshot = try application.snapshot()
        } catch {
            throw RunnerError("SNAPSHOT_FAILED", "XCUI snapshot failed: \(error.localizedDescription)")
        }
        var ordinal = 0
        var truncated = false
        let screen = XCUIScreen.main.screenshot().image.size
        let root = serialize(
            snapshot,
            depth: 0,
            maxDepth: min(max(maxDepth, 1), 100),
            maxChildren: min(max(maxChildren, 1), 2_000),
            screenSize: screen,
            ordinal: &ordinal,
            truncated: &truncated
        )
        return [
            "schemaVersion": 1,
            "snapshotId": UUID().uuidString.lowercased(),
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "source": "ios-xcui",
            "scope": "full",
            "screen": ["x": 0, "y": 0, "width": screen.width, "height": screen.height],
            "root": root,
            "stats": ["nodeCount": ordinal, "truncated": truncated],
        ]
    }

    func find(selector: [String: JSONValue], timeout: TimeInterval) throws -> [String: Any] {
        var elements = try matchingElements(selector)
        if elements.isEmpty, timeout > 0 {
            let deadline = Date().addingTimeInterval(min(timeout, 60))
            while elements.isEmpty, deadline.timeIntervalSinceNow > 0 {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
                elements = try matchingElements(selector)
            }
        }
        let snapshotID = UUID().uuidString.lowercased()
        let matches = elements.prefix(100).enumerated().map { index, element in
            serialize(element, ref: "ios-xcui:\(snapshotID):\(index + 1)")
        }
        return [
            "schemaVersion": 1,
            "snapshotId": snapshotID,
            "selector": selector.foundationObject,
            "matches": matches,
            "count": matches.count,
        ]
    }

    func element(at normalizedPoint: CGPoint) throws -> [String: Any] {
        let application = try requiredApplication()
        let screenSize = XCUIScreen.main.screenshot().image.size
        let point = CGPoint(
            x: normalizedPoint.x * screenSize.width,
            y: normalizedPoint.y * screenSize.height
        )
        let matches = application.descendants(matching: .any).allElementsBoundByIndex
            .prefix(2_000)
            .filter { $0.exists && !$0.frame.isEmpty && $0.frame.contains(point) }
        guard
            let element = matches.min(by: {
                $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
            })
        else {
            throw RunnerError("ACCESSIBILITY_ELEMENT_NOT_FOUND", "No XCUI element contains this point")
        }
        return serialize(element, ref: "ios-xcui:\(UUID().uuidString.lowercased()):1")
    }

    func wait(
        selector: [String: JSONValue],
        shouldExist: Bool,
        timeout: TimeInterval
    ) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(min(max(timeout, 0), 60))
        var elements = try matchingElements(selector)
        while elements.isEmpty == shouldExist, deadline.timeIntervalSinceNow > 0 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            elements = try matchingElements(selector)
        }
        guard elements.isEmpty != shouldExist else {
            throw RunnerError("ACCESSIBILITY_WAIT_TIMEOUT", "XCUI wait timed out")
        }
        let snapshotID = UUID().uuidString.lowercased()
        let matches = elements.prefix(100).enumerated().map { index, element in
            serialize(element, ref: "ios-xcui:\(snapshotID):\(index + 1)")
        }
        return [
            "schemaVersion": 1,
            "state": shouldExist ? "visible" : "hidden",
            "satisfied": true,
            "count": matches.count,
            "snapshotId": snapshotID,
            "matches": matches,
        ]
    }

    func tap(_ point: CGPoint) throws {
        try coordinate(point).tap()
    }

    func longPress(_ point: CGPoint, duration: TimeInterval) throws {
        try coordinate(point).press(forDuration: min(max(duration, 0.05), 30))
    }

    func drag(from: CGPoint, to: CGPoint, duration: TimeInterval) throws {
        let start = try coordinate(from)
        let end = try coordinate(to)
        start.press(
            forDuration: min(max(duration, 0), 30),
            thenDragTo: end
        )
    }

    func typeText(_ text: String) throws {
        guard text.utf8.count <= 64 * 1024 else {
            throw RunnerError("TEXT_TOO_LARGE", "Text input exceeds 64 KiB")
        }
        try requiredApplication().typeText(text)
    }

    func pressButton(_ name: String) throws {
        let rawValues = [
            "home": 1,
            "volume-up": 2,
            "volume-down": 3,
            "volumeUp": 2,
            "volumeDown": 3,
            "action": 4,
            "camera": 5,
        ]
        guard let rawValue = rawValues[name], let button = XCUIDevice.Button(rawValue: rawValue) else {
            throw RunnerError("BUTTON_UNSUPPORTED", "Unsupported physical button: \(name)")
        }
        if #available(iOS 16.0, *) {
            guard XCUIDevice.shared.hasHardwareButton(button) else {
                throw RunnerError("BUTTON_UNAVAILABLE", "The connected device does not report \(name)")
            }
        } else if name != "home" {
            throw RunnerError(
                "BUTTON_UNAVAILABLE",
                "iOS 15 does not expose hardware-button discovery for \(name)"
            )
        }
        XCUIDevice.shared.press(button)
    }

    func setOrientation(_ name: String) throws {
        let orientation: UIDeviceOrientation
        switch name {
        case "portrait": orientation = .portrait
        case "portrait-upside-down", "portraitUpsideDown": orientation = .portraitUpsideDown
        case "landscape-left", "landscapeLeft": orientation = .landscapeLeft
        case "landscape-right", "landscapeRight": orientation = .landscapeRight
        default:
            throw RunnerError("ORIENTATION_INVALID", "Unsupported orientation: \(name)")
        }
        XCUIDevice.shared.orientation = orientation
    }

    func activateApplication() throws {
        try requiredApplication().activate()
    }

    func terminateApplication() throws {
        try requiredApplication().terminate()
    }

    private var optionalApplication: XCUIApplication? {
        activeBundleID.map(XCUIApplication.init(bundleIdentifier:))
    }

    private func requiredApplication() throws -> XCUIApplication {
        guard let application = resolvedApplication() else {
            throw RunnerError(
                "TARGET_APP_REQUIRED",
                "Select a target application before using this operation"
            )
        }
        return application
    }

    private func resolvedApplication() -> XCUIApplication? {
        if activeBundleID == nil,
            let discovered = SVPrivateActiveApplicationBundleIdentifier(),
            isValidBundleID(discovered)
        {
            activeBundleID = discovered
        }
        return optionalApplication
    }

    private func coordinate(_ point: CGPoint) throws -> XCUICoordinate {
        try requiredApplication().coordinate(withNormalizedOffset: CGVector(dx: point.x, dy: point.y))
    }

    private func matchingElements(_ selector: [String: JSONValue]) throws -> [XCUIElement] {
        let application = try requiredApplication()
        let ref = selector["ref"]?.stringValue
        let identifier = selector["identifier"]?.stringValue
        let name = selector["name"]?.stringValue ?? selector["label"]?.stringValue
        let value = selector["value"]?.stringValue
        let role = selector["role"]?.stringValue
        let type = selector["type"]?.intValue ?? role.flatMap(parseRole)
        guard ref != nil || identifier != nil || name != nil || value != nil || type != nil else {
            throw RunnerError(
                "SELECTOR_INVALID",
                "selector requires identifier, label, value, or numeric type"
            )
        }

        let query = application.descendants(matching: .any)
        if let ref, let ordinal = Int(ref.split(separator: "-").last ?? ""), ordinal >= 2 {
            let elements = query.allElementsBoundByIndex
            let index = ordinal - 2
            return index < elements.count ? [elements[index]] : []
        }
        return Array(
            query.allElementsBoundByIndex.prefix(2_000).filter { element in
                if let identifier, element.identifier != identifier { return false }
                if let name, element.label != name, element.title != name { return false }
                if let value, String(describing: element.value ?? "") != value { return false }
                if let type, element.elementType.rawValue != UInt(type) { return false }
                return true
            })
    }

    private func serialize(_ element: XCUIElement, ref: String) -> [String: Any] {
        var result: [String: Any] = [
            "ref": ref,
            "identifier": bounded(element.identifier),
            "label": bounded(element.label),
            "role": roleName(element.elementType.rawValue),
            "enabled": element.isEnabled,
            "selected": element.isSelected,
            "frame": frameDictionary(element.frame, screenSize: XCUIScreen.main.screenshot().image.size),
        ]
        if let value = element.value {
            result["value"] = bounded(String(describing: value))
        }
        return result
    }

    private func serialize(
        _ snapshot: XCUIElementSnapshot,
        depth: Int,
        maxDepth: Int,
        maxChildren: Int,
        screenSize: CGSize,
        ordinal: inout Int,
        truncated: inout Bool
    ) -> [String: Any] {
        ordinal += 1
        var result: [String: Any] = [
            "ref": "ios-xcui:node-\(ordinal)",
            "identifier": bounded(snapshot.identifier),
            "label": bounded(snapshot.label),
            "title": bounded(snapshot.title),
            "role": roleName(snapshot.elementType.rawValue),
            "enabled": snapshot.isEnabled,
            "selected": snapshot.isSelected,
            "frame": frameDictionary(snapshot.frame, screenSize: screenSize),
        ]
        if let value = snapshot.value {
            result["value"] = bounded(String(describing: value))
        }
        if let placeholder = snapshot.placeholderValue {
            result["placeholder"] = bounded(placeholder)
        }
        if depth < maxDepth, ordinal < maxChildren {
            var children: [[String: Any]] = []
            for child in snapshot.children {
                guard ordinal < maxChildren else { break }
                children.append(
                    serialize(
                        child,
                        depth: depth + 1,
                        maxDepth: maxDepth,
                        maxChildren: maxChildren,
                        screenSize: screenSize,
                        ordinal: &ordinal,
                        truncated: &truncated
                    )
                )
            }
            if !children.isEmpty {
                result["children"] = children
            }
        } else if !snapshot.children.isEmpty {
            result["truncated"] = true
            truncated = true
        }
        return result
    }

    private func frameDictionary(_ frame: CGRect, screenSize: CGSize) -> [String: Any] {
        let width = max(screenSize.width, 1)
        let height = max(screenSize.height, 1)
        return [
            "points": [
                "x": frame.origin.x,
                "y": frame.origin.y,
                "width": frame.width,
                "height": frame.height,
            ],
            "normalized": [
                "x": frame.origin.x / width,
                "y": frame.origin.y / height,
                "width": frame.width / width,
                "height": frame.height / height,
            ],
        ]
    }

    private func roleName(_ rawValue: UInt) -> String { "xcui-\(rawValue)" }

    private func parseRole(_ value: String) -> Int? {
        guard value.hasPrefix("xcui-") else { return nil }
        return Int(value.dropFirst("xcui-".count))
    }

    private func bounded(_ value: String) -> String {
        String(value.prefix(4_096))
    }

    private func isValidBundleID(_ value: String) -> Bool {
        value.count <= 255
            && value.range(
                of: #"^[A-Za-z0-9][A-Za-z0-9.-]*$"#,
                options: .regularExpression
            ) != nil
    }
}
