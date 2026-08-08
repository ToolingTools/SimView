import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

final class H264Decoder: @unchecked Sendable {
    typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime) -> Void

    private let queue = DispatchQueue(label: "dev.simview.h264.decoder", qos: .userInteractive)
    private var formatDescription: CMVideoFormatDescription?
    private var session: VTDecompressionSession?
    private var handler: FrameHandler?

    func configure(_ avcConfiguration: Data, handler: @escaping FrameHandler) throws {
        let parameterSets = try Self.parameterSets(from: avcConfiguration)
        let format = try Self.makeFormatDescription(parameterSets)
        try queue.sync {
            stopLocked()
            self.handler = handler
            var callback = VTDecompressionOutputCallbackRecord(
                decompressionOutputCallback: { reference, _, status, _, image, timestamp, _ in
                    guard status == noErr, let reference, let image else { return }
                    let decoder = Unmanaged<H264Decoder>.fromOpaque(reference).takeUnretainedValue()
                    decoder.handler?(image, timestamp)
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
            formatDescription = format
            session = created
        }
    }

    func decode(_ accessUnit: Data, timestampMicros: UInt64) {
        queue.async { [weak self] in
            guard let self, let session, let formatDescription else { return }
            do {
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
                guard status == noErr, let sample else { return }
                VTDecompressionSessionDecodeFrame(
                    session,
                    sampleBuffer: sample,
                    flags: [._EnableAsynchronousDecompression, ._EnableTemporalProcessing],
                    frameRefcon: nil,
                    infoFlagsOut: nil
                )
            } catch {
                return
            }
        }
    }

    func stop() {
        queue.sync { stopLocked() }
    }

    private func stopLocked() {
        if let session {
            VTDecompressionSessionWaitForAsynchronousFrames(session)
            VTDecompressionSessionInvalidate(session)
        }
        session = nil
        formatDescription = nil
        handler = nil
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
