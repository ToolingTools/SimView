import CryptoKit
import Darwin
import Foundation

struct IOSRunnerArtifact: Sendable {
    let cacheDirectory: URL
    let xctestrun: URL
    let team: String
    let cacheKey: String
}

struct IOSRunnerLaunch: Sendable {
    let port: UInt16
    let token: String
}

final class IOSRunnerLifecycle: @unchecked Sendable {
    static let deploymentTarget = "15.0"
    static let scheme = "SimViewIOSDeviceRunner"

    private let fileManager: FileManager
    private let environment: [String: String]
    private let diagnosticsLock = NSLock()
    private var diagnostics = Data()
    private(set) var process: Process?
    private var diagnosticsPipe: Pipe?
    private var sessionDirectory: URL?

    init(
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.fileManager = fileManager
        self.environment = environment
    }

    deinit { stop() }

    var lastDiagnostics: String? {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return String(data: diagnostics, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    static func packagedProjectURL(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> URL? {
        var candidates: [URL] = []
        if let explicit = environment["SIMVIEW_IOS_RUNNER_PROJECT"], !explicit.isEmpty {
            candidates.append(URL(fileURLWithPath: explicit))
        }
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardized
        candidates.append(
            executable.deletingLastPathComponent()
                .appendingPathComponent("SimViewIOSDeviceRunner/SimViewIOSDeviceRunner.xcodeproj")
        )
        candidates.append(
            URL(fileURLWithPath: fileManager.currentDirectoryPath)
                .appendingPathComponent("native/SimViewIOSDeviceRunner/SimViewIOSDeviceRunner.xcodeproj")
        )
        return candidates.first { fileManager.fileExists(atPath: $0.path) }
    }

    func readiness(team requestedTeam: String? = nil) -> [String: Any] {
        guard Self.packagedProjectURL(environment: environment, fileManager: fileManager) != nil else {
            return [
                "ready": false,
                "status": "runner-source-missing",
                "message": "The SimView iOS device runner sources are not present in this installation.",
            ]
        }
        do {
            let team = try resolveTeam(requestedTeam)
            let artifact = try artifact(team: team)
            let ready = fileManager.isReadableFile(atPath: artifact.xctestrun.path)
            return [
                "ready": ready,
                "status": ready ? "ready" : "build-required",
                "team": team,
            ]
        } catch let error as SimViewError {
            return [
                "ready": false,
                "status": "signing-required",
                "message": error.message,
            ]
        } catch {
            return [
                "ready": false,
                "status": "unavailable",
                "message": error.localizedDescription,
            ]
        }
    }

    func prepare(device: DeviceDescription, team requestedTeam: String? = nil) throws -> IOSRunnerArtifact {
        guard device.platform == .ios, device.kind == .physical else {
            throw SimViewError("METHOD_UNSUPPORTED", "Device preparation is only available for physical iOS devices")
        }
        let team = try resolveTeam(requestedTeam)
        let artifact = try artifact(team: team)
        if fileManager.isReadableFile(atPath: artifact.xctestrun.path) { return artifact }

        guard let project = Self.packagedProjectURL(environment: environment, fileManager: fileManager) else {
            throw SimViewError(
                "IOS_RUNNER_SOURCE_MISSING",
                "The SimView iOS device runner sources are not present in this installation"
            )
        }
        try fileManager.createDirectory(
            at: artifact.cacheDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let result = run(
            "/usr/bin/xcrun",
            [
                "xcodebuild",
                "-project", project.path,
                "-scheme", Self.scheme,
                "-configuration", "Release",
                "-derivedDataPath", artifact.cacheDirectory.path,
                "-destination", "generic/platform=iOS",
                "IPHONEOS_DEPLOYMENT_TARGET=\(Self.deploymentTarget)",
                "DEVELOPMENT_TEAM=\(team)",
                "PRODUCT_BUNDLE_IDENTIFIER=tools.simview.ios-runner.\(team.lowercased())",
                "CODE_SIGN_STYLE=Automatic",
                "-allowProvisioningUpdates",
                "-allowProvisioningDeviceRegistration",
                "build-for-testing",
            ]
        )
        guard result.status == 0 else {
            throw SimViewError(
                "IOS_RUNNER_BUILD_FAILED",
                result.error.nonEmpty ?? "Xcode could not build the SimView iOS device runner",
                details: [
                    "action": "Open Xcode once, add the Apple account for team \(team), then run prepare_device again.",
                    "team": team,
                ]
            )
        }
        guard let built = Self.findXCTestRun(in: artifact.cacheDirectory, fileManager: fileManager) else {
            throw SimViewError(
                "IOS_RUNNER_BUILD_INVALID",
                "Xcode completed without producing a SimView iOS runner xctestrun file"
            )
        }
        if built.standardizedFileURL != artifact.xctestrun.standardizedFileURL {
            if fileManager.fileExists(atPath: artifact.xctestrun.path) {
                try fileManager.removeItem(at: artifact.xctestrun)
            }
            try fileManager.copyItem(at: built, to: artifact.xctestrun)
        }
        chmod(artifact.xctestrun.path, 0o600)
        return artifact
    }

    func start(
        device: DeviceDescription,
        team requestedTeam: String? = nil,
        appBundleID: String? = nil
    ) throws -> IOSRunnerLaunch {
        stop()
        let artifact = try prepare(device: device, team: requestedTeam)
        let port = try Self.allocatePort()
        let token = UUID().uuidString + UUID().uuidString
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("simview-ios-runner-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        let session = directory.appendingPathComponent("SimViewIOSDeviceRunner.xctestrun")
        do {
            try Self.writeSessionXCTestRun(
                template: artifact.xctestrun,
                output: session,
                port: port,
                token: token,
                appBundleID: appBundleID,
                fileManager: fileManager
            )
        } catch {
            try? fileManager.removeItem(at: directory)
            throw error
        }
        sessionDirectory = directory

        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = [
            "xcodebuild",
            "test-without-building",
            "-xctestrun", session.path,
            "-destination", "platform=iOS,id=\(device.nativeIdentifier)",
            "-allowProvisioningUpdates",
        ]
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
        } catch {
            try? fileManager.removeItem(at: directory)
            sessionDirectory = nil
            throw SimViewError("IOS_RUNNER_LAUNCH_FAILED", error.localizedDescription)
        }
        self.process = process
        diagnosticsPipe = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                self?.appendDiagnostics(data)
            }
        }
        return IOSRunnerLaunch(port: port, token: token)
    }

    func stop() {
        diagnosticsPipe?.fileHandleForReading.readabilityHandler = nil
        if let process, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.025) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
        process = nil
        if let trailing = try? diagnosticsPipe?.fileHandleForReading.readToEnd() {
            appendDiagnostics(trailing)
        }
        diagnosticsPipe = nil
        if let sessionDirectory {
            try? fileManager.removeItem(at: sessionDirectory)
        }
        sessionDirectory = nil
    }

    static func writeSessionXCTestRun(
        template: URL,
        output: URL,
        port: UInt16,
        token: String,
        appBundleID: String?,
        fileManager: FileManager = .default
    ) throws {
        guard
            var plist = try PropertyListSerialization.propertyList(
                from: Data(contentsOf: template),
                options: [.mutableContainersAndLeaves],
                format: nil
            ) as? [String: Any]
        else {
            throw SimViewError("IOS_RUNNER_BUILD_INVALID", "The runner xctestrun template is malformed")
        }
        var updatedTargets = 0
        for key in plist.keys where key != "__xctestrun_metadata__" {
            guard var target = plist[key] as? [String: Any] else { continue }
            var variables = target["EnvironmentVariables"] as? [String: String] ?? [:]
            variables["SIMVIEW_RUNNER_PORT"] = String(port)
            variables["SIMVIEW_RUNNER_TOKEN"] = token
            variables["SIMVIEW_RUNNER_PROTOCOL_VERSION"] = String(IOSRunnerConnection.protocolVersion)
            variables["SIMVIEW_ENABLE_PRIVATE_SCREENSHOT"] = "1"
            variables["SIMVIEW_ENABLE_PRIVATE_ACTIVE_APP"] = "1"
            if let appBundleID { variables["SIMVIEW_TARGET_BUNDLE_ID"] = appBundleID }
            target["EnvironmentVariables"] = variables
            plist[key] = target
            updatedTargets += 1
        }
        guard updatedTargets > 0 else {
            throw SimViewError("IOS_RUNNER_BUILD_INVALID", "The runner xctestrun contains no test targets")
        }
        let data = try PropertyListSerialization.data(
            fromPropertyList: plist,
            format: .binary,
            options: 0
        )
        guard
            fileManager.createFile(
                atPath: output.path,
                contents: data,
                attributes: [.posixPermissions: 0o600]
            )
        else {
            throw SimViewError("IOS_RUNNER_SESSION_FAILED", "Could not create the private runner session file")
        }
        chmod(output.path, 0o600)
    }

    private func resolveTeam(_ requested: String?) throws -> String {
        if let requested = requested?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty {
            return requested
        }
        if let configured = environment["SIMVIEW_IOS_DEVELOPMENT_TEAM"]?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        {
            return configured
        }
        let identities = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"])
        let teams = Self.developmentTeams(from: identities.output + identities.error)
        if teams.count == 1, let team = teams.first { return team }
        let message =
            teams.isEmpty
            ? "No Apple Development signing team was found. Add an Apple account in Xcode or pass --team."
            : "More than one Apple Development signing team is available. Pass --team with one of: \(teams.sorted().joined(separator: ", "))."
        throw SimViewError(
            "IOS_SIGNING_TEAM_REQUIRED",
            message,
            details: ["teams": teams.sorted()]
        )
    }

    static func developmentTeams(from identities: String) -> Set<String> {
        let expression = try? NSRegularExpression(pattern: "Apple Development:[^\\n]*\\(([A-Z0-9]{10})\\)")
        let range = NSRange(identities.startIndex..<identities.endIndex, in: identities)
        return Set(
            expression?.matches(in: identities, range: range).compactMap { match in
                guard let range = Range(match.range(at: 1), in: identities) else { return nil }
                return String(identities[range])
            } ?? [])
    }

    private func artifact(team: String) throws -> IOSRunnerArtifact {
        guard let project = Self.packagedProjectURL(environment: environment, fileManager: fileManager) else {
            throw SimViewError("IOS_RUNNER_SOURCE_MISSING", "The SimView iOS runner project is unavailable")
        }
        let version = run("/usr/bin/xcrun", ["xcodebuild", "-version"])
        guard version.status == 0 else {
            throw SimViewError("XCODE_REQUIRED", "Xcode is required to prepare a physical iOS device")
        }
        let sourceHash = try Self.sourceHash(projectDirectory: project.deletingLastPathComponent())
        let identity = [
            version.output,
            sourceHash,
            team,
            String(IOSRunnerConnection.protocolVersion),
            Self.deploymentTarget,
        ].joined(separator: "\n")
        let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        let cache = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Caches/dev.simview/ios-runner/\(key)", isDirectory: true)
        return IOSRunnerArtifact(
            cacheDirectory: cache,
            xctestrun: cache.appendingPathComponent("SimViewIOSDeviceRunner.xctestrun"),
            team: team,
            cacheKey: key
        )
    }

    static func sourceHash(projectDirectory: URL, fileManager: FileManager = .default) throws -> String {
        guard
            let enumerator = fileManager.enumerator(
                at: projectDirectory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            )
        else {
            throw SimViewError("IOS_RUNNER_SOURCE_MISSING", "Could not enumerate the runner sources")
        }
        let files = enumerator.compactMap { $0 as? URL }.filter { url in
            let relative = url.path.replacingOccurrences(of: projectDirectory.path + "/", with: "")
            guard
                !relative.split(separator: "/").contains(where: {
                    $0 == "build" || $0 == "DerivedData" || $0 == "xcuserdata"
                })
            else { return false }
            return (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }.sorted { $0.path < $1.path }
        var hasher = SHA256()
        for file in files {
            let relative = file.path.replacingOccurrences(of: projectDirectory.path + "/", with: "")
            hasher.update(data: Data(relative.utf8))
            hasher.update(data: try Data(contentsOf: file))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func findXCTestRun(in directory: URL, fileManager: FileManager = .default) -> URL? {
        guard let enumerator = fileManager.enumerator(at: directory, includingPropertiesForKeys: nil) else {
            return nil
        }
        return enumerator.compactMap { $0 as? URL }.first { $0.pathExtension == "xctestrun" }
    }

    private static func allocatePort() throws -> UInt16 {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw SimViewError("IOS_RUNNER_PORT_FAILED", String(cString: strerror(errno)))
        }
        defer { Darwin.close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else {
            throw SimViewError("IOS_RUNNER_PORT_FAILED", String(cString: strerror(errno)))
        }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        guard
            withUnsafeMutablePointer(
                to: &address,
                { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        Darwin.getsockname(fd, $0, &length)
                    }
                }) == 0
        else {
            throw SimViewError("IOS_RUNNER_PORT_FAILED", String(cString: strerror(errno)))
        }
        return UInt16(bigEndian: address.sin_port)
    }

    private func appendDiagnostics(_ data: Data) {
        diagnosticsLock.lock()
        let remaining = max(0, 128 * 1024 - diagnostics.count)
        if remaining > 0 { diagnostics.append(data.prefix(remaining)) }
        diagnosticsLock.unlock()
    }
}
