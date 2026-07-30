import Foundation
import CoreVideo
import CoreMedia
import VideoToolbox

actor H264Encoder {
    struct Encoded {
        let configuration: Data?
        let keyframe: Bool
        let bytes: Data
    }

    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var frameCount: Int64 = 0
    private var emittedConfiguration = false
    private var forceNextKeyframe = true

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
    }

    func forceKeyframe() {
        forceNextKeyframe = true
    }

    func stop() {
        if let session {
            VTCompressionSessionInvalidate(session)
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
        guard let session else {
            throw SimViewError("H264_UNAVAILABLE", "VideoToolbox could not create an H.264 session")
        }
        frameCount += 1
        let shouldForce = forceNextKeyframe
        forceNextKeyframe = false
        let properties: NSDictionary? = shouldForce
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as NSDictionary
            : nil
        let sample: CMSampleBuffer? = await withCheckedContinuation { continuation in
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: source,
                presentationTimeStamp: CMTime(value: frameCount, timescale: 60),
                duration: .invalid,
                frameProperties: properties,
                infoFlagsOut: nil
            ) { status, _, sample in
                continuation.resume(returning: status == noErr ? sample : nil)
            }
            if status != noErr { continuation.resume(returning: nil) }
        }
        guard let sample else {
            throw SimViewError("H264_ENCODE_FAILED", "VideoToolbox rejected a framebuffer")
        }
        return try extract(sample)
    }

    private func rebuild() throws {
        if let session { VTCompressionSessionInvalidate(session) }
        var candidate: VTCompressionSession?
        let specification = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
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
            (kVTCompressionPropertyKey_MaxFrameDelayCount, NSNumber(value: 1)),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: 5_000_000)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: 60)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: 300)),
        ]
        for (key, value) in settings {
            VTSessionSetProperty(candidate, key: key, value: value)
        }
        VTCompressionSessionPrepareToEncodeFrames(candidate)
        session = candidate
        emittedConfiguration = false
        forceNextKeyframe = true
    }

    private func extract(_ sample: CMSampleBuffer) throws -> Encoded {
        let keyframe = !isNotSync(sample)
        guard let block = CMSampleBufferGetDataBuffer(sample) else {
            throw SimViewError("H264_ENCODE_FAILED", "Encoded sample has no bytes")
        }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            block,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &length,
            dataPointerOut: &pointer
        ) == noErr, let pointer else {
            throw SimViewError("H264_ENCODE_FAILED", "Encoded sample is not contiguous")
        }
        var configuration: Data?
        if keyframe, !emittedConfiguration, let format = CMSampleBufferGetFormatDescription(sample) {
            configuration = avcC(format)
            emittedConfiguration = configuration == nil ? false : true
        }
        return Encoded(configuration: configuration, keyframe: keyframe, bytes: Data(bytes: pointer, count: length))
    }

    private func isNotSync(_ sample: CMSampleBuffer) -> Bool {
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

    private func avcC(_ format: CMFormatDescription) -> Data? {
        var spsPointer: UnsafePointer<UInt8>?
        var spsLength = 0
        var setCount = 0
        var headerLength: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 0,
            parameterSetPointerOut: &spsPointer,
            parameterSetSizeOut: &spsLength,
            parameterSetCountOut: &setCount,
            nalUnitHeaderLengthOut: &headerLength
        ) == noErr, let spsPointer, spsLength >= 4 else { return nil }
        var ppsPointer: UnsafePointer<UInt8>?
        var ppsLength = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPointer,
            parameterSetSizeOut: &ppsLength,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPointer else { return nil }
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
