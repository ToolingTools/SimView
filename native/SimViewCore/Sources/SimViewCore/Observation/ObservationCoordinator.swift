import CoreVideo
import Foundation

struct PreparedObservation: @unchecked Sendable {
    let observationID: String
    let frameID: String
    let frameRevision: UInt64
    let changeRevision: UInt64
    let imageRevision: UInt64
    let capturedAt: Date
    let settledAt: Date
    let stable: Bool
    let width: Int
    let height: Int
    let image: Data?
    let cacheHit: Bool
    let firstChangedFrameAt: Date?
    let imageReadyAt: Date?
}

final class ObservationCoordinator: @unchecked Sendable {
    enum ImagePreparationPolicy: Sendable {
        case eagerOnChange
        case onDemand
    }

    typealias PreparedImage = (data: Data, width: Int, height: Int)
    typealias ImagePreparationHandler = @Sendable (CVPixelBuffer) throws -> PreparedImage

    private static let defaultQuietInterval: TimeInterval = 0.075
    private let condition = NSCondition()
    private let imageQueue = DispatchQueue(label: "dev.simview.observation.image", qos: .userInitiated)
    private let prepareImage: ImagePreparationHandler
    private let didAttemptImagePreparation: @Sendable () -> Void
    private let didCompleteImagePreparation: @Sendable () -> Void
    private var imagePreparationPolicy: ImagePreparationPolicy
    private var frame: CVPixelBuffer?
    private var frameID = "0"
    private var frameRevision: UInt64 = 0
    private var changeRevision: UInt64 = 0
    private var capturedAt = Date.distantPast
    private var lastMeaningfulChange = Date.distantPast
    private var firstChangedFrameAt: Date?
    private var signature: [UInt8]?
    private var preparedImage: Data?
    private var currentWidth = 0
    private var currentHeight = 0
    private var preparedWidth = 0
    private var preparedHeight = 0
    private var imageRevision: UInt64 = 0
    private var imageReadyAt: Date?
    private var encodeScheduled = false
    private var generation: UInt64 = 0

    init(
        imagePreparationPolicy: ImagePreparationPolicy = .eagerOnChange,
        prepareImage: @escaping ImagePreparationHandler = { try ImageEncoder.preparedJPEG($0) },
        didAttemptImagePreparation: @escaping @Sendable () -> Void = {},
        didCompleteImagePreparation: @escaping @Sendable () -> Void = {}
    ) {
        self.imagePreparationPolicy = imagePreparationPolicy
        self.prepareImage = prepareImage
        self.didAttemptImagePreparation = didAttemptImagePreparation
        self.didCompleteImagePreparation = didCompleteImagePreparation
    }

    func setImagePreparationPolicy(_ policy: ImagePreparationPolicy) {
        condition.lock()
        imagePreparationPolicy = policy
        if policy == .onDemand, encodeScheduled {
            encodeScheduled = false
            generation &+= 1
        }
        let shouldSchedule =
            policy == .eagerOnChange && frame != nil && imageRevision != changeRevision
            && !encodeScheduled
        if shouldSchedule { encodeScheduled = true }
        let encodeGeneration = generation
        condition.unlock()
        if shouldSchedule {
            scheduleEncode(after: Self.defaultQuietInterval, generation: encodeGeneration)
        }
    }

    func ingest(_ frame: CVPixelBuffer, frameID: String) {
        let nextSignature = Self.lumaSignature(frame)
        let now = Date()
        condition.lock()
        let changed = signature.map { Self.hasMeaningfulDifference($0, nextSignature) } ?? true
        self.frame = frame
        self.frameID = frameID
        currentWidth = CVPixelBufferGetWidth(frame)
        currentHeight = CVPixelBufferGetHeight(frame)
        frameRevision &+= 1
        capturedAt = now
        signature = nextSignature
        if changed {
            changeRevision &+= 1
            lastMeaningfulChange = now
            firstChangedFrameAt = firstChangedFrameAt ?? now
        }
        let shouldSchedule =
            changed && imagePreparationPolicy == .eagerOnChange && !encodeScheduled
        if shouldSchedule { encodeScheduled = true }
        let encodeGeneration = generation
        condition.broadcast()
        condition.unlock()
        if shouldSchedule {
            scheduleEncode(after: Self.defaultQuietInterval, generation: encodeGeneration)
        }
    }

    func observe(
        visual: Bool,
        afterRevision: UInt64?,
        quietMilliseconds: Int = 75,
        maximumWaitMilliseconds: Int = 500
    ) throws -> PreparedObservation {
        let quiet = TimeInterval(quietMilliseconds) / 1_000
        let deadline = Date().addingTimeInterval(TimeInterval(maximumWaitMilliseconds) / 1_000)
        condition.lock()
        defer { condition.unlock() }
        if visual, (preparedImage == nil || imageRevision != changeRevision), !encodeScheduled {
            encodeScheduled = true
            scheduleEncode(after: 0, generation: generation)
        }
        while true {
            let now = Date()
            let postAction: Bool
            if let afterRevision {
                postAction = frameRevision > afterRevision
            } else {
                postAction = frameRevision > 0
            }
            let stable = postAction && now.timeIntervalSince(lastMeaningfulChange) >= quiet
            let imageReady = !visual || (preparedImage != nil && imageRevision == changeRevision)
            if stable && imageReady { break }
            if now >= deadline { break }
            condition.wait(until: min(deadline, now.addingTimeInterval(0.025)))
        }
        guard frameRevision > 0 else {
            throw SimViewError("OBSERVATION_UNAVAILABLE", "No device frame is available yet")
        }
        let now = Date()
        let isPostAction: Bool
        if let afterRevision {
            isPostAction = frameRevision > afterRevision
        } else {
            isPostAction = true
        }
        let stable = isPostAction && now.timeIntervalSince(lastMeaningfulChange) >= quiet
        let image = visual && imageRevision == changeRevision ? preparedImage : nil
        return PreparedObservation(
            observationID: "frame-\(frameRevision)",
            frameID: frameID,
            frameRevision: frameRevision,
            changeRevision: changeRevision,
            imageRevision: imageRevision,
            capturedAt: capturedAt,
            settledAt: now,
            stable: stable,
            width: image == nil ? currentWidth : preparedWidth,
            height: image == nil ? currentHeight : preparedHeight,
            image: image,
            cacheHit: image != nil && imageReadyAt.map { $0 < now } == true,
            firstChangedFrameAt: firstChangedFrameAt,
            imageReadyAt: imageReadyAt
        )
    }

    func clear() {
        condition.lock()
        frame = nil
        frameID = "0"
        frameRevision = 0
        changeRevision = 0
        capturedAt = .distantPast
        lastMeaningfulChange = .distantPast
        firstChangedFrameAt = nil
        signature = nil
        preparedImage = nil
        currentWidth = 0
        currentHeight = 0
        preparedWidth = 0
        preparedHeight = 0
        imageRevision = 0
        imageReadyAt = nil
        encodeScheduled = false
        generation &+= 1
        condition.broadcast()
        condition.unlock()
    }

    private func scheduleEncode(after delay: TimeInterval, generation: UInt64) {
        imageQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.encodeNewest(generation: generation)
        }
    }

    private func encodeNewest(generation scheduledGeneration: UInt64) {
        condition.lock()
        guard scheduledGeneration == generation, encodeScheduled else {
            condition.unlock()
            return
        }
        let remaining = Self.defaultQuietInterval - Date().timeIntervalSince(lastMeaningfulChange)
        if remaining > 0 {
            condition.unlock()
            scheduleEncode(after: remaining, generation: scheduledGeneration)
            return
        }
        guard let frame else {
            encodeScheduled = false
            condition.unlock()
            return
        }
        let revision = changeRevision
        let encodeGeneration = generation
        condition.unlock()
        didAttemptImagePreparation()
        let encoded = try? prepareImage(frame)
        if encoded != nil { didCompleteImagePreparation() }
        condition.lock()
        guard encodeGeneration == generation else {
            condition.unlock()
            return
        }
        if revision == changeRevision, let encoded {
            preparedImage = encoded.data
            preparedWidth = encoded.width
            preparedHeight = encoded.height
            imageRevision = revision
            imageReadyAt = Date()
            encodeScheduled = false
            condition.broadcast()
            condition.unlock()
            return
        }
        if revision == changeRevision {
            encodeScheduled = false
            condition.broadcast()
            condition.unlock()
            return
        }
        condition.unlock()
        scheduleEncode(after: 0, generation: scheduledGeneration)
    }

    private static func lumaSignature(_ pixelBuffer: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return [] }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var result = [UInt8](repeating: 0, count: 64 * 64)
        for row in 0..<64 {
            let y = min(height - 1, row * height / 64)
            for column in 0..<64 {
                let x = min(width - 1, column * width / 64)
                let offset = y * stride + x * 4
                let blue = Int(bytes[offset])
                let green = Int(bytes[offset + 1])
                let red = Int(bytes[offset + 2])
                result[row * 64 + column] = UInt8(
                    clamping: (77 * red + 150 * green + 29 * blue) >> 8)
            }
        }
        return result
    }

    private static func hasMeaningfulDifference(_ lhs: [UInt8], _ rhs: [UInt8]) -> Bool {
        guard !lhs.isEmpty, lhs.count == rhs.count else { return true }
        let threshold = 2 * lhs.count
        var total = 0
        for index in lhs.indices {
            total += abs(Int(lhs[index]) - Int(rhs[index]))
            if total >= threshold { return true }
        }
        return false
    }
}
