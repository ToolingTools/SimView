import Darwin
import Foundation

final class AndroidAgentLifecycle: @unchecked Sendable {
    static let protocolVersion = 4

    let client: ADBClient
    let serial: String
    let remotePath: String
    let socketName: String
    private(set) var process: Process?
    private(set) var forwardedPort: Int?
    private var inputPipe: Pipe?
    private var errorPipe: Pipe?
    private let diagnosticsLock = NSLock()
    private var diagnostics = Data()

    var lastDiagnostics: String? {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return String(data: diagnostics, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    init(client: ADBClient, serial: String) {
        self.client = client
        self.serial = serial
        let nonce = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        remotePath = "/data/local/tmp/simview-agent-\(nonce).jar"
        socketName = "simview_\(nonce)"
    }

    deinit { stop() }

    static func packagedAgentURL(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL? {
        var candidates: [URL] = []
        if let explicit = environment["SIMVIEW_ANDROID_AGENT_PATH"], !explicit.isEmpty {
            candidates.append(URL(fileURLWithPath: explicit))
        }
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardized
        candidates.append(executable.deletingLastPathComponent().appendingPathComponent("simview-android-agent.jar"))
        candidates.append(
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent("native/SimViewAndroid/build/simview-android-agent.jar")
        )
        return candidates.first { FileManager.default.isReadableFile(atPath: $0.path) }
    }

    func prepare(agentURL: URL) throws {
        _ = try client.require(["push", agentURL.path, remotePath], serial: serial, timeout: 30)
        _ = try client.require(["shell", "chmod", "600", remotePath], serial: serial)
    }

    func start(token: String) throws -> Int {
        guard token.utf8.count >= 32 else {
            throw SimViewError("TOKEN_INVALID", "The Android agent token must contain at least 32 bytes")
        }
        let forwarding = try client.require(
            ["forward", "tcp:0", "localabstract:\(socketName)"],
            serial: serial
        )
        guard let port = Int(forwarding.text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw SimViewError("ADB_FORWARD_FAILED", "ADB did not return an allocated forwarding port")
        }
        forwardedPort = port

        let process = Process()
        let stdin = Pipe()
        let stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: client.executable)
        process.arguments = [
            "-s", serial, "shell", "CLASSPATH=\(remotePath)", "app_process", "/",
            "dev.simview.agent.Main", "--socket", socketName,
        ]
        process.standardInput = stdin
        process.standardOutput = FileHandle.nullDevice
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            cleanupForward()
            throw SimViewError("ANDROID_AGENT_LAUNCH_FAILED", error.localizedDescription)
        }
        stdin.fileHandleForWriting.write(Data(token.utf8))
        stdin.fileHandleForWriting.write(Data([0x0A]))
        self.process = process
        inputPipe = stdin
        errorPipe = stderr
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                self?.appendDiagnostics(data)
            }
        }
        return port
    }

    func stop() {
        inputPipe?.fileHandleForWriting.closeFile()
        inputPipe = nil
        if let process, process.isRunning {
            let gracefulDeadline = Date().addingTimeInterval(0.25)
            while process.isRunning, Date() < gracefulDeadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
        if let process, process.isRunning {
            process.terminate()
            let terminationDeadline = Date().addingTimeInterval(1)
            while process.isRunning, Date() < terminationDeadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
        process = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        if let trailing = try? errorPipe?.fileHandleForReading.readToEnd() {
            appendDiagnostics(trailing)
        }
        errorPipe = nil
        cleanupForward()
        _ = try? client.execute(["shell", "rm", "-f", remotePath], serial: serial, timeout: 5)
    }

    private func appendDiagnostics(_ data: Data) {
        diagnosticsLock.lock()
        let remaining = max(0, 64 * 1024 - diagnostics.count)
        if remaining > 0 { diagnostics.append(data.prefix(remaining)) }
        diagnosticsLock.unlock()
    }

    private func cleanupForward() {
        if let forwardedPort {
            _ = try? client.execute(["forward", "--remove", "tcp:\(forwardedPort)"], serial: serial, timeout: 5)
        }
        forwardedPort = nil
    }
}
