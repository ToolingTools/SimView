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
    let fallbackUsed: Bool
    let captureCount: Int
    let changeSource: String
}

/// Coordinates accessibility events and tree captures without doing work on an
/// operating-system callback thread. Private accessibility bridges and the
/// Android agent only call `markEvent`; all tree traversal happens in `observe`.
final class AccessibilityObservationCoordinator: @unchecked Sendable {
    typealias SnapshotCapture = @Sendable (_ scope: String, _ maxNodes: Int) throws -> [String: Any]

    private static let initialPollInterval: TimeInterval = 0.150
    private static let maximumPollInterval: TimeInterval = 0.500
    private static let iosFallbackProbeDelay: TimeInterval = 0.150
    private let condition = NSCondition()
    private var revision: UInt64 = 0
    private var latestSnapshot: [String: Any]?
    private var latestScope: String?
    private var latestMaxNodes: Int?
    private var latestSignature: Data?
    private var lastChangedAt: Date?
    private var firstChangedAt: Date?
    private var generation: UInt64 = 0

    func reset() {
        condition.lock()
        revision = 0
        latestSnapshot = nil
        latestScope = nil
        latestMaxNodes = nil
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
        requireChange: Bool = true,
        strategy: String,
        capture: SnapshotCapture
    ) throws -> AccessibilityObservationResult {
        let quiet = TimeInterval(max(20, min(500, settleQuietMilliseconds))) / 1_000
        let maximumWait = TimeInterval(max(0, min(5_000, maximumWaitMilliseconds))) / 1_000
        let startedAt = Date()
        let deadline = startedAt.addingTimeInterval(maximumWait)
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
        let boundedMaxNodes = max(1, min(5_000, maxNodes))
        var captureCount = 0

        condition.lock()
        startGeneration = generation
        condition.unlock()

        // An omitted revision is an immediate baseline capture. This is also
        // the only path used to establish the first resource snapshot.
        if afterRevision == nil {
            captureCount += 1
            let snapshot = try capture(scope, boundedMaxNodes)
            let now = Date()
            recordSnapshot(snapshot, scope: scope, maxNodes: boundedMaxNodes)
            return result(
                snapshot: snapshot, eventChanged: false, stable: true, timedOut: false,
                strategy: strategy, settledAt: now, captureCount: captureCount
            )
        }

        // A tree projected with a different scope or budget is not a valid
        // timeout fallback. Materialize that configuration once, then keep
        // observing so a scope change cannot bypass the requested quiet period.
        var scopeCaptureChanged = false
        if cachedSnapshot(scope: scope, maxNodes: boundedMaxNodes) == nil {
            captureCount += 1
            let snapshot = try capture(scope, boundedMaxNodes)
            scopeCaptureChanged = recordSnapshot(
                snapshot, scope: scope, maxNodes: boundedMaxNodes)
        }

        if Self.isEventDriven(strategy) {
            let usesIOSFallback = strategy == "ios-axp" && requireChange
            let fallbackProbeAt = min(
                deadline,
                startedAt.addingTimeInterval(max(Self.iosFallbackProbeDelay, quiet)))
            var fallbackCaptureCount = 0
            var fallbackChangedAt: Date?
            var fallbackSnapshot = cachedSnapshot(scope: scope, maxNodes: boundedMaxNodes)!
            while true {
                if startGeneration != currentGeneration() {
                    throw SimViewError("ACCESSIBILITY_RESET", "Accessibility observation was reset")
                }
                condition.lock()
                let now = Date()
                let eventChanged = requestedRevision.map { revision > $0 } ?? false
                let quietAnchor = max(lastChangedAt ?? startedAt, startedAt)
                let quietAt = quietAnchor.addingTimeInterval(quiet)

                // A fallback diff found a changed tree. Confirm it after the
                // quiet window and keep polling if the confirmation also
                // changes, bounded by the original deadline.
                if let changeDetectedAt = fallbackChangedAt {
                    let fallbackQuietAt = changeDetectedAt.addingTimeInterval(quiet)
                    if now >= min(deadline, fallbackQuietAt) {
                        condition.unlock()
                        captureCount += 1
                        fallbackCaptureCount += 1
                        fallbackSnapshot = try capture(scope, boundedMaxNodes)
                        let treeChanged = recordSnapshot(
                            fallbackSnapshot, scope: scope, maxNodes: boundedMaxNodes)
                        if treeChanged && now < deadline {
                            fallbackChangedAt = Date()
                            continue
                        }
                        let settled = !treeChanged
                        return result(
                            snapshot: fallbackSnapshot,
                            eventChanged: true,
                            stable: settled,
                            timedOut: !settled && now >= deadline,
                            strategy: strategy,
                            settledAt: Date(),
                            fallbackUsed: true,
                            captureCount: captureCount,
                            changeSource: "snapshot-diff"
                        )
                    }
                    condition.wait(until: min(deadline, fallbackQuietAt))
                    condition.unlock()
                    continue
                }

                if (!requireChange || eventChanged), now >= quietAt {
                    condition.unlock()
                    captureCount += 1
                    let snapshot = try capture(scope, boundedMaxNodes)
                    let treeChanged = recordSnapshot(
                        snapshot, scope: scope, maxNodes: boundedMaxNodes)
                    let snapshotDiffChanged = scopeCaptureChanged && eventChanged
                    let changeSource =
                        snapshotDiffChanged || (!eventChanged && treeChanged)
                        ? "snapshot-diff" : eventChanged ? "event" : "none"
                    return result(
                        snapshot: snapshot,
                        eventChanged: eventChanged || treeChanged,
                        stable: true,
                        timedOut: false,
                        strategy: strategy,
                        settledAt: Date(),
                        fallbackUsed: fallbackCaptureCount > 0 || snapshotDiffChanged,
                        captureCount: captureCount,
                        changeSource: changeSource
                    )
                }

                if now >= deadline {
                    condition.unlock()
                    if usesIOSFallback && fallbackCaptureCount < 2 {
                        captureCount += 1
                        fallbackCaptureCount += 1
                        fallbackSnapshot = try capture(scope, boundedMaxNodes)
                        let treeChanged = recordSnapshot(
                            fallbackSnapshot, scope: scope, maxNodes: boundedMaxNodes)
                        return result(
                            snapshot: fallbackSnapshot,
                            eventChanged: eventChanged || treeChanged,
                            stable: false,
                            timedOut: true,
                            strategy: strategy,
                            settledAt: Date(),
                            fallbackUsed: true,
                            captureCount: captureCount,
                            changeSource: treeChanged ? "snapshot-diff" : "none"
                        )
                    }
                    return result(
                        snapshot: fallbackSnapshot,
                        eventChanged: eventChanged,
                        stable: false,
                        timedOut: true,
                        strategy: strategy,
                        settledAt: now,
                        fallbackUsed: fallbackCaptureCount > 0,
                        captureCount: captureCount,
                        changeSource: eventChanged ? "event" : "none"
                    )
                }

                if usesIOSFallback && !eventChanged && fallbackCaptureCount == 0
                    && now >= fallbackProbeAt
                {
                    condition.unlock()
                    captureCount += 1
                    fallbackCaptureCount += 1
                    fallbackSnapshot = try capture(scope, boundedMaxNodes)
                    let treeChanged = recordSnapshot(
                        fallbackSnapshot, scope: scope, maxNodes: boundedMaxNodes)
                    if treeChanged {
                        fallbackChangedAt = Date()
                    }
                    continue
                }

                let wakeAt: Date
                if !requireChange || eventChanged {
                    wakeAt = min(deadline, quietAt)
                } else if usesIOSFallback && fallbackCaptureCount == 0 {
                    wakeAt = min(deadline, fallbackProbeAt)
                } else {
                    wakeAt = deadline
                }
                condition.wait(until: wakeAt)
                condition.unlock()
            }
        }

        // A shell hierarchy dump is heavyweight. Start at 150 ms and back off
        // to 500 ms while unchanged. After a changed tree survives the quiet
        // window, confirm it once so partially loaded content is not marked stable.
        var snapshot = cachedSnapshot(scope: scope, maxNodes: boundedMaxNodes)!
        var eventChanged = false
        var detectedChangeAt: Date?
        var pollInterval = Self.initialPollInterval
        var nextPollAt = startedAt.addingTimeInterval(
            requireChange ? pollInterval : max(pollInterval, quiet))
        while true {
            if startGeneration != currentGeneration() {
                throw SimViewError("ACCESSIBILITY_RESET", "Accessibility observation was reset")
            }
            condition.lock()
            let now = Date()
            if let changeDetectedAt = detectedChangeAt {
                let quietAt = changeDetectedAt.addingTimeInterval(quiet)
                if now >= quietAt {
                    condition.unlock()
                    captureCount += 1
                    snapshot = try capture(scope, boundedMaxNodes)
                    let confirmationChanged = recordSnapshot(
                        snapshot, scope: scope, maxNodes: boundedMaxNodes)
                    let confirmedAt = Date()
                    if confirmationChanged {
                        if confirmedAt >= deadline {
                            return result(
                                snapshot: snapshot, eventChanged: true, stable: false,
                                timedOut: true, strategy: strategy, settledAt: confirmedAt,
                                captureCount: captureCount, changeSource: "snapshot-diff"
                            )
                        }
                        detectedChangeAt = confirmedAt
                        pollInterval = Self.initialPollInterval
                        nextPollAt = confirmedAt.addingTimeInterval(pollInterval)
                        continue
                    }
                    return result(
                        snapshot: snapshot, eventChanged: true, stable: true, timedOut: false,
                        strategy: strategy, settledAt: confirmedAt, captureCount: captureCount,
                        changeSource: "snapshot-diff"
                    )
                }
                if now >= deadline {
                    condition.unlock()
                    return result(
                        snapshot: snapshot, eventChanged: true, stable: false, timedOut: true,
                        strategy: strategy, settledAt: now, captureCount: captureCount,
                        changeSource: "snapshot-diff"
                    )
                }
                condition.wait(until: min(deadline, quietAt))
                condition.unlock()
                continue
            }
            if now >= deadline {
                eventChanged = eventChanged || (requestedRevision.map { revision > $0 } ?? false)
                let stable = !requireChange && now.timeIntervalSince(startedAt) >= quiet
                condition.unlock()
                return result(
                    snapshot: snapshot,
                    eventChanged: eventChanged,
                    stable: stable,
                    timedOut: !stable,
                    strategy: strategy,
                    settledAt: now,
                    captureCount: captureCount,
                    changeSource: eventChanged ? "snapshot-diff" : "none"
                )
            }
            if now < nextPollAt {
                condition.wait(until: min(deadline, nextPollAt))
                condition.unlock()
                continue
            }
            condition.unlock()

            captureCount += 1
            snapshot = try capture(scope, boundedMaxNodes)
            let treeChanged = recordSnapshot(
                snapshot, scope: scope, maxNodes: boundedMaxNodes)
            eventChanged = eventChanged || treeChanged
            if treeChanged {
                detectedChangeAt = Date()
            } else if !requireChange {
                return result(
                    snapshot: snapshot, eventChanged: eventChanged, stable: true, timedOut: false,
                    strategy: strategy, settledAt: Date(), captureCount: captureCount,
                    changeSource: eventChanged ? "snapshot-diff" : "none"
                )
            } else {
                pollInterval = min(Self.maximumPollInterval, pollInterval * 2)
                nextPollAt = Date().addingTimeInterval(pollInterval)
            }
        }
    }

    private func currentGeneration() -> UInt64 {
        condition.lock()
        defer { condition.unlock() }
        return generation
    }

    private func cachedSnapshot(scope: String, maxNodes: Int) -> [String: Any]? {
        condition.lock()
        defer { condition.unlock() }
        guard latestScope == scope, latestMaxNodes == maxNodes else { return nil }
        return latestSnapshot
    }

    private func result(
        snapshot: [String: Any],
        eventChanged: Bool,
        stable: Bool,
        timedOut: Bool,
        strategy: String,
        settledAt: Date,
        fallbackUsed: Bool = false,
        captureCount: Int = 0,
        changeSource: String = "none"
    ) -> AccessibilityObservationResult {
        condition.lock()
        let outputRevision = String(revision)
        let firstChangedAt = firstChangedAt
        condition.unlock()
        return AccessibilityObservationResult(
            snapshot: snapshot,
            revision: outputRevision,
            eventChanged: eventChanged,
            stable: stable,
            timedOut: timedOut,
            strategy: strategy,
            firstChangedAt: firstChangedAt,
            settledAt: settledAt,
            fallbackUsed: fallbackUsed,
            captureCount: captureCount,
            changeSource: changeSource
        )
    }

    @discardableResult
    private func recordSnapshot(
        _ snapshot: [String: Any], scope: String, maxNodes: Int
    ) -> Bool {
        let signature = Self.signature(snapshot)
        condition.lock()
        let changed = latestSignature != signature
        latestSnapshot = snapshot
        latestScope = scope
        latestMaxNodes = maxNodes
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

    private static func isEventDriven(_ strategy: String) -> Bool {
        strategy == "ios-axp" || strategy == "android-uiautomation"
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
