import Foundation

enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init?(_ value: Any) {
        switch value {
        case is NSNull:
            self = .null
        case let value as Bool:
            self = .bool(value)
        case let value as NSNumber:
            self = .number(value.doubleValue)
        case let value as String:
            self = .string(value)
        case let value as [Any]:
            let converted = value.compactMap(JSONValue.init)
            guard converted.count == value.count else { return nil }
            self = .array(converted)
        case let value as [String: Any]:
            var converted: [String: JSONValue] = [:]
            for (key, item) in value {
                guard let item = JSONValue(item) else { return nil }
                converted[key] = item
            }
            self = .object(converted)
        default:
            return nil
        }
    }

    var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case .bool(let value): value
        case .number(let value): value
        case .string(let value): value
        case .array(let value): value.map(\.foundationObject)
        case .object(let value): value.mapValues(\.foundationObject)
        }
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var doubleValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    var intValue: Int? {
        guard let value = doubleValue, value.rounded() == value else { return nil }
        return Int(exactly: value)
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

enum FrameKind: UInt8 {
    case request = 0x01
    case response = 0x02
    case h264Configuration = 0x10
    case h264Frame = 0x11
    case jpegFrame = 0x12
    case pngScreenshot = 0x20
    case preparedImage = 0x21
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

struct SimViewError: Error, Sendable {
    let code: String
    let message: String
    let recoverable: Bool
    let details: JSONValue?

    init(_ code: String, _ message: String, recoverable: Bool = true, details: Any? = nil) {
        self.code = code
        self.message = message
        self.recoverable = recoverable
        self.details = details.flatMap(JSONValue.init)
    }

    var dictionary: [String: Any] {
        var value: [String: Any] = [
            "code": code,
            "message": message,
            "recoverable": recoverable,
        ]
        if let details { value["details"] = details.foundationObject }
        return value
    }
}

struct Request: Decodable, Sendable {
    let id: String
    let protocolVersion: Int
    let method: String
    let params: [String: JSONValue]

    init(data: Data) throws {
        do {
            self = try JSONDecoder().decode(Request.self, from: data)
        } catch {
            throw SimViewError("PROTOCOL_INVALID_REQUEST", "Request is missing id, protocolVersion, or method")
        }
    }
}

extension Request {
    var deviceIdentifier: String? {
        params["deviceId"]?.stringValue ?? params["udid"]?.stringValue
    }
}

func jsonData(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}
