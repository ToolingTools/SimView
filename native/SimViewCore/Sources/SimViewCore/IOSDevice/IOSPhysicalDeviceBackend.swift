import Foundation

enum DeviceBackendRoute: Sendable, Equatable {
    case iosSimulator
    case iosPhysical
    case android

    init(_ device: DeviceDescription) {
        if device.platform == .android {
            self = .android
        } else if device.kind == .physical {
            self = .iosPhysical
        } else {
            self = .iosSimulator
        }
    }
}

final class IOSPhysicalDeviceBackend: @unchecked Sendable {
    typealias ConfigurationHandler = @Sendable (Data) -> Void
    typealias FrameHandler = @Sendable (UInt64, Bool, Data) -> Void
    typealias FailureHandler = @Sendable (Error) -> Void

    private let lifecycle: IOSRunnerLifecycle
    private let stateLock = NSLock()
    private var connection: IOSRunnerConnection?
    private var deviceID: String?
    private var selectedBundleID: String?
    private var selectedTeam: String?
    private let onConfiguration: ConfigurationHandler
    private let onFrame: FrameHandler
    private let onFailure: FailureHandler

    init(
        lifecycle: IOSRunnerLifecycle = IOSRunnerLifecycle(),
        onConfiguration: @escaping ConfigurationHandler,
        onFrame: @escaping FrameHandler,
        onFailure: @escaping FailureHandler
    ) {
        self.lifecycle = lifecycle
        self.onConfiguration = onConfiguration
        self.onFrame = onFrame
        self.onFailure = onFailure
    }

    deinit { shutdown() }

    var diagnostics: String? { lifecycle.lastDiagnostics }

    func readiness(team: String? = nil) -> [String: Any] { lifecycle.readiness(team: team) }

    func prepare(device: DeviceDescription, team: String? = nil) throws -> [String: Any] {
        let artifact = try lifecycle.prepare(device: device, team: team)
        selectedTeam = artifact.team
        return [
            "device": device.dictionary,
            "ready": true,
            "status": "ready",
            "team": artifact.team,
        ]
    }

    func apps(device: DeviceDescription) throws -> [String: Any] {
        [
            "deviceId": device.id,
            "apps": try IOSInstalledAppProvider.apps(device: device).map(\.dictionary),
        ]
    }

    func selectApp(device: DeviceDescription, bundleID: String) throws -> [String: Any] {
        guard !bundleID.isEmpty, bundleID.utf8.count <= 512 else {
            throw SimViewError("PARAMETER_INVALID", "appBundleId is invalid")
        }
        let connection = try ensureConnection(device: device, appBundleID: bundleID)
        let result = try connection.selectApp(bundleID)
        stateLock.lock()
        selectedBundleID = bundleID
        stateLock.unlock()
        return result
    }

    func startCapture(device: DeviceDescription, appBundleID: String?) throws -> [String: Any] {
        let connection = try ensureConnection(device: device, appBundleID: appBundleID)
        if let appBundleID, appBundleID != currentBundleID {
            _ = try connection.selectApp(appBundleID)
            stateLock.lock()
            selectedBundleID = appBundleID
            stateLock.unlock()
        }
        return try connection.startStream()
    }

    func stopCapture() { try? currentConnection?.stopStream() }
    func requestKeyframe() throws { try requireConnection().requestKeyframe() }
    func screenshot() throws -> (data: Data, metadata: [String: Any]) {
        try requireConnection().screenshot(quality: "full")
    }
    func snapshot(maxDepth: Int?, maxChildren: Int?) throws -> [String: Any] {
        try requireConnection().snapshot(maxDepth: maxDepth, maxChildren: maxChildren)
    }
    func elementAtPoint(x: Double, y: Double) throws -> [String: Any] {
        try requireConnection().elementAtPoint(x: x, y: y)
    }
    func find(selector: [String: Any], timeout: TimeInterval?) throws -> [String: Any] {
        try requireConnection().find(selector: selector, timeout: timeout)
    }
    func wait(selector: [String: Any], exists: Bool, timeout: TimeInterval) throws -> [String: Any] {
        try requireConnection().wait(selector: selector, exists: exists, timeout: timeout)
    }
    func tap(x: Double, y: Double, duration: Double) throws {
        if duration >= 0.5 {
            try requireConnection().longPress(x: x, y: y, duration: duration)
        } else {
            try requireConnection().tap(x: x, y: y, duration: duration)
        }
    }
    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double, duration: Double) throws {
        try requireConnection().swipe(
            fromX: fromX, fromY: fromY, toX: toX, toY: toY, duration: duration)
    }
    func typeText(_ text: String) throws { try requireConnection().typeText(text) }
    func pressButton(_ button: String) throws { try requireConnection().pressButton(button) }
    func setOrientation(_ orientation: String) throws { try requireConnection().setOrientation(orientation) }
    func activateApp() throws { try requireConnection().activateApp() }
    func terminateApp() throws { try requireConnection().terminateApp() }

    func shutdown() {
        stateLock.lock()
        let value = connection
        connection = nil
        deviceID = nil
        selectedBundleID = nil
        stateLock.unlock()
        value?.stop()
        lifecycle.stop()
    }

    private var currentConnection: IOSRunnerConnection? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return connection
    }

    private var currentBundleID: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return selectedBundleID
    }

    private func requireConnection() throws -> IOSRunnerConnection {
        guard let connection = currentConnection else {
            throw SimViewError("IOS_RUNNER_NOT_STARTED", "Start physical iOS capture before using this operation")
        }
        return connection
    }

    private func ensureConnection(
        device: DeviceDescription,
        appBundleID: String?
    ) throws -> IOSRunnerConnection {
        guard DeviceBackendRoute(device) == .iosPhysical else {
            throw SimViewError("METHOD_UNSUPPORTED", "The XCTest runner requires a physical iOS device")
        }
        stateLock.lock()
        if let connection, deviceID == device.id {
            stateLock.unlock()
            return connection
        }
        let previous = connection
        connection = nil
        deviceID = nil
        stateLock.unlock()
        previous?.stop()
        lifecycle.stop()

        let launch = try lifecycle.start(
            device: device,
            team: selectedTeam,
            appBundleID: appBundleID ?? currentBundleID
        )
        let deadline = Date().addingTimeInterval(45)
        var lastError: Error = SimViewError("IOS_RUNNER_CONNECT_FAILED", "The iOS runner did not open its USB service")
        repeat {
            if let process = lifecycle.process, !process.isRunning {
                throw SimViewError(
                    "IOS_RUNNER_LAUNCH_FAILED",
                    lifecycle.lastDiagnostics ?? "The XCTest runner exited before accepting a connection"
                )
            }
            let candidate = IOSRunnerConnection(
                onConfiguration: onConfiguration,
                onFrame: onFrame,
                onFailure: { [weak self] error in
                    self?.discardFailedConnection()
                    self?.onFailure(error)
                }
            )
            do {
                try candidate.connect(
                    udid: device.nativeIdentifier,
                    port: launch.port,
                    token: launch.token,
                    timeout: 1
                )
                stateLock.lock()
                connection = candidate
                deviceID = device.id
                selectedBundleID = appBundleID ?? selectedBundleID
                stateLock.unlock()
                return candidate
            } catch {
                candidate.stop(sendShutdown: false)
                lastError = error
                Thread.sleep(forTimeInterval: 0.2)
            }
        } while Date() < deadline
        lifecycle.stop()
        throw SimViewError(
            "IOS_RUNNER_CONNECT_FAILED",
            lifecycle.lastDiagnostics
                ?? (lastError as? SimViewError)?.message ?? lastError.localizedDescription
        )
    }

    private func discardFailedConnection() {
        stateLock.lock()
        connection = nil
        deviceID = nil
        stateLock.unlock()
    }
}
