import Foundation
import XCTest

@testable import SimViewCore

private final class WorkerTestState: @unchecked Sendable {
    private let lock = NSLock()
    private var current = true
    private var events: [String] = []
    func invalidate() { lock.withLock { current = false } }
    var isCurrent: Bool { lock.withLock { current } }
    func record(_ event: String) { lock.withLock { events.append(event) } }
    var recorded: [String] { lock.withLock { events } }
}

private final class WorkerTestProvider: XCTestAccessibilityProviding {
    let state: WorkerTestState
    init(state: WorkerTestState) { self.state = state }
    func snapshot(bundleID _: String, maxNodes _: Int, timeout _: TimeInterval) throws -> [String: Any] { [:] }
    func elementAtPoint(bundleID _: String, x _: Double, y _: Double, timeout _: TimeInterval) throws -> [String: Any] {
        [:]
    }
    func stop() { state.record("stop") }
}

final class AccessibilityWorkerTests: XCTestCase {
    private func device(_ id: String = "test") -> DeviceDescription {
        DeviceDescription(
            id: "ios:\(id)", platform: .ios, kind: .simulator, nativeIdentifier: id,
            name: "Test", state: "Booted", runtime: "iOS", available: true,
            pixelWidth: nil, pixelHeight: nil, metadata: [:])
    }

    private func request(_ method: String) throws -> Request {
        try Request(
            data: JSONSerialization.data(withJSONObject: [
                "id": "test", "protocolVersion": SimViewVersion.protocolVersion, "method": method,
                "params": ["bundleId": "dev.example.app"],
            ]))
    }

    func testBlockedProviderDoesNotBlockDispatchQueueAndCleanupIsSerialized() throws {
        let state = WorkerTestState()
        let started = expectation(description: "Provider startup entered")
        let finished = expectation(description: "Startup completed")
        let stopped = expectation(description: "Cleanup completed")
        let responsive = expectation(description: "Frame, input and status dispatch")
        let release = DispatchSemaphore(value: 0)
        let observation = AccessibilityObservationCoordinator()
        let service = AccessibilityService(observation: observation, foregroundBundleID: { _ in "dev.example.app" }) {
            _, _ in
            state.record("start")
            started.fulfill()
            _ = release.wait(timeout: .now() + 5)
            state.record("ready")
            return WorkerTestProvider(state: state)
        }
        let worker = AccessibilityWorker(observation: observation, service: service)
        let request = try request("accessibility.enableXCTestProvider")
        let device = device()
        let serverQueue = DispatchQueue(label: "test.server")
        serverQueue.async {
            worker.submit(
                isCurrent: { true },
                operation: {
                    try worker.execute(request, device: device, android: nil)
                }, completion: { _ in finished.fulfill() })
            serverQueue.async {
                state.record("frame-input-status")
                responsive.fulfill()
            }
        }
        wait(for: [started, responsive], timeout: 2)
        worker.shutdown { stopped.fulfill() }
        XCTAssertFalse(state.recorded.contains("stop"))
        release.signal()
        wait(for: [finished, stopped], timeout: 2)
        XCTAssertEqual(state.recorded.filter { $0 != "frame-input-status" }, ["start", "ready", "stop"])
    }

    func testInvalidatedQueuedWorkIsDiscardedBeforeTouchingProvider() {
        let state = WorkerTestState()
        let observation = AccessibilityObservationCoordinator()
        let worker = AccessibilityWorker(observation: observation)
        let entered = expectation(description: "First operation entered")
        let drained = expectation(description: "Worker drained")
        let release = DispatchSemaphore(value: 0)
        worker.submit(
            isCurrent: { true },
            operation: {
                entered.fulfill()
                _ = release.wait(timeout: .now() + 5)
                return .null
            }, completion: { _ in })
        wait(for: [entered], timeout: 2)
        worker.submit(
            isCurrent: { state.isCurrent },
            operation: {
                state.record("stale-operation")
                return .null
            }, completion: { _ in state.record("stale-completion") })
        state.invalidate()
        worker.shutdown { drained.fulfill() }
        release.signal()
        wait(for: [drained], timeout: 2)
        XCTAssertEqual(state.recorded, [])
    }

    func testShutdownInterruptsBlockedSocketReadAndRejectsNewWork() throws {
        let cancellation = AccessibilityCancellation()
        var descriptors: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors), 0)
        let reader = descriptors[0]
        let writer = descriptors[1]
        defer {
            Darwin.close(reader)
            Darwin.close(writer)
        }
        let entered = expectation(description: "Read entered")
        let interrupted = expectation(description: "Read interrupted")
        DispatchQueue.global().async {
            do {
                _ = try cancellation.withSocket(reader) {
                    entered.fulfill()
                    return try XCTestProviderMessageCodec.read(from: reader, timeout: 30)
                }
                XCTFail("Cancelled read unexpectedly completed")
            } catch {
                interrupted.fulfill()
            }
        }
        wait(for: [entered], timeout: 2)
        cancellation.cancel()
        wait(for: [interrupted], timeout: 1)
        XCTAssertThrowsError(try cancellation.check())
        XCTAssertThrowsError(try cancellation.withSocket(reader) { true })
    }

    func testSwitchingDevicesStopsTheOldProviderBeforeNewStartup() throws {
        let state = WorkerTestState()
        let observation = AccessibilityObservationCoordinator()
        let service = AccessibilityService(observation: observation, foregroundBundleID: { _ in "dev.example.app" }) {
            udid, _ in
            state.record(udid)
            return WorkerTestProvider(state: state)
        }
        let worker = AccessibilityWorker(observation: observation, service: service)
        let request = try request("accessibility.enableXCTestProvider")
        let oldDevice = device("old")
        let newDevice = device("new")
        let finished = expectation(description: "Both devices cleaned up")
        worker.submit(
            isCurrent: { true },
            operation: {
                try worker.execute(request, device: oldDevice, android: nil)
            }, completion: { _ in })
        worker.discardDevice(udid: "old")
        worker.submit(
            isCurrent: { true },
            operation: {
                try worker.execute(request, device: newDevice, android: nil)
            }, completion: { _ in })
        worker.shutdown { finished.fulfill() }
        wait(for: [finished], timeout: 2)
        XCTAssertEqual(state.recorded, ["old", "stop", "new", "stop"])
    }
}
