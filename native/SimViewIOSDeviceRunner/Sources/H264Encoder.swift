import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import UIKit
import VideoToolbox

final class H264Encoder {
    struct Encoded {
        let configuration: Data?
        let keyframe: Bool
        let bytes: Data
    }

    private final class PendingFrame {
        let completion: (Result<Encoded, Error>) -> Void

        init(completion: @escaping (Result<Encoded, Error>) -> Void) {
            self.completion = completion
        }
    }

    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var frameCount: Int64 = 0
    private var emittedConfiguration = false
    private var forceNextKeyframe = true
    private var bitrate = 5_000_000
    private var expectedFrameRate = 60

    func configure(bitrate: Int, frameRate: Int) {
        self.bitrate = min(max(bitrate, 500_000), 20_000_000)
        expectedFrameRate = min(max(frameRate, 1), 60)
    }

    func forceKeyframe() {
        forceNextKeyframe = true
    }

    func stop() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        emittedConfiguration = false
        forceNextKeyframe = true
    }

    func encode(
        _ source: CVPixelBuffer,
        completion: @escaping (Result<Encoded, Error>) -> Void
    ) throws {
        let nextWidth = Int32(CVPixelBufferGetWidth(source))
        let nextHeight = Int32(CVPixelBufferGetHeight(source))
        if session == nil || width != nextWidth || height != nextHeight {
            width = nextWidth
            height = nextHeight
            try rebuild()
        }
        guard let session else {
            throw RunnerError("H264_UNAVAILABLE", "VideoToolbox encoder is unavailable")
        }

        frameCount += 1
        let force = forceNextKeyframe
        forceNextKeyframe = false
        let properties: CFDictionary? =
            force
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue as Any] as CFDictionary
            : nil
        let pending = Unmanaged.passRetained(PendingFrame(completion: completion))
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: source,
            presentationTimeStamp: CMTime(value: frameCount, timescale: Int32(expectedFrameRate)),
            duration: CMTime(value: 1, timescale: Int32(expectedFrameRate)),
            frameProperties: properties,
            sourceFrameRefcon: pending.toOpaque(),
            infoFlagsOut: nil
        )
        if status != noErr {
            pending.release()
            throw RunnerError(
                "H264_ENCODE_FAILED",
                "VideoToolbox rejected a frame with status \(status)"
            )
        }
    }

    private func rebuild() throws {
        stop()
        var candidate: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue as Any
            ] as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: Self.outputCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &candidate
        )
        guard status == noErr, let candidate else {
            throw RunnerError("H264_UNAVAILABLE", "No VideoToolbox H.264 encoder is available")
        }

        let settings: [(CFString, CFTypeRef)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: expectedFrameRate)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: expectedFrameRate * 5)),
        ]
        for (key, value) in settings {
            let propertyStatus = VTSessionSetProperty(candidate, key: key, value: value)
            guard propertyStatus == noErr else {
                VTCompressionSessionInvalidate(candidate)
                throw RunnerError(
                    "H264_CONFIGURATION_FAILED",
                    "VideoToolbox rejected \(key) with status \(propertyStatus)"
                )
            }
        }
        let delayStatus = VTSessionSetProperty(
            candidate,
            key: kVTCompressionPropertyKey_MaxFrameDelayCount,
            value: NSNumber(value: 1)
        )
        guard delayStatus == noErr || delayStatus == kVTPropertyNotSupportedErr else {
            VTCompressionSessionInvalidate(candidate)
            throw RunnerError(
                "H264_CONFIGURATION_FAILED",
                "VideoToolbox rejected MaxFrameDelayCount with status \(delayStatus)"
            )
        }
        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(candidate)
        guard prepareStatus == noErr else {
            VTCompressionSessionInvalidate(candidate)
            throw RunnerError(
                "H264_CONFIGURATION_FAILED",
                "VideoToolbox preparation failed with status \(prepareStatus)"
            )
        }
        session = candidate
        emittedConfiguration = false
        forceNextKeyframe = true
    }

    private static let outputCallback: VTCompressionOutputCallback = {
        outputCallbackRefcon,
        sourceFrameRefcon,
        status,
        _,
        sampleBuffer in
        guard let sourceFrameRefcon else { return }
        let pending = Unmanaged<PendingFrame>.fromOpaque(sourceFrameRefcon).takeRetainedValue()
        guard status == noErr, let sampleBuffer else {
            pending.completion(
                .failure(
                    RunnerError(
                        "H264_ENCODE_FAILED",
                        "VideoToolbox callback failed with status \(status)"
                    )
                )
            )
            return
        }
        guard let outputCallbackRefcon else {
            pending.completion(.failure(RunnerError("H264_ENCODE_FAILED", "Encoder was released")))
            return
        }
        let encoder = Unmanaged<H264Encoder>.fromOpaque(outputCallbackRefcon).takeUnretainedValue()
        do {
            let includeConfiguration = !encoder.emittedConfiguration
            let encoded = try extract(sampleBuffer, includeConfiguration: includeConfiguration)
            if encoded.configuration != nil {
                encoder.emittedConfiguration = true
            }
            pending.completion(.success(encoded))
        } catch {
            pending.completion(.failure(error))
        }
    }

    private static func extract(
        _ sample: CMSampleBuffer,
        includeConfiguration: Bool
    ) throws -> Encoded {
        let keyframe = !isNotSync(sample)
        guard let block = CMSampleBufferGetDataBuffer(sample) else {
            throw RunnerError("H264_ENCODE_FAILED", "Encoded sample has no bytes")
        }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0 else {
            throw RunnerError("H264_ENCODE_FAILED", "Encoded sample is empty")
        }
        var bytes = Data(count: length)
        let copyStatus = bytes.withUnsafeMutableBytes { destination in
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
            throw RunnerError(
                "H264_ENCODE_FAILED",
                "Could not copy encoded bytes (status \(copyStatus))"
            )
        }
        var configuration: Data?
        if keyframe,
            includeConfiguration,
            let format = CMSampleBufferGetFormatDescription(sample)
        {
            configuration = avcC(format)
        }
        return Encoded(configuration: configuration, keyframe: keyframe, bytes: bytes)
    }

    private static func isNotSync(_ sample: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sample,
                createIfNecessary: false
            ),
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
            ) == noErr,
            let spsPointer,
            spsLength >= 4
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
            ) == noErr,
            let ppsPointer
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

enum PixelBufferFactory {
    static func make(from image: UIImage, maximumLongEdge: Int) throws -> CVPixelBuffer {
        guard let source = image.cgImage else {
            throw RunnerError("IMAGE_DECODE_FAILED", "Screenshot has no CGImage")
        }
        let sourceWidth = source.width
        let sourceHeight = source.height
        let longEdge = max(sourceWidth, sourceHeight)
        let scale =
            longEdge > maximumLongEdge
            ? CGFloat(maximumLongEdge) / CGFloat(longEdge)
            : 1
        let width = max(2, Int((CGFloat(sourceWidth) * scale).rounded()) & ~1)
        let height = max(2, Int((CGFloat(sourceHeight) * scale).rounded()) & ~1)

        var candidate: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferCGImageCompatibilityKey: kCFBooleanTrue as Any,
                kCVPixelBufferCGBitmapContextCompatibilityKey: kCFBooleanTrue as Any,
            ] as CFDictionary,
            &candidate
        )
        guard status == kCVReturnSuccess, let candidate else {
            throw RunnerError("PIXEL_BUFFER_FAILED", "Could not allocate preview pixel buffer")
        }
        CVPixelBufferLockBaseAddress(candidate, [])
        defer { CVPixelBufferUnlockBaseAddress(candidate, []) }
        guard
            let baseAddress = CVPixelBufferGetBaseAddress(candidate),
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(
                data: baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(candidate),
                space: colorSpace,
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue
                    | CGImageAlphaInfo.premultipliedFirst.rawValue
            )
        else {
            throw RunnerError("PIXEL_BUFFER_FAILED", "Could not create preview bitmap context")
        }
        context.interpolationQuality = .medium
        context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        return candidate
    }
}
