import Foundation

struct AccessibilityObservationResult: @unchecked Sendable {
    let snapshot: [String: Any]
    let revision: String
    let eventChanged: Bool
    let stable: Bool
    let timedOut: Bool
    let strategy: String
    let firstChangedAt: Date?
    let settledAt: Date
}

/// Coordinates accessibility events and tree captures without doing work on an
/// operating-system callback thread. Private accessibility bridges and the
/// Android agent only call `markEvent`; all tree traversal happens in `observe`.
final class AccessibilityObservationCoordinator: @unchecked Sendable {
    typealias SnapshotCapture = @Sendable (_ scope: String, _ maxNodes: Int) throws -> [String: Any]

    private static let pollInterval: TimeInterval = 0.025
    private let condition = NSCondition()
    private var revision: UInt64 = 0
    private var latestSnapshot: [String: Any]?
    private var latestSignature: Data?
    private var lastChangedAt: Date?
    private var firstChangedAt: Date?
    private var generation: UInt64 = 0

    func reset() {
        condition.lock()
        revision = 0
        latestSnapshot = nil
        latestSignature = nil
        lastChangedAt = nil
        firstChangedAt = nil
        generation &+= 1
        condition.broadcast()
        condition.unlock()
    }

    /// Called by a native accessibility callback. It only changes coordinator
    /// state and wakes waiters; it never captures or serializes a tree.
    func markEvent() {
        condition.lock()
        revision &+= 1
        let now = Date()
        lastChangedAt = now
        firstChangedAt = firstChangedAt ?? now
        condition.broadcast()
        condition.unlock()
    }

    func currentRevision() -> String {
        condition.lock()
        defer { condition.unlock() }
        return String(revision)
    }

    func latest() -> [String: Any]? {
        condition.lock()
        defer { condition.unlock() }
        return latestSnapshot
    }

    func observe(
        afterRevision: String?,
        scope: String,
        maxNodes: Int,
        settleQuietMilliseconds: Int,
        maximumWaitMilliseconds: Int,
        strategy: String,
        capture: SnapshotCapture
    ) throws -> AccessibilityObservationResult {
        let quiet = TimeInterval(max(20, min(500, settleQuietMilliseconds))) / 1_000
        let maximumWait = TimeInterval(max(0, min(5_000, maximumWaitMilliseconds))) / 1_000
        let deadline = Date().addingTimeInterval(maximumWait)
        let requestedRevision: UInt64?
        if let afterRevision {
            guard let parsedRevision = UInt64(afterRevision) else {
                throw SimViewError(
                    "PARAMETER_INVALID",
                    "Accessibility observation revision must be an unsigned integer"
                )
            }
            requestedRevision = parsedRevision
        } else {
            requestedRevision = nil
        }
        let startGeneration: UInt64

        condition.lock()
        startGeneration = generation
        condition.unlock()

        // An omitted revision is an immediate baseline capture. This is also
        // the only path used to establish the first resource snapshot.
        if afterRevision == nil {
            let snapshot = try capture(scope, max(1, min(5_000, maxNodes)))
            let now = Date()
            recordSnapshot(snapshot)
            condition.lock()
            let outputRevision = String(revision)
            let firstChangedAt = firstChangedAt
            condition.unlock()
            return AccessibilityObservationResult(
                snapshot: snapshot,
                revision: outputRevision,
                eventChanged: false,
                stable: true,
                timedOut: false,
                strategy: strategy,
                firstChangedAt: firstChangedAt,
                settledAt: now
            )
        }

        var snapshot: [String: Any]?
        var eventChanged = false
        var stable = false
        var timedOut = false
        repeat {
            if startGeneration != currentGeneration() {
                throw SimViewError("ACCESSIBILITY_RESET", "Accessibility observation was reset")
            }
            snapshot = try capture(scope, max(1, min(5_000, maxNodes)))
            let treeChanged = recordSnapshot(snapshot!)
            condition.lock()
            let currentRevision = revision
            let lastChangedAt = self.lastChangedAt
            let now = Date()
            eventChanged = treeChanged || (requestedRevision.map { currentRevision > $0 } ?? false)
            stable = eventChanged && (lastChangedAt.map { now.timeIntervalSince($0) >= quiet } ?? treeChanged)
            if stable || now >= deadline {
                timedOut = !stable
                let outputRevision = String(revision)
                let firstChangedAt = self.firstChangedAt
                condition.unlock()
                return AccessibilityObservationResult(
                    snapshot: snapshot!,
                    revision: outputRevision,
                    eventChanged: eventChanged,
                    stable: stable,
                    timedOut: timedOut,
                    strategy: strategy,
                    firstChangedAt: firstChangedAt,
                    settledAt: now
                )
            }
            condition.wait(until: min(deadline, now.addingTimeInterval(Self.pollInterval)))
            condition.unlock()
        } while true
    }

    private func currentGeneration() -> UInt64 {
        condition.lock()
        defer { condition.unlock() }
        return generation
    }

    @discardableResult
    private func recordSnapshot(_ snapshot: [String: Any]) -> Bool {
        let signature = Self.signature(snapshot)
        condition.lock()
        let changed = latestSignature != signature
        latestSnapshot = snapshot
        latestSignature = signature
        if changed {
            revision &+= 1
            let now = Date()
            lastChangedAt = now
            firstChangedAt = firstChangedAt ?? now
            condition.broadcast()
        }
        condition.unlock()
        return changed
    }

    private static func signature(_ snapshot: [String: Any]) -> Data {
        let normalized = normalize(snapshot)
        return (try? JSONSerialization.data(withJSONObject: normalized, options: [.sortedKeys])) ?? Data()
    }

    private static func normalize(_ value: Any, key: String? = nil) -> Any {
        if key == "snapshotId" || key == "capturedAt" || key == "ref" { return NSNull() }
        if let dictionary = value as? [String: Any] {
            return dictionary.reduce(into: [String: Any]()) { result, item in
                guard item.key != "snapshotId", item.key != "capturedAt", item.key != "ref" else { return }
                result[item.key] = normalize(item.value, key: item.key)
            }
        }
        if let array = value as? [Any] {
            return array.map { normalize($0) }
        }
        return value
    }
}
