import Darwin
import Foundation

/// A terminal shutdown signal, not provider state. Socket registration and
/// interruption share a lock so shutdown cannot touch a closed/reused descriptor.
final class AccessibilityCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var sockets = Set<Int32>()

    func check() throws {
        if lock.withLock({ cancelled }) {
            throw SimViewError("ACCESSIBILITY_CANCELLED", "Accessibility worker is shutting down")
        }
    }

    func withSocket<T>(_ descriptor: Int32, operation: () throws -> T) throws -> T {
        try lock.withLock {
            guard !cancelled else {
                throw SimViewError("ACCESSIBILITY_CANCELLED", "Accessibility worker is shutting down")
            }
            sockets.insert(descriptor)
        }
        defer { _ = lock.withLock { sockets.remove(descriptor) } }
        return try operation()
    }

    func cancel() {
        lock.withLock {
            cancelled = true
            for descriptor in sockets { Darwin.shutdown(descriptor, SHUT_RDWR) }
        }
    }
}
