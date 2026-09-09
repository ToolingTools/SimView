import Darwin
import XCTest

@testable import SimViewCore

final class DeviceDiscoveryTests: XCTestCase {
    private func executable(_ script: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("discovery-fixture")
        try Data("#!/bin/sh\n\(script)\n".utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        return file
    }

    private func device(_ platform: DevicePlatform) -> DeviceDescription {
        DeviceDescription(
            id: "\(platform.rawValue):fixture", platform: platform, kind: .emulator,
            nativeIdentifier: "fixture", name: "Healthy device", state: "ready", runtime: "fixture",
            available: true, pixelWidth: nil, pixelHeight: nil, metadata: [:]
        )
    }

    func testEitherPlatformSurvivesTheOtherPlatformsTimeout() throws {
        let slow = try executable("exec sleep 30")
        for failedPlatform in [DevicePlatform.ios, .android] {
            let healthy = device(failedPlatform == .ios ? .android : .ios)
            let failing: @Sendable () throws -> [DeviceDescription] = {
                let result = SimViewCore.run(slow.path, [], timeout: 0.15)
                guard result.status == 0 else {
                    throw SimViewError("DISCOVERY_TIMEOUT", result.error)
                }
                return []
            }
            let succeeding: @Sendable () throws -> [DeviceDescription] = { [healthy] }
            let started = ProcessInfo.processInfo.systemUptime
            let devices = try DeviceRuntime.devices(
                ios: failedPlatform == .ios ? failing : succeeding,
                android: failedPlatform == .android ? failing : succeeding
            )
            XCTAssertEqual(devices.map(\.id), [healthy.id])
            XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 4)
        }
    }

    func testProvidersStartIndependentlyAndRetainIOSFirstOrdering() throws {
        let androidStarted = DispatchSemaphore(value: 0)
        let ios = device(.ios)
        let android = device(.android)
        let devices = try DeviceRuntime.devices(
            ios: {
                guard androidStarted.wait(timeout: .now() + 1) == .success else {
                    throw SimViewError("SERIAL_DISCOVERY", "Android did not start independently")
                }
                return [ios]
            },
            android: {
                androidStarted.signal()
                return [android]
            }
        )
        XCTAssertEqual(devices.map(\.id), [ios.id, android.id])
    }

    func testBothProviderFailuresRemainAnError() {
        XCTAssertThrowsError(
            try DeviceRuntime.devices(
                ios: { throw SimViewError("IOS_UNAVAILABLE", "iOS unavailable") },
                android: { throw SimViewError("ANDROID_UNAVAILABLE", "Android unavailable") }
            )
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "IOS_UNAVAILABLE")
        }
    }

    func testStalledAndroidMetadataRetainsTheDeviceAsUnavailable() throws {
        let adb = try executable(
            """
            if [ "$1" = devices ]; then
              printf 'List of devices attached\\nemulator-5562 device model:Pixel_9\\n'
            else
              exec sleep 30
            fi
            """
        )
        let started = ProcessInfo.processInfo.systemUptime
        let devices = try AndroidDeviceProvider(
            client: ADBClient(executable: adb.path), discoveryTimeout: 2
        ).devices()
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 4)
        let found = try XCTUnwrap(devices.first)
        XCTAssertEqual(found.id, "android:emulator-5562")
        XCTAssertEqual(found.name, "Pixel 9")
        XCTAssertEqual(found.kind, .emulator)
        XCTAssertEqual(found.state, "unknown")
        XCTAssertFalse(found.available)
        XCTAssertEqual(found.metadata["discoveryStatus"], "metadata-unavailable")
    }

    func testAndroidEnrichmentSharesOneDeadlineAcrossDevicesAndQueries() throws {
        let adb = try executable(
            """
            if [ "$1" = devices ]; then
              printf 'List of devices attached\\nemulator-5554 device\\nemulator-5562 device\\n'
            elif [ "$4" = getprop ]; then
              printf '[sys.boot_completed]: [1]\\n[ro.build.version.release]: [16]\\n'
            else
              exec sleep 30
            fi
            """
        )
        let started = ProcessInfo.processInfo.systemUptime
        let devices = try AndroidDeviceProvider(
            client: ADBClient(executable: adb.path), discoveryTimeout: 2
        ).devices()
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 4)
        XCTAssertEqual(devices.count, 2)
        XCTAssertTrue(devices[0].available)
        XCTAssertEqual(devices[0].runtime, "Android 16")
        XCTAssertEqual(devices[1].state, "unknown")
    }

    func testBoundedCommandDrainsOutputLargerThanAPipeBuffer() throws {
        let verbose = try executable("/usr/bin/head -c 262144 /dev/zero")
        let result = SimViewCore.run(verbose.path, [], timeout: 2)
        XCTAssertEqual(result.status, 0)
        XCTAssertEqual(result.output.utf8.count, 262_144)
    }

    func testBoundedCommandKillsAnUnresponsiveChild() throws {
        let slow = try executable("echo $$ > \"$0.pid\"\ntrap '' TERM\nwhile :; do :; done")
        let started = ProcessInfo.processInfo.systemUptime
        let result = SimViewCore.run(slow.path, [], timeout: 1)
        XCTAssertEqual(result.status, 124)
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 4)
        let pidText = try String(contentsOfFile: slow.path + ".pid", encoding: .utf8)
        let pid = try XCTUnwrap(Int32(pidText.trimmingCharacters(in: .whitespacesAndNewlines)))
        let signalStatus = kill(pid, 0)
        let signalError = errno
        XCTAssertEqual(signalStatus, -1)
        XCTAssertEqual(signalError, ESRCH)
    }
}
