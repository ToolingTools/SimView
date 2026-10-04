import Foundation

enum DeviceHubPasteboard {
    typealias CommandRunner = (
        _ executable: String, _ arguments: [String], _ input: Data?, _ timeout: TimeInterval?
    ) -> ProcessResult

    static let commandTimeout: TimeInterval = 5
    static let capabilityTimeout: TimeInterval = 2

    static func isSupported(
        developerDirectory: String = Xcode.developerDirectory(),
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        runCommand: CommandRunner = { executable, arguments, input, timeout in
            run(executable, arguments, input: input, timeout: timeout)
        }
    ) throws -> Bool {
        let executable = Xcode.devicectlPath(developerDirectory: developerDirectory)
        guard fileExists(executable) else { return false }
        let result = runCommand(
            executable,
            ["device", "pasteboard", "copy", "--help"],
            nil,
            capabilityTimeout
        )
        if result.status == 124 {
            throw SimViewError(
                "PASTEBOARD_DEVICECTL_CAPABILITY_TIMEOUT",
                result.error.nonEmpty ?? "devicectl pasteboard capability detection exceeded its deadline"
            )
        }
        if result.status != 0 {
            if isUnsupported(result.output + result.error) { return false }
            throw SimViewError(
                "PASTEBOARD_DEVICECTL_CAPABILITY_FAILED",
                result.error.nonEmpty ?? "devicectl pasteboard capability detection failed"
            )
        }
        let help = (result.output + result.error).lowercased()
        return help.contains("usage: devicectl device pasteboard copy")
            && help.contains("reads data from stdin")
    }

    static func copy(
        udid: String,
        text: String,
        developerDirectory: String = Xcode.developerDirectory(),
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        runCommand: CommandRunner = { executable, arguments, input, timeout in
            run(executable, arguments, input: input, timeout: timeout)
        }
    ) throws -> Bool {
        guard
            try isSupported(
                developerDirectory: developerDirectory,
                fileExists: fileExists,
                runCommand: runCommand
            )
        else { return false }
        let executable = Xcode.devicectlPath(developerDirectory: developerDirectory)
        let result = runCommand(
            executable,
            [
                "device", "pasteboard", "copy", "--device", udid,
                "--quiet", "--timeout", "5",
            ],
            Data(text.utf8),
            commandTimeout
        )
        if result.status == 0 { return true }
        if result.status == 124 {
            throw SimViewError(
                "PASTEBOARD_DEVICECTL_TIMEOUT",
                result.error.nonEmpty ?? "devicectl pasteboard copy exceeded its deadline",
                details: ["udid": udid]
            )
        }
        if isUnsupported(result.output + result.error) { return false }
        throw SimViewError(
            "PASTEBOARD_DEVICECTL_FAILED",
            result.error.nonEmpty ?? "devicectl could not set the simulator pasteboard",
            details: ["udid": udid]
        )
    }

    private static func isUnsupported(_ message: String) -> Bool {
        let value = message.lowercased()
        return value.contains("not supported")
            || value.contains("unsupported")
            || value.contains("unknown command")
            || value.contains("unrecognized command")
            || value.contains("no such command")
    }
}
