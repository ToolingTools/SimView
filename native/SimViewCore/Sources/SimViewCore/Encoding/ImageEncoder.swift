import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

enum ImageEncoder {
    static func encode(_ pixelBuffer: CVPixelBuffer, type: String, quality: CGFloat = 0.76) throws -> Data {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard
            let base = CVPixelBufferGetBaseAddress(pixelBuffer),
            let context = CGContext(
                data: base,
                width: CVPixelBufferGetWidth(pixelBuffer),
                height: CVPixelBufferGetHeight(pixelBuffer),
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue
                    | CGImageAlphaInfo.premultipliedFirst.rawValue
            ),
            let image = context.makeImage()
        else {
            throw SimViewError("IMAGE_ENCODE_FAILED", "Could not create an image from the framebuffer")
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type as CFString, 1, nil) else {
            throw SimViewError("IMAGE_ENCODE_FAILED", "Could not create an image destination")
        }
        let options: CFDictionary =
            type == "public.jpeg"
            ? [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
            : [:] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else {
            throw SimViewError("IMAGE_ENCODE_FAILED", "Image encoding did not finalize")
        }
        return data as Data
    }

    static func preparedJPEG(
        _ pixelBuffer: CVPixelBuffer,
        maximumLongEdge: Int = 1_024,
        quality: CGFloat = 0.72
    ) throws -> (data: Data, width: Int, height: Int) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
        let scale = min(1, CGFloat(maximumLongEdge) / CGFloat(max(sourceWidth, sourceHeight)))
        let width = max(1, Int((CGFloat(sourceWidth) * scale).rounded()))
        let height = max(1, Int((CGFloat(sourceHeight) * scale).rounded()))
        guard
            let base = CVPixelBufferGetBaseAddress(pixelBuffer),
            let sourceContext = CGContext(
                data: base,
                width: sourceWidth,
                height: sourceHeight,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue
                    | CGImageAlphaInfo.premultipliedFirst.rawValue
            ),
            let sourceImage = sourceContext.makeImage(),
            let destination = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else {
            throw SimViewError("IMAGE_ENCODE_FAILED", "Could not prepare the observation image")
        }
        destination.interpolationQuality = .medium
        destination.draw(sourceImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = destination.makeImage() else {
            throw SimViewError("IMAGE_ENCODE_FAILED", "Could not resize the observation image")
        }
        let data = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)
        else {
            throw SimViewError("IMAGE_ENCODE_FAILED", "Could not create the observation encoder")
        }
        CGImageDestinationAddImage(
            encoder,
            image,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(encoder) else {
            throw SimViewError("IMAGE_ENCODE_FAILED", "Observation image encoding did not finalize")
        }
        return (data as Data, width, height)
    }
}
