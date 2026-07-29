import Foundation

enum FrameKind: UInt8 {
    case request = 0x01
    case response = 0x02
    case h264Configuration = 0x10
    case h264Frame = 0x11
    case jpegFrame = 0x12
    case pngScreenshot = 0x20
}

struct WireFrame {
    let kind: FrameKind
    let payload: Data

    var encoded: Data {
        var result = Data([kind.rawValue])
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { result.append(contentsOf: $0) }
        result.append(payload)
        return result
    }
}

struct FrameDecoder {
    private(set) var buffer = Data()
    static let maximumPayload = 64 * 1024 * 1024

    mutating func append(_ data: Data) throws -> [WireFrame] {
        buffer.append(data)
        var frames: [WireFrame] = []
        while buffer.count >= 5 {
            guard let kind = FrameKind(rawValue: buffer[buffer.startIndex]) else {
                throw SimViewError("PROTOCOL_FRAME_KIND", "Unknown frame kind", recoverable: false)
            }
            let lengthData = buffer.subdata(in: 1..<5)
            let length = lengthData.withUnsafeBytes { raw in
                raw.loadUnaligned(as: UInt32.self).bigEndian
            }
            guard length <= Self.maximumPayload else {
                throw SimViewError("PROTOCOL_FRAME_TOO_LARGE", "Frame exceeds 64 MiB", recoverable: false)
            }
            let end = 5 + Int(length)
            guard buffer.count >= end else { break }
            frames.append(WireFrame(kind: kind, payload: buffer.subdata(in: 5..<end)))
            buffer.removeSubrange(0..<end)
        }
        return frames
    }
}

struct SimViewError: Error {
    let code: String
    let message: String
    let recoverable: Bool
    let details: Any?

    init(_ code: String, _ message: String, recoverable: Bool = true, details: Any? = nil) {
        self.code = code
        self.message = message
        self.recoverable = recoverable
        self.details = details
    }

    var dictionary: [String: Any] {
        var value: [String: Any] = [
            "code": code,
            "message": message,
            "recoverable": recoverable,
        ]
        if let details { value["details"] = details }
        return value
    }
}

struct Request {
    let id: String
    let protocolVersion: Int
    let method: String
    let params: [String: Any]

    init(data: Data) throws {
        guard
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["id"] as? String,
            let protocolVersion = object["protocolVersion"] as? Int,
            let method = object["method"] as? String
        else {
            throw SimViewError("PROTOCOL_INVALID_REQUEST", "Request is missing id, protocolVersion, or method")
        }
        self.id = id
        self.protocolVersion = protocolVersion
        self.method = method
        self.params = object["params"] as? [String: Any] ?? [:]
    }
}

func jsonData(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

