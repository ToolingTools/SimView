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
}
