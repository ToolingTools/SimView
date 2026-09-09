import Darwin
import Foundation

enum Xcode {
    static func developerDirectory() -> String {
        if let explicit = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !explicit.isEmpty {
            return explicit
        }
        return run("/usr/bin/xcode-select", ["-p"]).output
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty ?? "/Applications/Xcode.app/Contents/Developer"
    }

    static func frameworkCandidates() -> [String] {
        let developer = developerDirectory()
        return [
            "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
            "\(developer)/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
            "\(developer)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit",
            "\(developer)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        ]
    }

    @discardableResult
    static func loadFrameworks() -> [String: Bool] {
        Dictionary(
            uniqueKeysWithValues: frameworkCandidates().map { path in
                (path, dlopen(path, RTLD_NOW | RTLD_GLOBAL) != nil)
            })
    }

    static func symbolAvailable(_ name: String) -> Bool {
        dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) != nil
    }

    static func object(udid: String) -> NSObject? {
        loadFrameworks()
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let shared = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard
            let context = contextClass.perform(shared, with: developerDirectory(), with: nil)?
                .takeUnretainedValue() as? NSObject,
            let deviceSet = context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?
                .takeUnretainedValue() as? NSObject,
            let devices = deviceSet.value(forKey: "devices") as? [NSObject]
        else { return nil }
        return devices.first {
            ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid
        }
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

struct ProcessResult {
    let status: Int32
    let output: String
    let error: String
}

private func stopCommand(_ process: Process) {
    if process.isRunning {
        process.terminate()
        let grace = ProcessInfo.processInfo.systemUptime + 0.25
        while process.isRunning, ProcessInfo.processInfo.systemUptime < grace {
            Thread.sleep(forTimeInterval: 0.01)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            let reapDeadline = ProcessInfo.processInfo.systemUptime + 0.25
            while process.isRunning, ProcessInfo.processInfo.systemUptime < reapDeadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
    }
    // Do not turn a command deadline into an unbounded wait on a child that
    // has not exited after receiving SIGKILL.
    if !process.isRunning { process.waitUntilExit() }
}

@discardableResult
func run(
    _ executable: String,
    _ arguments: [String],
    input: Data? = nil,
    environment: [String: String]? = nil,
    timeout: TimeInterval? = nil
) -> ProcessResult {
    let process = Process()
    let output = Pipe()
    defer { try? output.fileHandleForReading.close() }
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if let environment {
        process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
    }
    process.standardOutput = output
    process.standardError = output
    if let input {
        let stdin = Pipe()
        stdin.fileHandleForWriting.write(input)
        stdin.fileHandleForWriting.closeFile()
        process.standardInput = stdin
    }
    do {
        try process.run()
    } catch {
        return ProcessResult(status: -1, output: "", error: error.localizedDescription)
    }
    // Drain while the process is running. `simctl list --json` can exceed a
    // pipe buffer on machines with many runtimes, so waiting first deadlocks.
    let data: Data
    if let timeout {
        let descriptor = output.fileHandleForReading.fileDescriptor
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
            stopCommand(process)
            return ProcessResult(status: -1, output: "", error: "Unable to read command output")
        }
        let deadline = ProcessInfo.processInfo.systemUptime + max(0.1, timeout)
        var collected = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count > 0 { collected.append(contentsOf: buffer.prefix(count)) }
            if count == 0 && !process.isRunning { break }
            if ProcessInfo.processInfo.systemUptime >= deadline {
                stopCommand(process)
                return ProcessResult(status: 124, output: "", error: "Command exceeded its deadline")
            }
            if count <= 0 { Thread.sleep(forTimeInterval: 0.01) }
        }
        data = collected
    } else {
        data = output.fileHandleForReading.readDataToEndOfFile()
    }
    process.waitUntilExit()
    let text = String(data: data, encoding: .utf8) ?? ""
    return ProcessResult(
        status: process.terminationStatus,
        output: process.terminationStatus == 0 ? text : "",
        error: process.terminationStatus == 0 ? "" : text
    )
}
