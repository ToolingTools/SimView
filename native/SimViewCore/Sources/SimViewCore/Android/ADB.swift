import Foundation

struct ADBResult: Sendable {
    let status: Int32
    let output: Data
    let error: String

    var text: String { String(data: output, encoding: .utf8) ?? "" }
}

private final class ADBOutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Data()
    private var exceeded = false

    func append(_ data: Data, maximum: Int) {
        lock.lock()
        let remaining = max(0, maximum + 1 - value.count)
        if remaining > 0 { value.append(data.prefix(remaining)) }
        if data.count > remaining || value.count > maximum { exceeded = true }
        lock.unlock()
    }

    func get() -> (data: Data, exceeded: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (value, exceeded)
    }
}

struct ADBDeviceRecord: Equatable, Sendable {
    let serial: String
    let state: String
    let attributes: [String: String]
}

enum ADBResolver {
    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> String? {
        var candidates: [String] = []
        if let explicit = environment["SIMVIEW_ADB_PATH"], !explicit.isEmpty {
            candidates.append(explicit)
        }
        for rootName in ["ANDROID_SDK_ROOT", "ANDROID_HOME"] {
            if let root = environment[rootName], !root.isEmpty {
                candidates.append(URL(fileURLWithPath: root).appendingPathComponent("platform-tools/adb").path)
            }
        }
        if let path = environment["PATH"] {
            candidates.append(
                contentsOf: path.split(separator: ":").map {
                    URL(fileURLWithPath: String($0)).appendingPathComponent("adb").path
                })
        }
        candidates.append(
            URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Android/sdk/platform-tools/adb").path
        )
        return candidates.first { fileManager.isExecutableFile(atPath: $0) }
    }
}

final class ADBClient: @unchecked Sendable {
    let executable: String

    init(executable: String? = ADBResolver.resolve()) throws {
        guard let executable else {
            throw SimViewError(
                "ADB_NOT_FOUND",
                "Android SDK Platform Tools were not found",
                details: [
                    "action": "Install Android SDK Platform Tools or set SIMVIEW_ADB_PATH."
                ]
            )
        }
        self.executable = executable
    }

    func execute(
        _ arguments: [String],
        serial: String? = nil,
        input: Data? = nil,
        maximumOutput: Int = 64 * 1024 * 1024,
        timeout: TimeInterval = 15,
        cancelled: @Sendable () -> Bool = { false }
    ) throws -> ADBResult {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = serial.map { ["-s", $0] + arguments } ?? arguments
        process.standardOutput = stdout
        process.standardError = stderr
        if let input {
            let stdin = Pipe()
            stdin.fileHandleForWriting.write(input)
            stdin.fileHandleForWriting.closeFile()
            process.standardInput = stdin
        }
        do {
            try process.run()
        } catch {
            throw SimViewError("ADB_LAUNCH_FAILED", error.localizedDescription)
        }
        let outputBox = ADBOutputBox()
        let errorBox = ADBOutputBox()
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .utility).async {
            while let chunk = try? stdout.fileHandleForReading.read(upToCount: 64 * 1024),
                !chunk.isEmpty
            {
                outputBox.append(chunk, maximum: maximumOutput)
            }
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global(qos: .utility).async {
            while let chunk = try? stderr.fileHandleForReading.read(upToCount: 64 * 1024),
                !chunk.isEmpty
            {
                errorBox.append(chunk, maximum: 64 * 1024)
            }
            readers.leave()
        }
        let deadline = Date().addingTimeInterval(max(0.1, timeout))
        while process.isRunning, Date() < deadline, !cancelled() {
            Thread.sleep(forTimeInterval: 0.025)
        }
        if process.isRunning {
            process.terminate()
            let terminationDeadline = Date().addingTimeInterval(1)
            while process.isRunning, Date() < terminationDeadline {
                Thread.sleep(forTimeInterval: 0.025)
            }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            readers.wait()
            let code = cancelled() ? "ADB_COMMAND_CANCELLED" : "ADB_COMMAND_TIMEOUT"
            let message = cancelled() ? "ADB command was cancelled" : "ADB command exceeded its deadline"
            throw SimViewError(code, message, details: ["operation": arguments.first ?? "unknown"])
        }
        process.waitUntilExit()
        readers.wait()
        let output = outputBox.get()
        let errorData = errorBox.get().data
        guard !output.exceeded else {
            throw SimViewError("ADB_OUTPUT_TOO_LARGE", "ADB output exceeded the allowed size")
        }
        let error = String(data: errorData.prefix(64 * 1024), encoding: .utf8) ?? ""
        return ADBResult(status: process.terminationStatus, output: output.data, error: error)
    }

    func require(
        _ arguments: [String],
        serial: String? = nil,
        input: Data? = nil,
        timeout: TimeInterval = 15,
        cancelled: @Sendable () -> Bool = { false }
    ) throws -> ADBResult {
        let result = try execute(
            arguments,
            serial: serial,
            input: input,
            timeout: timeout,
            cancelled: cancelled
        )
        guard result.status == 0 else {
            throw SimViewError(
                "ADB_COMMAND_FAILED",
                result.error.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                    ?? "ADB exited with status \(result.status)",
                details: ["operation": arguments.first ?? "unknown", "serial": serial as Any]
            )
        }
        return result
    }

    static func parseDevices(_ output: String) -> [ADBDeviceRecord] {
        output.split(whereSeparator: \.isNewline).compactMap { rawLine in
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("List of devices attached") else { return nil }
            let fields = line.split(whereSeparator: \.isWhitespace).map(String.init)
            guard fields.count >= 2 else { return nil }
            var attributes: [String: String] = [:]
            for field in fields.dropFirst(2) {
                let parts = field.split(separator: ":", maxSplits: 1).map(String.init)
                if parts.count == 2 { attributes[parts[0]] = parts[1] }
            }
            return ADBDeviceRecord(serial: fields[0], state: fields[1], attributes: attributes)
        }
    }
}

struct AndroidDeviceProvider: DeviceProvider {
    let client: ADBClient

    init(client: ADBClient? = nil) throws {
        self.client = try client ?? ADBClient()
    }

    func devices() throws -> [DeviceDescription] {
        let listing = try client.require(["devices", "-l"])
        return ADBClient.parseDevices(listing.text).map(describe)
    }

    private func describe(_ record: ADBDeviceRecord) -> DeviceDescription {
        let connected = record.state == "device"
        let properties = connected ? properties(serial: record.serial) : [:]
        let booted = connected && properties["sys.boot_completed"] == "1"
        let emulatorName = officialEmulatorName(record)
        let kind: DeviceKind = emulatorName == nil ? .physical : .emulator
        let model =
            properties["ro.product.model"]
            ?? record.attributes["model"]?.replacingOccurrences(of: "_", with: " ")
        let release = properties["ro.build.version.release"] ?? "Android"
        let api = properties["ro.build.version.sdk"]
        let dimensions = connected ? displaySize(serial: record.serial) : nil
        let densityDpi = connected ? displayDensity(serial: record.serial) : nil
        let state: String
        if !connected {
            state = record.state == "unauthorized" ? "unauthorized" : "offline"
        } else if !booted {
            state = "booting"
        } else {
            state = "ready"
        }
        var metadata = record.attributes
        metadata["adbState"] = record.state
        if let api { metadata["apiLevel"] = api }
        if let emulatorName { metadata["avdName"] = emulatorName }
        if let densityDpi { metadata["densityDpi"] = String(densityDpi) }
        return DeviceDescription(
            id: "android:\(record.serial)",
            platform: .android,
            kind: kind,
            nativeIdentifier: record.serial,
            name: emulatorName ?? model ?? record.serial,
            state: state,
            runtime: api.map { "Android \(release) (API \($0))" } ?? "Android \(release)",
            available: booted,
            pixelWidth: dimensions?.width,
            pixelHeight: dimensions?.height,
            metadata: metadata
        )
    }

    private func properties(serial: String) -> [String: String] {
        guard let result = try? client.execute(["shell", "getprop"], serial: serial), result.status == 0
        else { return [:] }
        return Self.parseProperties(result.text)
    }

    static func parseProperties(_ output: String) -> [String: String] {
        var properties: [String: String] = [:]
        for match in output.matches(of: /(?m)^\[([^\]]+)\]: \[(.*)\]$/) {
            properties[String(match.output.1)] = String(match.output.2)
        }
        return properties
    }

    private func officialEmulatorName(_ record: ADBDeviceRecord) -> String? {
        guard record.serial.range(of: #"^emulator-[0-9]+$"#, options: .regularExpression) != nil,
            record.state == "device",
            let result = try? client.execute(["emu", "avd", "name"], serial: record.serial),
            result.status == 0
        else { return nil }
        return result.text.split(whereSeparator: \.isNewline).map(String.init).first?.nonEmpty
    }

    private func displaySize(serial: String) -> (width: Int, height: Int)? {
        guard let result = try? client.execute(["shell", "wm", "size"], serial: serial), result.status == 0 else {
            return nil
        }
        let matches = result.text.matches(of: /(?:Override|Physical) size:\s*([0-9]+)x([0-9]+)/)
        guard let match = matches.last,
            let width = Int(match.output.1),
            let height = Int(match.output.2)
        else { return nil }
        let rotation = try? client.execute(
            ["shell", "dumpsys", "window", "displays"],
            serial: serial,
            maximumOutput: 8 * 1024 * 1024,
            timeout: 5
        )
        return Self.orientedSize(
            width: width,
            height: height,
            rotation: rotation.flatMap { AndroidController.parseDefaultDisplayRotation($0.text) }
        )
    }

    private func displayDensity(serial: String) -> Int? {
        guard let result = try? client.execute(["shell", "wm", "density"], serial: serial),
            result.status == 0
        else { return nil }
        return Self.parseDisplayDensity(result.text)
    }

    static func parseDisplayDensity(_ output: String) -> Int? {
        output.matches(of: /(?:Override|Physical) density:\s*([0-9]+)/).last.flatMap {
            Int($0.output.1)
        }
    }

    static func orientedSize(width: Int, height: Int, rotation: Int?) -> (width: Int, height: Int) {
        guard rotation == 1 || rotation == 3 else { return (width, height) }
        return (height, width)
    }
}
