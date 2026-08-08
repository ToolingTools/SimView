import Foundation

struct H264DecodeSchedulingPolicy: Sendable {
    enum Decision: Equatable, Sendable {
        case submit(generation: UInt64)
        case drop
        case resynchronize
    }

    let maximumWorkCount: Int
    private(set) var workCount = 0
    private(set) var generation: UInt64 = 0
    private(set) var waitingForKeyframe = false

    init(maximumWorkCount: Int) {
        precondition(maximumWorkCount > 0)
        self.maximumWorkCount = maximumWorkCount
    }

    mutating func receive(isKeyframe: Bool) -> Decision {
        if waitingForKeyframe {
            guard isKeyframe else { return .drop }
            generation &+= 1
            workCount = 1
            waitingForKeyframe = false
            return .submit(generation: generation)
        }
        guard workCount < maximumWorkCount else {
            generation &+= 1
            workCount = 0
            waitingForKeyframe = true
            return .resynchronize
        }
        workCount += 1
        return .submit(generation: generation)
    }

    mutating func complete(generation: UInt64) {
        guard generation == self.generation, workCount > 0 else { return }
        workCount -= 1
    }

    mutating func reset() {
        generation &+= 1
        workCount = 0
        waitingForKeyframe = false
    }
}

struct H264DecodeFailurePolicy: Sendable {
    let maximumConsecutiveFailures: Int
    private(set) var consecutiveFailures = 0
    private(set) var recoveryTriggered = false

    init(maximumConsecutiveFailures: Int) {
        precondition(maximumConsecutiveFailures > 0)
        self.maximumConsecutiveFailures = maximumConsecutiveFailures
    }

    mutating func recordFailure() -> Bool {
        guard !recoveryTriggered else { return false }
        consecutiveFailures += 1
        guard consecutiveFailures >= maximumConsecutiveFailures else { return false }
        recoveryTriggered = true
        return true
    }

    mutating func recordSuccess() {
        consecutiveFailures = 0
    }

    mutating func reset() {
        consecutiveFailures = 0
        recoveryTriggered = false
    }
}
