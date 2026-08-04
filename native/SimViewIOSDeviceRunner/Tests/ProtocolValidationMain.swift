import Foundation

private struct ValidationFailure: Error, CustomStringConvertible {
    let description: String
}

@main
struct ProtocolValidationMain {
    static func main() throws {
        try validatesSplitFrames()
        try rejectsOversizedFrames()
        try validatesNormalizedPoints()
        print("Runner protocol validation passed")
    }

    private static func validatesSplitFrames() throws {
        let original = RunnerFrame(kind: .request, payload: Data("{}".utf8))
        var decoder = RunnerFrameDecoder()
        guard try decoder.append(Data(original.encoded.prefix(3))).isEmpty else {
            throw ValidationFailure(description: "Partial frame decoded before completion")
        }
        let frames = try decoder.append(Data(original.encoded.dropFirst(3)))
        guard
            frames.count == 1,
            frames[0].kind == .request,
            frames[0].payload == original.payload
        else {
            throw ValidationFailure(description: "Split runner frame did not round-trip")
        }
    }

    private static func rejectsOversizedFrames() throws {
        var encoded = Data([RunnerFrameKind.request.rawValue])
        var length = UInt32(RunnerProtocol.maximumRequestPayload + 1).bigEndian
        withUnsafeBytes(of: &length) { encoded.append(contentsOf: $0) }
        var decoder = RunnerFrameDecoder()
        do {
            _ = try decoder.append(encoded)
            throw ValidationFailure(description: "Oversized runner frame was accepted")
        } catch let error as RunnerError {
            guard error.code == "PROTOCOL_FRAME_TOO_LARGE" else { throw error }
        }
    }

    private static func validatesNormalizedPoints() throws {
        let valid: [String: JSONValue] = [
            "point": .object(["x": .number(0.25), "y": .number(0.75)])
        ]
        let point = try valid.normalizedPoint("point")
        guard point.x == 0.25, point.y == 0.75 else {
            throw ValidationFailure(description: "Valid normalized point changed")
        }
        let invalid: [String: JSONValue] = [
            "point": .object(["x": .number(1.1), "y": .number(0.5)])
        ]
        do {
            _ = try invalid.normalizedPoint("point")
            throw ValidationFailure(description: "Out-of-range normalized point was accepted")
        } catch is RunnerError {
            // Expected.
        }
    }
}
