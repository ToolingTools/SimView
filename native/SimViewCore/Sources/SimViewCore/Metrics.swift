import Foundation

final class Metrics: @unchecked Sendable {
    private static let latencyCapacity = 2_000

    private let lock = NSLock()
    private var captured: UInt64 = 0
    private var encoded: UInt64 = 0
    private var delivered: UInt64 = 0
    private var dropped: UInt64 = 0
    private var imageEncodeAttempts: UInt64 = 0
    private var imageEncodeCompletions: UInt64 = 0
    private var previewPacketCopies: UInt64 = 0
    private var adbFallbacks: UInt64 = 0
    private var androidDecoderFailures: UInt64 = 0
    private var androidDecodeAccessUnits: UInt64 = 0
    private var androidDecodeSubmissions: UInt64 = 0
    private var androidDecodeCallbacks: UInt64 = 0
    private var androidDecodeWork = 0
    private var androidDecodePeakWork = 0
    private var androidDecodeQueued = 0
    private var androidDecodeOutstanding = 0
    private var androidDecodeDrops: UInt64 = 0
    private var androidDecodeSubmissionFailures: UInt64 = 0
    private var androidDecodeCallbackFailures: UInt64 = 0
    private var androidDecodeRecoveries: UInt64 = 0
    private var androidDecodeCallbackLatencyTotalMS = 0.0
    private var androidDecodeCallbackLatencyMaximumMS = 0.0
    private var observationReturns: UInt64 = 0
    private var inputDispatches: UInt64 = 0
    private var inputAcknowledgements: UInt64 = 0
    private var lastInputDispatchedAt: Date?
    private var lastInputAcknowledgedAt: Date?
    private var latencies = [Double](repeating: 0, count: latencyCapacity)
    private var latencyCount = 0
    private var nextLatencyIndex = 0
    private let started = Date()

    func didCapture() { mutate { captured += 1 } }

    func didEncode(latencyMS: Double) {
        mutate {
            encoded += 1
            latencies[nextLatencyIndex] = latencyMS
            nextLatencyIndex = (nextLatencyIndex + 1) % Self.latencyCapacity
            latencyCount = min(latencyCount + 1, Self.latencyCapacity)
        }
    }

    func didDeliver() { mutate { delivered += 1 } }
    func didDrop() { mutate { dropped += 1 } }
    func didAttemptImageEncode() { mutate { imageEncodeAttempts += 1 } }
    func didCompleteImageEncode() { mutate { imageEncodeCompletions += 1 } }
    func didCopyPreviewPacket() { mutate { previewPacketCopies += 1 } }
    func didUseADBFallback() { mutate { adbFallbacks += 1 } }
    func didFailAndroidDecoder() { mutate { androidDecoderFailures += 1 } }
    func didReceiveAndroidDecodeAccessUnit() { mutate { androidDecodeAccessUnits += 1 } }
    func didScheduleAndroidDecode(workCount: Int) {
        mutate {
            androidDecodeWork = workCount
            androidDecodePeakWork = max(androidDecodePeakWork, workCount)
            androidDecodeQueued += 1
        }
    }
    func didSubmitAndroidDecode() {
        mutate {
            androidDecodeSubmissions += 1
            androidDecodeQueued = max(0, androidDecodeQueued - 1)
            androidDecodeOutstanding += 1
        }
    }
    func didCompleteAndroidDecodeCallback(latencyMilliseconds: Double) {
        mutate {
            androidDecodeCallbacks += 1
            androidDecodeWork = max(0, androidDecodeWork - 1)
            androidDecodeOutstanding = max(0, androidDecodeOutstanding - 1)
            androidDecodeCallbackLatencyTotalMS += latencyMilliseconds
            androidDecodeCallbackLatencyMaximumMS = max(
                androidDecodeCallbackLatencyMaximumMS, latencyMilliseconds)
        }
    }
    func didDropAndroidDecode() { mutate { androidDecodeDrops += 1 } }
    func didFailAndroidDecodeSubmission(submitted: Bool) {
        mutate {
            androidDecoderFailures += 1
            androidDecodeSubmissionFailures += 1
            androidDecodeWork = max(0, androidDecodeWork - 1)
            if submitted {
                androidDecodeOutstanding = max(0, androidDecodeOutstanding - 1)
            } else {
                androidDecodeQueued = max(0, androidDecodeQueued - 1)
            }
        }
    }
    func didFailAndroidDecodeCallback() {
        mutate {
            androidDecoderFailures += 1
            androidDecodeCallbackFailures += 1
        }
    }
    func didRecoverAndroidDecode() {
        mutate {
            androidDecodeRecoveries += 1
            androidDecodeWork = 0
            androidDecodeQueued = 0
            androidDecodeOutstanding = 0
        }
    }
    func didReturnObservation() { mutate { observationReturns += 1 } }
    func didDispatchInput() {
        mutate {
            inputDispatches += 1
            lastInputDispatchedAt = Date()
        }
    }
    func didAcknowledgeInput() {
        mutate {
            inputAcknowledgements += 1
            lastInputAcknowledgedAt = Date()
        }
    }

    var dictionary: [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let sorted = Array(latencies.prefix(latencyCount)).sorted()
        func percentile(_ fraction: Double) -> Double {
            guard !sorted.isEmpty else { return 0 }
            return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * fraction))]
        }
        return [
            "captured": captured,
            "encoded": encoded,
            "delivered": delivered,
            "dropped": dropped,
            "imageEncodes": imageEncodeCompletions,
            "imageEncodeAttempts": imageEncodeAttempts,
            "imageEncodeCompletions": imageEncodeCompletions,
            "previewPacketCopies": previewPacketCopies,
            "adbFallbacks": adbFallbacks,
            "androidDecoderFailures": androidDecoderFailures,
            "androidObservationDecoder": [
                "accessUnits": androidDecodeAccessUnits,
                "submissions": androidDecodeSubmissions,
                "callbacks": androidDecodeCallbacks,
                "work": androidDecodeWork,
                "peakWork": androidDecodePeakWork,
                "queued": androidDecodeQueued,
                "outstanding": androidDecodeOutstanding,
                "drops": androidDecodeDrops,
                "submissionFailures": androidDecodeSubmissionFailures,
                "callbackFailures": androidDecodeCallbackFailures,
                "recoveries": androidDecodeRecoveries,
                "callbackLatencyMs": [
                    "average": androidDecodeCallbacks == 0
                        ? 0 : androidDecodeCallbackLatencyTotalMS / Double(androidDecodeCallbacks),
                    "maximum": androidDecodeCallbackLatencyMaximumMS,
                ],
            ],
            "observationReturns": observationReturns,
            "inputDispatches": inputDispatches,
            "inputAcknowledgements": inputAcknowledgements,
            "lastInputDispatchedAt": lastInputDispatchedAt.map {
                ISO8601DateFormatter().string(from: $0) as Any
            } ?? NSNull(),
            "lastInputAcknowledgedAt": lastInputAcknowledgedAt.map {
                ISO8601DateFormatter().string(from: $0) as Any
            } ?? NSNull(),
            "latencyMs": ["p50": percentile(0.5), "p95": percentile(0.95)],
            "uptimeSeconds": Date().timeIntervalSince(started),
        ]
    }

    private func mutate(_ body: () -> Void) {
        lock.lock()
        body()
        lock.unlock()
    }
}
