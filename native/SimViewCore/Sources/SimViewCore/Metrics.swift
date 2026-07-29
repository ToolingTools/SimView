import Foundation

final class Metrics: @unchecked Sendable {
    private let lock = NSLock()
    private var captured: UInt64 = 0
    private var encoded: UInt64 = 0
    private var delivered: UInt64 = 0
    private var dropped: UInt64 = 0
    private var latencies: [Double] = []
    private let started = Date()

    func didCapture() { mutate { captured += 1 } }
    func didEncode(latencyMS: Double) {
        mutate {
            encoded += 1
            latencies.append(latencyMS)
            if latencies.count > 2_000 { latencies.removeFirst(latencies.count - 2_000) }
        }
    }
    func didDeliver() { mutate { delivered += 1 } }
    func didDrop() { mutate { dropped += 1 } }

    var dictionary: [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let sorted = latencies.sorted()
        func percentile(_ fraction: Double) -> Double {
            guard !sorted.isEmpty else { return 0 }
            return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * fraction))]
        }
        return [
            "captured": captured,
            "encoded": encoded,
            "delivered": delivered,
            "dropped": dropped,
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
