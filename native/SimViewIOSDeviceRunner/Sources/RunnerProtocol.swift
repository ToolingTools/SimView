import Foundation

enum RunnerProtocol {
    static let version = 1
    static let maximumRequestPayload = 4 * 1024 * 1024
    static let maximumResponsePayload = 64 * 1024 * 1024
}

enum RunnerFrameKind: UInt8 {
    case request = 0x01
    case response = 0x02
    case h264Configuration = 0x10
    case h264Frame = 0x11
}

struct RunnerFrame {
    let kind: RunnerFrameKind
    let payload: Data

    var encoded: Data {
        var data = Data([kind.rawValue])
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        data.append(payload)
        return data
    }
}

struct RunnerFrameDecoder {
    private(set) var buffer = Data()

    mutating func append(_ data: Data) throws -> [RunnerFrame] {
        buffer.append(data)
        var frames: [RunnerFrame] = []
        while buffer.count >= 5 {
            guard let kind = RunnerFrameKind(rawValue: buffer[buffer.startIndex]) else {
                throw RunnerError("PROTOCOL_FRAME_KIND", "Unknown runner frame kind", recoverable: false)
            }
            let length = buffer.subdata(in: 1..<5).withUnsafeBytes {
                $0.loadUnaligned(as: UInt32.self).bigEndian
            }
            guard length <= RunnerProtocol.maximumRequestPayload else {
                throw RunnerError(
                    "PROTOCOL_FRAME_TOO_LARGE",
                    "Runner request exceeds 4 MiB",
                    recoverable: false
                )
            }
            let end = 5 + Int(length)
            guard buffer.count >= end else { break }
            frames.append(RunnerFrame(kind: kind, payload: buffer.subdata(in: 5..<end)))
            buffer.removeSubrange(0..<end)
        }
        return frames
    }
}

struct RunnerRequest: Decodable {
    let id: String
    let protocolVersion: Int
    let method: String
    let params: [String: JSONValue]
}

enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

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

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
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

    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
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
}

extension Dictionary where Key == String, Value == JSONValue {
    var foundationObject: [String: Any] { mapValues(\.foundationObject) }
}

struct RunnerError: Error {
    let code: String
    let message: String
    let recoverable: Bool

    init(_ code: String, _ message: String, recoverable: Bool = true) {
        self.code = code
        self.message = message
        self.recoverable = recoverable
    }

    var dictionary: [String: Any] {
        ["code": code, "message": message, "recoverable": recoverable]
    }
}

func jsonData(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

extension Dictionary where Key == String, Value == JSONValue {
    func requiredString(_ key: String) throws -> String {
        guard let value = self[key]?.stringValue, !value.isEmpty else {
            throw RunnerError("PARAMETER_REQUIRED", "\(key) is required")
        }
        return value
    }

    func normalizedPoint(_ key: String) throws -> CGPoint {
        guard
            let object = self[key]?.objectValue,
            let x = object["x"]?.doubleValue,
            let y = object["y"]?.doubleValue,
            (0...1).contains(x),
            (0...1).contains(y)
        else {
            throw RunnerError("POINT_INVALID", "\(key) must contain normalized x and y values")
        }
        return CGPoint(x: x, y: y)
    }
}

func monotonicTimestampMicros() -> UInt64 {
    UInt64(ProcessInfo.processInfo.systemUptime * 1_000_000)
}

extension Data {
    mutating func appendBigEndian(_ value: UInt64) {
        var encoded = value.bigEndian
        Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
    }
}
