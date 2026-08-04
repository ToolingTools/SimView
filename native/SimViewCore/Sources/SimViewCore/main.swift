import Darwin
import Foundation

struct Arguments {
    let command: String
    let values: [String: String]
    let flags: Set<String>

    init(_ arguments: [String]) {
        command = arguments.dropFirst().first ?? "help"
        var values: [String: String] = [:]
        var flags = Set<String>()
        var index = 2
        while index < arguments.count {
            let key = arguments[index]
            if key.hasPrefix("--"), index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") {
                values[key] = arguments[index + 1]
                index += 2
            } else {
                flags.insert(key)
                index += 1
            }
        }
        self.values = values
        self.flags = flags
    }
}

let arguments = Arguments(CommandLine.arguments)

do {
    switch arguments.command {
    case "serve":
        guard let socket = arguments.values["--socket"] else {
            throw SimViewError("ARGUMENT_REQUIRED", "--socket is required", recoverable: false)
        }
        guard let tokenFDValue = arguments.values["--token-fd"], let tokenFD = Int32(tokenFDValue) else {
            throw SimViewError("ARGUMENT_REQUIRED", "--token-fd is required", recoverable: false)
        }
        let tokenHandle = FileHandle(fileDescriptor: tokenFD, closeOnDealloc: false)
        let token = String(data: tokenHandle.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard token.utf8.count >= 32 else {
            throw SimViewError("TOKEN_INVALID", "The session token must contain at least 32 bytes", recoverable: false)
        }
        let server = SimViewServer(
            socketPath: socket,
            token: token,
            preferredDeviceID: arguments.values["--device-id"] ?? arguments.values["--udid"],
            instanceID: arguments.values["--instance-id"],
            parentPID: arguments.values["--parent-pid"].flatMap(pid_t.init),
            idleTimeout: arguments.values["--idle-timeout"].flatMap(TimeInterval.init) ?? 60
        )
        try server.run()
    case "doctor":
        print(String(data: try jsonData(Diagnostics.report()), encoding: .utf8)!)
    case "devices":
        print(String(data: try jsonData(try DeviceRuntime.devices().map(\.dictionary)), encoding: .utf8)!)
    case "screenshot":
        guard let output = arguments.values["--output"] else {
            throw SimViewError("ARGUMENT_REQUIRED", "--output is required", recoverable: false)
        }
        let requested = arguments.values["--device-id"] ?? arguments.values["--udid"]
        let device = try DeviceRuntime.select(requested: requested, configured: nil)
        if device.platform == .android {
            let client = try ADBClient()
            let capture = AndroidFrameCapture(client: client, serial: device.nativeIdentifier)
            try capture.screenshot().write(to: URL(fileURLWithPath: output))
        } else {
            let semaphore = DispatchSemaphore(value: 0)
            let capture = FrameCapture()
            let failure = ErrorBox()
            try capture.start(udid: device.nativeIdentifier) { frame, _, _ in
                do {
                    try ImageEncoder.encode(frame, type: "public.png").write(to: URL(fileURLWithPath: output))
                } catch {
                    failure.set(error)
                }
                semaphore.signal()
            }
            if semaphore.wait(timeout: .now() + 10) == .timedOut {
                throw SimViewError("CAPTURE_TIMEOUT", "No framebuffer arrived within 10 seconds")
            }
            capture.stop()
            if let error = failure.get() { throw error }
        }
        print(String(data: try jsonData(["output": output, "deviceId": device.id]), encoding: .utf8)!)
    default:
        print(
            """
            simview-core \(SimViewVersion.current)

            Commands:
              serve --socket <path> --token-fd <fd> [--device-id <id>] [--udid <ios-udid>]
              doctor
              devices
              screenshot --output <path> [--device-id <id>] [--udid <ios-udid>]
            """)
    }
} catch {
    let value = (error as? SimViewError) ?? SimViewError("INTERNAL_ERROR", error.localizedDescription)
    fputs(String(data: (try? jsonData(["error": value.dictionary])) ?? Data(), encoding: .utf8)! + "\n", stderr)
    exit(1)
}

private final class ErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Error?

    func set(_ error: Error) {
        lock.lock()
        value = error
        lock.unlock()
    }

    func get() -> Error? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
