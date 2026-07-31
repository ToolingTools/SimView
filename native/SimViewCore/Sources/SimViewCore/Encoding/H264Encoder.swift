import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

actor H264Encoder {
    struct Encoded: Sendable {
        let configuration: Data?
        let keyframe: Bool
        let bytes: Data
    }

    private final class CompressionSessionBox: @unchecked Sendable {
        let value: VTCompressionSession

        init(_ value: VTCompressionSession) {
            self.value = value
        }

        func invalidate() {
            VTCompressionSessionInvalidate(value)
        }

        deinit {
            invalidate()
        }
    }

    private var session: CompressionSessionBox?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var frameCount: Int64 = 0
    private var emittedConfiguration = false
    private var forceNextKeyframe = true

    func forceKeyframe() {
        forceNextKeyframe = true
    }

    func stop() {
        if let session {
            session.invalidate()
            self.session = nil
        }
    }

    func encode(_ source: CVPixelBuffer) async throws -> Encoded {
        let nextWidth = Int32(CVPixelBufferGetWidth(source))
        let nextHeight = Int32(CVPixelBufferGetHeight(source))
        if session == nil || width != nextWidth || height != nextHeight {
            width = nextWidth
            height = nextHeight
            try rebuild()
        }
        guard let compressionSession = session?.value else {
            throw SimViewError("H264_UNAVAILABLE", "VideoToolbox could not create an H.264 session")
        }
        frameCount += 1
        let shouldForce = forceNextKeyframe
        forceNextKeyframe = false
        let properties: NSDictionary? =
            shouldForce
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as NSDictionary
            : nil
        let includeConfiguration = !emittedConfiguration
        let encoded: Encoded? = try await withCheckedThrowingContinuation { continuation in
            let status = VTCompressionSessionEncodeFrame(
                compressionSession,
                imageBuffer: source,
                presentationTimeStamp: CMTime(value: frameCount, timescale: 60),
                duration: .invalid,
                frameProperties: properties,
                infoFlagsOut: nil
            ) { status, _, sample in
                guard status == noErr, let sample else {
                    continuation.resume(
                        throwing: SimViewError(
                            "H264_ENCODE_FAILED",
                            "VideoToolbox callback failed with status \(status)"
                        ))
                    return
                }
                do {
                    continuation.resume(
                        returning: try Self.extract(
                            sample,
                            includeConfiguration: includeConfiguration
                        ))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            if status != noErr {
                continuation.resume(
                    throwing: SimViewError(
                        "H264_ENCODE_FAILED",
                        "VideoToolbox rejected a framebuffer with status \(status)"
                    ))
            }
        }
        guard let encoded else {
            throw SimViewError("H264_ENCODE_FAILED", "VideoToolbox rejected a framebuffer")
        }
        if encoded.configuration != nil { emittedConfiguration = true }
        return encoded
    }

    private func rebuild() throws {
        if let session { session.invalidate() }
        var candidate: VTCompressionSession?
        let specification =
            [
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!
            ] as CFDictionary
        var status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &candidate
        )
        if status != noErr || candidate == nil {
            status = VTCompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                width: width,
                height: height,
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: nil,
                imageBufferAttributes: nil,
                compressedDataAllocator: nil,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &candidate
            )
        }
        guard status == noErr, let candidate else {
            throw SimViewError("H264_UNAVAILABLE", "No VideoToolbox H.264 encoder is available")
        }
        let settings: [(CFString, CFTypeRef)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: 5_000_000)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: 60)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: 300)),
        ]
        for (key, value) in settings {
            let propertyStatus = VTSessionSetProperty(candidate, key: key, value: value)
            guard propertyStatus == noErr else {
                VTCompressionSessionInvalidate(candidate)
                throw SimViewError(
                    "H264_CONFIGURATION_FAILED",
                    "VideoToolbox rejected \(key) with status \(propertyStatus)"
                )
            }
        }
        let frameDelayStatus = VTSessionSetProperty(
            candidate,
            key: kVTCompressionPropertyKey_MaxFrameDelayCount,
            value: NSNumber(value: 1)
        )
        guard frameDelayStatus == noErr || frameDelayStatus == kVTPropertyNotSupportedErr else {
            VTCompressionSessionInvalidate(candidate)
            throw SimViewError(
                "H264_CONFIGURATION_FAILED",
                "VideoToolbox rejected MaxFrameDelayCount with status \(frameDelayStatus)"
            )
        }
        let preparationStatus = VTCompressionSessionPrepareToEncodeFrames(candidate)
        guard preparationStatus == noErr else {
            VTCompressionSessionInvalidate(candidate)
            throw SimViewError(
                "H264_CONFIGURATION_FAILED",
                "VideoToolbox preparation failed with status \(preparationStatus)"
            )
        }
        session = CompressionSessionBox(candidate)
        emittedConfiguration = false
        forceNextKeyframe = true
    }

    private static func extract(
        _ sample: CMSampleBuffer,
        includeConfiguration: Bool
    ) throws -> Encoded {
        let keyframe = !isNotSync(sample)
        guard let block = CMSampleBufferGetDataBuffer(sample) else {
            throw SimViewError("H264_ENCODE_FAILED", "Encoded sample has no bytes")
        }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0 else {
            throw SimViewError("H264_ENCODE_FAILED", "Encoded sample is empty")
        }
        var contiguousLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        let pointerStatus = CMBlockBufferGetDataPointer(
            block,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &contiguousLength,
            dataPointerOut: &pointer
        )
        var configuration: Data?
        if keyframe, includeConfiguration, let format = CMSampleBufferGetFormatDescription(sample) {
            configuration = avcC(format)
        }
        let bytes: Data
        if pointerStatus == noErr, let pointer, contiguousLength == length {
            bytes = Data(bytes: pointer, count: length)
        } else {
            var copied = Data(count: length)
            let copyStatus = copied.withUnsafeMutableBytes { destination in
                guard let baseAddress = destination.baseAddress else {
                    return kCMBlockBufferBadPointerParameterErr
                }
                return CMBlockBufferCopyDataBytes(
                    block,
                    atOffset: 0,
                    dataLength: length,
                    destination: baseAddress
                )
            }
            guard copyStatus == noErr else {
                throw SimViewError(
                    "H264_ENCODE_FAILED",
                    "Could not copy non-contiguous encoded bytes (status \(copyStatus))"
                )
            }
            bytes = copied
        }
        return Encoded(configuration: configuration, keyframe: keyframe, bytes: bytes)
    }

    private static func isNotSync(_ sample: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
            CFArrayGetCount(attachments) > 0,
            let pointer = CFArrayGetValueAtIndex(attachments, 0)
        else { return false }
        let dictionary = unsafeBitCast(pointer, to: CFDictionary.self)
        return CFDictionaryContainsKey(
            dictionary,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
        )
    }

    private static func avcC(_ format: CMFormatDescription) -> Data? {
        var spsPointer: UnsafePointer<UInt8>?
        var spsLength = 0
        var setCount = 0
        var headerLength: Int32 = 0
        guard
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format,
                parameterSetIndex: 0,
                parameterSetPointerOut: &spsPointer,
                parameterSetSizeOut: &spsLength,
                parameterSetCountOut: &setCount,
                nalUnitHeaderLengthOut: &headerLength
            ) == noErr, let spsPointer, spsLength >= 4
        else { return nil }
        var ppsPointer: UnsafePointer<UInt8>?
        var ppsLength = 0
        guard
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format,
                parameterSetIndex: 1,
                parameterSetPointerOut: &ppsPointer,
                parameterSetSizeOut: &ppsLength,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            ) == noErr, let ppsPointer
        else { return nil }
        let sps = UnsafeBufferPointer(start: spsPointer, count: spsLength)
        let pps = UnsafeBufferPointer(start: ppsPointer, count: ppsLength)
        var data = Data([1, sps[1], sps[2], sps[3], 0xff, 0xe1])
        data.append(UInt8((spsLength >> 8) & 0xff))
        data.append(UInt8(spsLength & 0xff))
        data.append(contentsOf: sps)
        data.append(1)
        data.append(UInt8((ppsLength >> 8) & 0xff))
        data.append(UInt8(ppsLength & 0xff))
        data.append(contentsOf: pps)
        return data
    }
}
