import Foundation

enum DeviceHubOrientation {
    typealias CommandRunner = (
        _ executable: String, _ arguments: [String], _ timeout: TimeInterval?
    ) -> ProcessResult

    static let commandTimeout: TimeInterval = 10
    static let capabilityTimeout: TimeInterval = 2

    static func cliOrientation(for name: String) throws -> String {
        switch name {
        case "portrait": return "portrait"
        case "portrait-upside-down": return "portraitUpsideDown"
        // Keep the legacy interface-orientation convention; device orientation reverses landscape sides.
        case "landscape-right": return "landscapeLeft"
        case "landscape-left": return "landscapeRight"
        default:
            throw SimViewError("ORIENTATION_INVALID", "Unsupported orientation: \(name)")
        }
    }

    static func isSupported(
        developerDirectory: String = Xcode.developerDirectory(),
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        runCommand: CommandRunner = { executable, arguments, timeout in
            run(executable, arguments, timeout: timeout)
        }
    ) throws -> Bool {
        let executable = Xcode.devicectlPath(developerDirectory: developerDirectory)
        guard fileExists(executable) else { return false }
        let result = runCommand(
            executable,
            ["device", "orientation", "set", "--help"],
            capabilityTimeout
        )
        if result.status == 124 {
            throw SimViewError(
                "ORIENTATION_DEVICECTL_CAPABILITY_TIMEOUT",
                result.error.nonEmpty ?? "devicectl capability detection exceeded its deadline"
            )
        }
        if result.status != 0 {
            if isUnsupported(result.output + result.error) { return false }
            throw SimViewError(
                "ORIENTATION_DEVICECTL_CAPABILITY_FAILED",
                result.error.nonEmpty ?? "devicectl orientation capability detection failed"
            )
        }
        let help = result.output.lowercased()
        return help.contains("orientation") && help.contains("landscape")
    }

    static func setOrientation(
        udid: String,
        name: String,
        developerDirectory: String = Xcode.developerDirectory(),
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        runCommand: CommandRunner = { executable, arguments, timeout in
            run(executable, arguments, timeout: timeout)
        }
    ) throws -> Bool {
        let orientation = try cliOrientation(for: name)
        guard
            try isSupported(
                developerDirectory: developerDirectory,
                fileExists: fileExists,
                runCommand: runCommand
            )
        else { return false }
        let result = runCommand(
            Xcode.devicectlPath(developerDirectory: developerDirectory),
            [
                "--quiet", "--json-output", "-", "device", "orientation", "set",
                "--device", udid, orientation,
            ],
            commandTimeout
        )
        if result.status == 0 { return true }
        if result.status == 124 {
            throw SimViewError(
                "ORIENTATION_DEVICECTL_TIMEOUT",
                result.error.nonEmpty ?? "devicectl orientation exceeded its deadline",
                details: ["udid": udid]
            )
        }
        if isUnsupported(result.error) {
            return false
        }
        throw SimViewError(
            "ORIENTATION_DEVICECTL_FAILED",
            result.error.nonEmpty ?? "devicectl could not set device orientation",
            details: ["udid": udid]
        )
    }

    private static func isUnsupported(_ message: String) -> Bool {
        let value = message.lowercased()
        return value.contains("not supported")
            || value.contains("unsupported")
            || value.contains("unknown command")
            || value.contains("unrecognized command")
    }
}
