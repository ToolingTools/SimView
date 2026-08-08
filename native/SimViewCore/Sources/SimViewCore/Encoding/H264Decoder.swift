import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

final class H264Decoder: @unchecked Sendable {
    typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime) -> Void
    typealias FailureHandler = @Sendable (Error) -> Void
    typealias RecoveryHandler = @Sendable () -> Void

    enum Event: Sendable {
        case received
        case scheduled(workCount: Int)
        case submitted
        case callback(latencyMilliseconds: Double)
        case dropped
        case submissionFailure(submitted: Bool)
        case callbackFailure
        case recovery
    }

    private final class Submission: @unchecked Sendable {
        let generation: UInt64
        let submittedAt: DispatchTime

        init(generation: UInt64) {
            self.generation = generation
            submittedAt = .now()
        }
    }

    static let defaultMaximumWorkCount = 4
    private let queue = DispatchQueue(label: "dev.simview.h264.decoder", qos: .userInteractive)
    private let stateLock = NSLock()
    private let boundedSchedulingEnabled: Bool
    private let eventHandler: @Sendable (Event) -> Void
    private var schedulingPolicy: H264DecodeSchedulingPolicy
    private var formatDescription: CMVideoFormatDescription?
    private var session: VTDecompressionSession?
    private var handler: FrameHandler?
    private var failureHandler: FailureHandler?
    private var recoveryHandler: RecoveryHandler?

    init(
        maximumWorkCount: Int = H264Decoder.defaultMaximumWorkCount,
        boundedSchedulingEnabled: Bool = ProcessInfo.processInfo.environment[
            "SIMVIEW_BOUNDED_ANDROID_OBSERVATION_DECODER"] != "0",
        eventHandler: @escaping @Sendable (Event) -> Void = { _ in }
    ) {
        schedulingPolicy = H264DecodeSchedulingPolicy(maximumWorkCount: maximumWorkCount)
        self.boundedSchedulingEnabled = boundedSchedulingEnabled
        self.eventHandler = eventHandler
    }

    func configure(
        _ avcConfiguration: Data,
        handler: @escaping FrameHandler,
        failureHandler: @escaping FailureHandler = { _ in },
        recoveryHandler: @escaping RecoveryHandler = {}
    ) throws {
        let parameterSets = try Self.parameterSets(from: avcConfiguration)
        let format = try Self.makeFormatDescription(parameterSets)
        try queue.sync {
            stopLocked()
            self.handler = handler
            self.failureHandler = failureHandler
            self.recoveryHandler = recoveryHandler
            formatDescription = format
            session = try makeSession(format: format)
        }
    }

    func decode(_ accessUnit: Data, timestampMicros: UInt64, keyframe: Bool = false) {
        eventHandler(.received)
        let decision: H264DecodeSchedulingPolicy.Decision
        stateLock.lock()
        if boundedSchedulingEnabled {
            decision = schedulingPolicy.receive(isKeyframe: keyframe)
        } else {
            decision = .submit(generation: schedulingPolicy.generation)
        }
        let workCount = schedulingPolicy.workCount
        stateLock.unlock()
        switch decision {
        case .drop:
            eventHandler(.dropped)
            return
        case .resynchronize:
            eventHandler(.dropped)
            eventHandler(.recovery)
            queue.async { [weak self] in self?.invalidateSessionLocked() }
            recoveryHandler?()
            return
        case .submit(let generation):
            eventHandler(.scheduled(workCount: workCount))
            queue.async { [weak self] in
                self?.submit(
                    accessUnit,
                    timestampMicros: timestampMicros,
                    keyframe: keyframe,
                    generation: generation
                )
            }
        }
    }

    private func submit(
        _ accessUnit: Data,
        timestampMicros: UInt64,
        keyframe: Bool,
        generation: UInt64
    ) {
        var submitted = false
        do {
            guard let formatDescription else {
                throw SimViewError(
                    "ANDROID_H264_DECODE_FAILED", "The Android H.264 decoder is not configured")
            }
            if session == nil, keyframe { session = try makeSession(format: formatDescription) }
            guard let session else {
                throw SimViewError(
                    "ANDROID_H264_DECODE_FAILED",
                    "The Android H.264 decoder is waiting for a recovery keyframe"
                )
            }
            let block = try Self.makeBlockBuffer(accessUnit)
            var timing = CMSampleTimingInfo(
                duration: .invalid,
                presentationTimeStamp: CMTime(
                    value: CMTimeValue(timestampMicros), timescale: 1_000_000),
                decodeTimeStamp: .invalid
            )
            var size = accessUnit.count
            var sample: CMSampleBuffer?
            let status = CMSampleBufferCreateReady(
                allocator: kCFAllocatorDefault,
                dataBuffer: block,
                formatDescription: formatDescription,
                sampleCount: 1,
                sampleTimingEntryCount: 1,
                sampleTimingArray: &timing,
                sampleSizeEntryCount: 1,
                sampleSizeArray: &size,
                sampleBufferOut: &sample
            )
            guard status == noErr, let sample else {
                throw SimViewError(
                    "ANDROID_H264_DECODE_FAILED", "Could not create an H.264 sample (status \(status))")
            }
            let submission = Submission(generation: generation)
            let sourceFrameRefcon = Unmanaged.passRetained(submission).toOpaque()
            eventHandler(.submitted)
            submitted = true
            let decodeStatus = VTDecompressionSessionDecodeFrame(
                session,
                sampleBuffer: sample,
                flags: [._EnableAsynchronousDecompression, ._EnableTemporalProcessing],
                frameRefcon: sourceFrameRefcon,
                infoFlagsOut: nil
            )
            guard decodeStatus == noErr else {
                Unmanaged<Submission>.fromOpaque(sourceFrameRefcon).release()
                throw SimViewError(
                    "ANDROID_H264_DECODE_FAILED",
                    "VideoToolbox rejected an Android H.264 frame (status \(decodeStatus))"
                )
            }
        } catch {
            finish(generation: generation)
            eventHandler(.submissionFailure(submitted: submitted))
            failureHandler?(error)
        }
    }

    private func finish(generation: UInt64) {
        stateLock.lock()
        schedulingPolicy.complete(generation: generation)
        stateLock.unlock()
    }

    private func receiveCallback(
        submission: Submission,
        status: OSStatus,
        image: CVImageBuffer?,
        timestamp: CMTime
    ) {
        finish(generation: submission.generation)
        let latency =
            Double(DispatchTime.now().uptimeNanoseconds - submission.submittedAt.uptimeNanoseconds)
            / 1_000_000
        eventHandler(.callback(latencyMilliseconds: latency))
        guard status == noErr, let image else {
            eventHandler(.callbackFailure)
            failureHandler?(
                SimViewError(
                    "ANDROID_H264_DECODE_FAILED",
                    "VideoToolbox failed an Android H.264 callback (status \(status))"
                ))
            return
        }
        handler?(image, timestamp)
    }

    private func makeSession(format: CMVideoFormatDescription) throws -> VTDecompressionSession {
        var callback = VTDecompressionOutputCallbackRecord(
            decompressionOutputCallback: { reference, sourceFrameRefcon, status, _, image, timestamp, _ in
                guard let reference, let sourceFrameRefcon else { return }
                let decoder = Unmanaged<H264Decoder>.fromOpaque(reference).takeUnretainedValue()
                let submission = Unmanaged<Submission>.fromOpaque(sourceFrameRefcon).takeRetainedValue()
                decoder.receiveCallback(
                    submission: submission, status: status, image: image, timestamp: timestamp)
            },
            decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var created: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: format,
            decoderSpecification: nil,
            imageBufferAttributes: attributes as CFDictionary,
            outputCallback: &callback,
            decompressionSessionOut: &created
        )
        guard status == noErr, let created else {
            throw SimViewError(
                "ANDROID_H264_DECODER_UNAVAILABLE",
                "VideoToolbox could not create an Android H.264 decoder (status \(status))"
            )
        }
        return created
    }

    private func invalidateSessionLocked() {
        if let session {
            VTDecompressionSessionWaitForAsynchronousFrames(session)
            VTDecompressionSessionInvalidate(session)
        }
        session = nil
    }

    func stop() {
        queue.sync { stopLocked() }
    }

    private func stopLocked() {
        invalidateSessionLocked()
        stateLock.lock()
        schedulingPolicy.reset()
        stateLock.unlock()
        formatDescription = nil
        handler = nil
        failureHandler = nil
        recoveryHandler = nil
    }

    private static func parameterSets(from data: Data) throws -> [Data] {
        guard data.count >= 7, data[0] == 1 else {
            throw SimViewError("ANDROID_H264_CONFIGURATION_INVALID", "AVC configuration is truncated")
        }
        var offset = 5
        let spsCount = Int(data[offset] & 0x1F)
        offset += 1
        var result: [Data] = []
        for _ in 0..<spsCount { result.append(try readParameterSet(data, offset: &offset)) }
        guard offset < data.count else {
            throw SimViewError("ANDROID_H264_CONFIGURATION_INVALID", "AVC configuration has no PPS")
        }
        let ppsCount = Int(data[offset])
        offset += 1
        for _ in 0..<ppsCount { result.append(try readParameterSet(data, offset: &offset)) }
        guard spsCount > 0, ppsCount > 0 else {
            throw SimViewError("ANDROID_H264_CONFIGURATION_INVALID", "AVC configuration requires SPS and PPS")
        }
        return result
    }

    private static func readParameterSet(_ data: Data, offset: inout Int) throws -> Data {
        guard offset + 2 <= data.count else {
            throw SimViewError("ANDROID_H264_CONFIGURATION_INVALID", "AVC parameter-set length is truncated")
        }
        let length = Int(data[offset]) << 8 | Int(data[offset + 1])
        offset += 2
        guard length > 0, offset + length <= data.count else {
            throw SimViewError("ANDROID_H264_CONFIGURATION_INVALID", "AVC parameter set is truncated")
        }
        defer { offset += length }
        return data.subdata(in: offset..<(offset + length))
    }

    private static func makeFormatDescription(_ parameterSets: [Data]) throws -> CMVideoFormatDescription {
        let combined = parameterSets.reduce(into: Data()) { $0.append($1) }
        let sizes = parameterSets.map(\.count)
        var offsets: [Int] = []
        var offset = 0
        for size in sizes {
            offsets.append(offset)
            offset += size
        }
        var description: CMFormatDescription?
        let status = combined.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return -1 }
            let pointers = offsets.map { base.advanced(by: $0) }
            return pointers.withUnsafeBufferPointer { pointerBuffer in
                sizes.withUnsafeBufferPointer { sizeBuffer in
                    CMVideoFormatDescriptionCreateFromH264ParameterSets(
                        allocator: kCFAllocatorDefault,
                        parameterSetCount: parameterSets.count,
                        parameterSetPointers: pointerBuffer.baseAddress!,
                        parameterSetSizes: sizeBuffer.baseAddress!,
                        nalUnitHeaderLength: 4,
                        formatDescriptionOut: &description
                    )
                }
            }
        }
        guard status == noErr, let description else {
            throw SimViewError(
                "ANDROID_H264_CONFIGURATION_INVALID",
                "VideoToolbox rejected the Android AVC configuration (status \(status))"
            )
        }
        return description
    }

    private static func makeBlockBuffer(_ data: Data) throws -> CMBlockBuffer {
        var block: CMBlockBuffer?
        let status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: data.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: data.count,
            flags: 0,
            blockBufferOut: &block
        )
        guard status == kCMBlockBufferNoErr, let block else {
            throw SimViewError("ANDROID_H264_DECODE_FAILED", "Could not allocate an H.264 sample buffer")
        }
        let replacement = data.withUnsafeBytes { raw in
            CMBlockBufferReplaceDataBytes(
                with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0,
                dataLength: data.count
            )
        }
        guard replacement == kCMBlockBufferNoErr else {
            throw SimViewError("ANDROID_H264_DECODE_FAILED", "Could not populate an H.264 sample buffer")
        }
        return block
    }
}
