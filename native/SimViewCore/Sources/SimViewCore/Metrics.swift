import Foundation

final class Metrics: @unchecked Sendable {
    private static let latencyCapacity = 2_000

    private let lock = NSLock()
    private var captured: UInt64 = 0
    private var encoded: UInt64 = 0
    private var delivered: UInt64 = 0
    private var dropped: UInt64 = 0
    private var imageEncodes: UInt64 = 0
    private var previewPacketCopies: UInt64 = 0
    private var adbFallbacks: UInt64 = 0
    private var androidDecoderFailures: UInt64 = 0
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
    func didEncodeImage() { mutate { imageEncodes += 1 } }
    func didCopyPreviewPacket() { mutate { previewPacketCopies += 1 } }
    func didUseADBFallback() { mutate { adbFallbacks += 1 } }
    func didFailAndroidDecoder() { mutate { androidDecoderFailures += 1 } }
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
            "imageEncodes": imageEncodes,
            "previewPacketCopies": previewPacketCopies,
            "adbFallbacks": adbFallbacks,
            "androidDecoderFailures": androidDecoderFailures,
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
