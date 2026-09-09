import Foundation

/// All mutable iOS provider state is confined to this worker. Server state is
/// never read here; Android services are immutable handles captured at dispatch.
final class AccessibilityWorker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.simview.server.accessibility", qos: .userInitiated)
    private let cancellation = AccessibilityCancellation()
    private let accessibility: AccessibilityService
    private let accessibilityObservation: AccessibilityObservationCoordinator
    let available: Bool

    init(observation: AccessibilityObservationCoordinator, service: AccessibilityService? = nil) {
        accessibilityObservation = observation
        accessibility = service ?? AccessibilityService(observation: observation, cancellation: cancellation)
        available = accessibility.available
    }

    func submit(
        isCurrent: @escaping @Sendable () -> Bool,
        operation: @escaping @Sendable () throws -> JSONValue,
        completion: @escaping @Sendable (Result<JSONValue, Error>) -> Void
    ) {
        queue.async {
            guard isCurrent() else { return }
            let result = Result { try operation() }
            completion(result)
        }
    }

    func startObservation(for device: DeviceDescription) {
        queue.async { self.startIOSAccessibilityObservation(for: device) }
    }

    func stopObservation(udid: String?) {
        queue.async { self.accessibility.stopObservation(udid: udid) }
    }

    func discardDevice(udid: String) {
        queue.async {
            self.accessibility.stopObservation(udid: udid)
            _ = self.accessibility.disableXCTestProvider(udid: udid)
        }
    }

    func shutdown(completion: @escaping @Sendable () -> Void) {
        cancellation.cancel()
        queue.async {
            self.accessibility.shutdown()
            completion()
        }
    }

    private func startIOSAccessibilityObservation(for device: DeviceDescription) {
        accessibility.startObservation(udid: device.nativeIdentifier) { [weak self] in
            self?.accessibilityObservation.markEvent()
        }
    }

    private func requireAndroidAccessibility(_ service: AndroidAccessibilityService?) throws
        -> AndroidAccessibilityService
    {
        guard let service else {
            throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "Android accessibility is unavailable")
        }
        return service
    }

    func execute(_ request: Request, device: DeviceDescription, android: AndroidAccessibilityService?) throws
        -> JSONValue
    {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let value = JSONValue(try handle(request, device: device, android: android)) else {
            throw SimViewError("INTERNAL_ERROR", "Accessibility result is not JSON")
        }
        return value
    }

    private func handle(_ request: Request, device: DeviceDescription, android: AndroidAccessibilityService?) throws
        -> [String: Any]
    {
        switch request.method {
        case "accessibility.snapshot":
            let result = try accessibilitySnapshot(device, params: request.params, android: android)
            return result
        case "accessibility.observe":
            let result = try accessibilityObserve(device, params: request.params, android: android)
            return result
        case "accessibility.elementAtPoint":
            let result = try accessibilityElementAtPoint(device, params: request.params, android: android)
            return result
        case "accessibility.find":
            let selector = try request.params.dictionary("selector")
            let result: [String: Any]
            if device.platform == .android {
                result = try requireAndroidAccessibility(android).find(
                    selector: selector.foundationDictionary,
                    scope: request.params["scope"]?.stringValue ?? "visible"
                )
            } else {
                result = try accessibility.find(
                    udid: device.nativeIdentifier,
                    selector: selector.foundationDictionary,
                    scope: request.params["scope"]?.stringValue ?? "visible"
                )
            }
            return result
        case "accessibility.wait":
            let selector = try request.params.dictionary("selector").foundationDictionary
            let state = request.params["state"]?.stringValue ?? "visible"
            let timeout = request.params["timeoutMs"]?.intValue ?? 5_000
            let result =
                device.platform == .android
                ? try requireAndroidAccessibility(android).wait(selector: selector, state: state, timeoutMs: timeout)
                : try accessibility.wait(
                    udid: device.nativeIdentifier, selector: selector, state: state, timeoutMs: timeout)
            return result
        case "accessibility.providerStatus":
            return accessibility.providerStatus(udid: device.nativeIdentifier)
        case "accessibility.enableXCTestProvider":
            guard
                let bundleID = request.params["bundleId"]?.stringValue
                    ?? SimulatorForegroundApplication.bundleID(udid: device.nativeIdentifier)
            else {
                throw SimViewError(
                    "ACCESSIBILITY_TARGET_UNAVAILABLE",
                    "No foreground third-party application could be selected for XCTest accessibility"
                )
            }
            return try accessibility.enableXCTestProvider(udid: device.nativeIdentifier, bundleID: bundleID)
        case "accessibility.disableXCTestProvider":
            return accessibility.disableXCTestProvider(udid: device.nativeIdentifier)
        case "device.context":
            return try requireAndroidAccessibility(android).context()
        default:
            throw SimViewError("METHOD_UNSUPPORTED", "Unsupported accessibility method")
        }
    }

    private func accessibilitySnapshot(
        _ device: DeviceDescription, params: [String: JSONValue], android: AndroidAccessibilityService?
    ) throws -> [String: Any] {
        if device.platform == .android {
            return try requireAndroidAccessibility(android).snapshot(
                scope: params["scope"]?.stringValue ?? "interactive",
                maxNodes: params["maxNodes"]?.intValue ?? 1_200
            )
        }
        return try accessibility.snapshot(
            udid: device.nativeIdentifier,
            scope: params["scope"]?.stringValue ?? "interactive",
            maxNodes: params["maxNodes"]?.intValue ?? 1_200
        )
    }

    private func accessibilityObserve(
        _ device: DeviceDescription, params: [String: JSONValue], android: AndroidAccessibilityService?
    ) throws -> [String: Any] {
        let scope = params["scope"]?.stringValue ?? "interactive"
        let maxNodes = params["maxNodes"]?.intValue ?? 1_200
        let quiet = params["settleQuietMs"]?.intValue ?? 75
        let maximumWait = params["maxWaitMs"]?.intValue ?? 500
        let afterRevision = params["afterRevision"]?.stringValue
        let requireChange = params["requireChange"] != .bool(false)
        if device.platform == .ios {
            startIOSAccessibilityObservation(for: device)
        }
        let strategy =
            device.platform == .android
            ? try requireAndroidAccessibility(android).observationStrategy
            : accessibility.observationStrategy
        let result = try accessibilityObservation.observe(
            afterRevision: afterRevision,
            scope: scope,
            maxNodes: maxNodes,
            settleQuietMilliseconds: quiet,
            maximumWaitMilliseconds: maximumWait,
            requireChange: requireChange,
            strategy: strategy
        ) { [weak self] scope, maxNodes in
            guard let self else {
                throw SimViewError("ACCESSIBILITY_UNAVAILABLE", "SimView server is unavailable")
            }
            if device.platform == .android {
                return try self.requireAndroidAccessibility(android).snapshot(
                    scope: scope,
                    maxNodes: maxNodes
                )
            }
            return try self.accessibility.snapshot(
                udid: device.nativeIdentifier,
                scope: scope,
                maxNodes: maxNodes
            )
        }
        let formatter = ISO8601DateFormatter()
        var value: [String: Any] = [
            "snapshot": result.snapshot,
            "revision": result.revision,
            "eventChanged": result.eventChanged,
            "stable": result.stable,
            "timedOut": result.timedOut,
            "strategy": result.strategy,
            "settledAt": formatter.string(from: result.settledAt),
            "fallbackUsed": result.fallbackUsed,
            "captureCount": result.captureCount,
            "changeSource": result.changeSource,
        ]
        if let firstChangedAt = result.firstChangedAt {
            value["firstChangedAt"] = formatter.string(from: firstChangedAt)
        }
        return value
    }

    private func accessibilityElementAtPoint(
        _ device: DeviceDescription, params: [String: JSONValue], android: AndroidAccessibilityService?
    ) throws -> [String: Any] {
        if device.platform == .android {
            return try requireAndroidAccessibility(android).elementAtPoint(
                x: params.double("x"), y: params.double("y")
            )
        }
        return try accessibility.elementAtPoint(
            udid: device.nativeIdentifier,
            x: params.double("x"),
            y: params.double("y")
        )
    }

}
