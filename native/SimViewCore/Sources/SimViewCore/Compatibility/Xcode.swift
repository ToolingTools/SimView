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
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

struct ProcessResult: Sendable {
    let status: Int32
    let output: String
    let error: String
}

@discardableResult
func run(
    _ executable: String,
    _ arguments: [String],
    input: Data? = nil,
    environment: [String: String]? = nil
) -> ProcessResult {
    let process = Process()
    let output = Pipe()
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
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(data: data, encoding: .utf8) ?? ""
    return ProcessResult(
        status: process.terminationStatus,
        output: process.terminationStatus == 0 ? text : "",
        error: process.terminationStatus == 0 ? "" : text
    )
}
