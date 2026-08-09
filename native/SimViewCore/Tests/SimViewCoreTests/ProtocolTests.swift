import CoreVideo
import Darwin
import XCTest

@testable import SimViewCore

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0

    var value: Int { lock.withLock { storage } }

    func increment() -> Int {
        lock.withLock {
            storage += 1
            return storage
        }
    }
}

private final class AccessibilitySnapshotBox: @unchecked Sendable {
    let value: [String: Any]

    init(_ value: [String: Any]) {
        self.value = value
    }
}

private final class AccessibilitySnapshotSequence: @unchecked Sendable {
    private let lock = NSLock()
    private let values: [[String: Any]]
    private var index = 0

    init(_ values: [[String: Any]]) {
        self.values = values
    }

    func next() -> [String: Any] {
        lock.withLock {
            let value = values[min(index, values.count - 1)]
            index += 1
            return value
        }
    }
}

final class ProtocolTests: XCTestCase {
    private func pixelBuffer(red: UInt8, green: UInt8, blue: UInt8) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(
            CVPixelBufferCreate(
                kCFAllocatorDefault,
                64,
                64,
                kCVPixelFormatType_32BGRA,
                nil,
                &buffer
            ),
            kCVReturnSuccess
        )
        let result = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(result, [])
        let bytes = CVPixelBufferGetBaseAddress(result)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(result)
        for y in 0..<64 {
            for x in 0..<64 {
                let offset = y * stride + x * 4
                bytes[offset] = blue
                bytes[offset + 1] = green
                bytes[offset + 2] = red
                bytes[offset + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(result, [])
        return result
    }

    private func temporaryExecutable(_ body: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("simview-adb-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let executable = directory.appendingPathComponent("adb")
        try Data(("#!/bin/sh\n" + body).utf8).write(to: executable)
        XCTAssertEqual(chmod(executable.path, 0o700), 0)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return executable
    }

    func testCanonicalHelloFixtureDecodes() throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../../tests/fixtures/protocol/hello.json")
            .standardized
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as! [String: Any]
        let requestData = try JSONSerialization.data(withJSONObject: object["request"] as Any)
        let request = try Request(data: requestData)

        XCTAssertEqual(request.protocolVersion, SimViewVersion.protocolVersion)
        XCTAssertEqual(request.method, "hello")
        XCTAssertEqual(request.params["codecs"]?.arrayValue?.compactMap(\.stringValue), ["h264", "mjpeg"])
    }

    func testAccessibilityObservationSettlesAnEventBurstWithoutCapturingOnTheCallback() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let captures = LockedCounter()
        let snapshot: [String: Any] = [
            "snapshotId": "snapshot-1",
            "capturedAt": "2026-08-08T10:00:00.000Z",
            "root": ["ref": "ax:1", "label": "Continue"],
        ]
        let box = AccessibilitySnapshotBox(snapshot)
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 75,
            maximumWaitMilliseconds: 0,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return box.value
        }
        XCTAssertTrue(baseline.stable)
        XCTAssertEqual(baseline.revision, "1")
        XCTAssertEqual(captures.value, 1)

        coordinator.markEvent()
        coordinator.markEvent()
        XCTAssertEqual(captures.value, 1)
        let settled = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 75,
            maximumWaitMilliseconds: 250,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return box.value
        }
        XCTAssertTrue(settled.eventChanged)
        XCTAssertTrue(settled.stable)
        XCTAssertFalse(settled.timedOut)
        XCTAssertFalse(settled.fallbackUsed)
        XCTAssertEqual(settled.captureCount, 1)
        XCTAssertEqual(settled.changeSource, "event")
        XCTAssertEqual(captures.value, 2)
    }

    func testAccessibilityObservationReturnsAValidTimeoutForAnUnchangedTree() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let captures = LockedCounter()
        let snapshot: [String: Any] = [
            "snapshotId": "snapshot-1",
            "capturedAt": "2026-08-08T10:00:00.000Z",
            "root": ["ref": "ax:1"],
        ]
        let box = AccessibilitySnapshotBox(snapshot)
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 75,
            maximumWaitMilliseconds: 0,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return box.value
        }
        let timedOut = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 75,
            maximumWaitMilliseconds: 350,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return box.value
        }
        XCTAssertFalse(timedOut.eventChanged)
        XCTAssertFalse(timedOut.stable)
        XCTAssertTrue(timedOut.timedOut)
        XCTAssertTrue(timedOut.fallbackUsed)
        XCTAssertEqual(timedOut.captureCount, 2)
        XCTAssertEqual(timedOut.changeSource, "none")
        XCTAssertEqual(captures.value, 3)
    }

    func testAccessibilityObservationSettlesAnEventFreeSnapshotDiff() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let captures = LockedCounter()
        let baselineSnapshot: [String: Any] = [
            "snapshotId": "snapshot-1",
            "capturedAt": "2026-08-08T10:00:00.000Z",
            "root": ["ref": "ax:1", "label": "Invoices"],
        ]
        let changedSnapshot: [String: Any] = [
            "snapshotId": "snapshot-2",
            "capturedAt": "2026-08-08T10:00:01.000Z",
            "root": ["ref": "ax:2", "label": "Invoice 30363063"],
        ]
        let snapshots = AccessibilitySnapshotSequence([
            baselineSnapshot, changedSnapshot, changedSnapshot,
        ])
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 0,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return snapshots.next()
        }
        let settled = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 500,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return snapshots.next()
        }

        XCTAssertTrue(settled.eventChanged)
        XCTAssertTrue(settled.stable)
        XCTAssertFalse(settled.timedOut)
        XCTAssertTrue(settled.fallbackUsed)
        XCTAssertEqual(settled.captureCount, 2)
        XCTAssertEqual(settled.changeSource, "snapshot-diff")
        XCTAssertEqual(captures.value, 3)
    }

    func testAccessibilityObservationReportsContinuouslyChangingFallbackAsUnstable() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let captures = LockedCounter()
        let snapshots = AccessibilitySnapshotSequence([
            ["snapshotId": "snapshot-1", "root": ["ref": "ax:1", "label": "Invoices"]],
            ["snapshotId": "snapshot-2", "root": ["ref": "ax:2", "label": "Invoice A"]],
            ["snapshotId": "snapshot-3", "root": ["ref": "ax:3", "label": "Invoice B"]],
        ])
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 0,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return snapshots.next()
        }
        let unsettled = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 500,
            strategy: "ios-axp"
        ) { _, _ in
            _ = captures.increment()
            return snapshots.next()
        }

        XCTAssertTrue(unsettled.eventChanged)
        XCTAssertFalse(unsettled.stable)
        XCTAssertTrue(unsettled.fallbackUsed)
        XCTAssertEqual(unsettled.captureCount, 2)
        XCTAssertEqual(unsettled.changeSource, "snapshot-diff")
        XCTAssertEqual(captures.value, 3)
    }

    func testShellAccessibilityObservationBacksOffAndSettlesWithoutRepeatedDumps() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let captures = LockedCounter()
        let baselineSnapshot: [String: Any] = [
            "snapshotId": "snapshot-1",
            "capturedAt": "2026-08-08T10:00:00.000Z",
            "root": ["ref": "android:1", "label": "Home"],
        ]
        let changedSnapshot: [String: Any] = [
            "snapshotId": "snapshot-2",
            "capturedAt": "2026-08-08T10:00:01.000Z",
            "root": ["ref": "android:2", "label": "Invoices"],
        ]
        let baselineBox = AccessibilitySnapshotBox(baselineSnapshot)
        let changedBox = AccessibilitySnapshotBox(changedSnapshot)
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 0,
            strategy: "android-shell-dump"
        ) { _, _ in
            _ = captures.increment()
            return baselineBox.value
        }
        let settled = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 500,
            strategy: "android-shell-dump"
        ) { _, _ in
            _ = captures.increment()
            return changedBox.value
        }

        XCTAssertTrue(settled.eventChanged)
        XCTAssertTrue(settled.stable)
        XCTAssertFalse(settled.timedOut)
        XCTAssertEqual(captures.value, 2)
    }

    func testShellAccessibilityObservationBoundsUnchangedHierarchyDumps() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let captures = LockedCounter()
        let snapshot: [String: Any] = [
            "snapshotId": "snapshot-1",
            "capturedAt": "2026-08-08T10:00:00.000Z",
            "root": ["ref": "android:1", "label": "Home"],
        ]
        let box = AccessibilitySnapshotBox(snapshot)
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 0,
            strategy: "android-shell-dump"
        ) { _, _ in
            _ = captures.increment()
            return box.value
        }
        let timedOut = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 520,
            strategy: "android-shell-dump"
        ) { _, _ in
            _ = captures.increment()
            return box.value
        }

        XCTAssertFalse(timedOut.eventChanged)
        XCTAssertFalse(timedOut.stable)
        XCTAssertTrue(timedOut.timedOut)
        XCTAssertEqual(captures.value, 3)
    }

    func testAccessibilityObservationCanSettleAnUnchangedTreeForInteraction() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let snapshot: [String: Any] = [
            "snapshotId": "snapshot-1",
            "capturedAt": "2026-08-08T10:00:00.000Z",
            "root": ["ref": "ax:1", "label": "Continue"],
        ]
        let box = AccessibilitySnapshotBox(snapshot)
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 0,
            strategy: "snapshot-diff"
        ) { _, _ in box.value }
        let settled = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 250,
            requireChange: false,
            strategy: "snapshot-diff"
        ) { _, _ in box.value }

        XCTAssertFalse(settled.eventChanged)
        XCTAssertTrue(settled.stable)
        XCTAssertFalse(settled.timedOut)
    }

    func testAccessibilityObservationScopeChangeStillWaitsForQuiet() throws {
        let coordinator = AccessibilityObservationCoordinator()
        let captures = LockedCounter()
        let baseline = try coordinator.observe(
            afterRevision: nil,
            scope: "interactive",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 0,
            strategy: "ios-axp"
        ) { scope, _ in
            _ = captures.increment()
            return ["root": ["ref": "ax:root"], "scope": scope]
        }
        let startedAt = Date()
        let settled = try coordinator.observe(
            afterRevision: baseline.revision,
            scope: "visible",
            maxNodes: 100,
            settleQuietMilliseconds: 40,
            maximumWaitMilliseconds: 250,
            requireChange: false,
            strategy: "ios-axp"
        ) { scope, _ in
            _ = captures.increment()
            return ["root": ["ref": "ax:root"], "scope": scope]
        }

        XCTAssertTrue(settled.stable)
        XCTAssertFalse(settled.timedOut)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(startedAt), 0.035)
        XCTAssertEqual(captures.value, 3)
    }

    func testAccessibilityObservationRejectsMalformedRevisions() throws {
        let coordinator = AccessibilityObservationCoordinator()
        XCTAssertThrowsError(
            try coordinator.observe(
                afterRevision: "not-a-revision",
                scope: "interactive",
                maxNodes: 100,
                settleQuietMilliseconds: 75,
                maximumWaitMilliseconds: 100,
                strategy: "snapshot-diff"
            ) { _, _ in [:] }
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "PARAMETER_INVALID")
        }
    }

    func testJSONValueRoundTrip() throws {
        let value = JSONValue.object([
            "boolean": .bool(true),
            "number": .number(42),
            "array": .array([.string("value"), .null]),
        ])
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), value)
    }

    func testMetricsKeepABoundedLatencyWindow() {
        let metrics = Metrics()
        for value in 0..<2_100 {
            metrics.didEncode(latencyMS: Double(value))
        }
        let latency = metrics.dictionary["latencyMs"] as! [String: Double]
        XCTAssertGreaterThan(latency["p50"]!, 1_000)
        XCTAssertGreaterThan(latency["p95"]!, 1_900)
    }

    func testH264DecodeSchedulingPolicyBoundsWorkAndWaitsForAKeyframe() {
        var policy = H264DecodeSchedulingPolicy(maximumWorkCount: 3)
        _ = (0..<3).map { _ in policy.receive(isKeyframe: false) }
        XCTAssertEqual(policy.workCount, 3)
        XCTAssertLessThanOrEqual(policy.workCount, policy.maximumWorkCount)

        XCTAssertEqual(policy.receive(isKeyframe: false), .resynchronize)
        XCTAssertTrue(policy.waitingForKeyframe)
        XCTAssertEqual(policy.workCount, 0)
        XCTAssertEqual(policy.receive(isKeyframe: false), .drop)

        guard case .submit(let recoveryGeneration) = policy.receive(isKeyframe: true) else {
            return XCTFail("Recovery keyframe was not submitted")
        }
        XCTAssertFalse(policy.waitingForKeyframe)
        XCTAssertEqual(policy.workCount, 1)
        policy.complete(generation: recoveryGeneration &- 1)
        XCTAssertEqual(policy.workCount, 1, "A stale callback must not release current work")
        policy.complete(generation: recoveryGeneration)
        XCTAssertEqual(policy.workCount, 0)
    }

    func testH264DecodeFailurePolicyTriggersOneBoundedRecovery() {
        var policy = H264DecodeFailurePolicy(maximumConsecutiveFailures: 3)
        XCTAssertFalse(policy.recordFailure())
        XCTAssertFalse(policy.recordFailure())
        policy.recordSuccess()
        XCTAssertFalse(policy.recordFailure())
        XCTAssertFalse(policy.recordFailure())
        XCTAssertTrue(policy.recordFailure())
        XCTAssertFalse(policy.recordFailure())
        XCTAssertTrue(policy.recoveryTriggered)
        policy.reset()
        XCTAssertFalse(policy.recoveryTriggered)
        XCTAssertEqual(policy.consecutiveFailures, 0)
    }

    func testOnDemandObservationDoesNotEncodeUntilVisualRequest() throws {
        let attempts = LockedCounter()
        let completions = LockedCounter()
        let coordinator = ObservationCoordinator(
            imagePreparationPolicy: .onDemand,
            prepareImage: { frame in
                _ = attempts.increment()
                return (
                    Data([1, 2, 3]), CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame)
                )
            },
            didCompleteImagePreparation: { _ = completions.increment() }
        )
        coordinator.ingest(try pixelBuffer(red: 20, green: 30, blue: 40), frameID: "semantic")
        Thread.sleep(forTimeInterval: 0.12)
        let semantic = try coordinator.observe(
            visual: false, afterRevision: nil, maximumWaitMilliseconds: 100)
        XCTAssertNil(semantic.image)
        XCTAssertEqual(semantic.width, 64)
        XCTAssertEqual(semantic.height, 64)
        XCTAssertEqual(attempts.value, 0)

        let visual = try coordinator.observe(
            visual: true, afterRevision: nil, maximumWaitMilliseconds: 1_000)
        XCTAssertEqual(visual.image, Data([1, 2, 3]))
        XCTAssertEqual(attempts.value, 1)
        XCTAssertEqual(completions.value, 1)
    }

    func testSwitchingToOnDemandCancelsScheduledEagerPreparation() throws {
        let attempts = LockedCounter()
        let coordinator = ObservationCoordinator(prepareImage: { frame in
            _ = attempts.increment()
            return (Data([4]), CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame))
        })
        coordinator.ingest(try pixelBuffer(red: 30, green: 40, blue: 50), frameID: "policy")
        coordinator.setImagePreparationPolicy(.onDemand)
        Thread.sleep(forTimeInterval: 0.12)
        let semantic = try coordinator.observe(
            visual: false, afterRevision: nil, maximumWaitMilliseconds: 100)
        XCTAssertNil(semantic.image)
        XCTAssertEqual(attempts.value, 0)
    }

    func testConcurrentVisualObservationsCoalesceOneEncode() throws {
        let attempts = LockedCounter()
        let coordinator = ObservationCoordinator(
            imagePreparationPolicy: .onDemand,
            prepareImage: { frame in
                _ = attempts.increment()
                Thread.sleep(forTimeInterval: 0.05)
                return (Data([9]), CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame))
            }
        )
        coordinator.ingest(try pixelBuffer(red: 50, green: 60, blue: 70), frameID: "shared")
        let first = expectation(description: "first visual observation")
        let second = expectation(description: "second visual observation")
        for done in [first, second] {
            DispatchQueue.global().async {
                defer { done.fulfill() }
                let result = try? coordinator.observe(
                    visual: true, afterRevision: nil, maximumWaitMilliseconds: 1_000)
                XCTAssertEqual(result?.image, Data([9]))
            }
        }
        wait(for: [first, second], timeout: 2)
        XCTAssertEqual(attempts.value, 1)
    }

    func testOnDemandObservationRetriesOnlyOnALaterRequestAfterFailure() throws {
        let attempts = LockedCounter()
        let coordinator = ObservationCoordinator(
            imagePreparationPolicy: .onDemand,
            prepareImage: { frame in
                if attempts.increment() == 1 {
                    throw SimViewError("TEST_ENCODE_FAILURE", "Expected test failure")
                }
                return (Data([7]), CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame))
            }
        )
        coordinator.ingest(try pixelBuffer(red: 80, green: 90, blue: 100), frameID: "retry")
        let failed = try coordinator.observe(
            visual: true, afterRevision: nil, maximumWaitMilliseconds: 1_000)
        XCTAssertNil(failed.image)
        XCTAssertEqual(attempts.value, 1)
        let retried = try coordinator.observe(
            visual: true, afterRevision: nil, maximumWaitMilliseconds: 1_000)
        XCTAssertEqual(retried.image, Data([7]))
        XCTAssertEqual(attempts.value, 2)
    }

    func testObservationCoordinatorSettlesAndKeepsOnlyTheNewestPreparedFrame() throws {
        let coordinator = ObservationCoordinator()
        coordinator.ingest(try pixelBuffer(red: 255, green: 0, blue: 0), frameID: "one")
        let first = try coordinator.observe(
            visual: true,
            afterRevision: nil,
            maximumWaitMilliseconds: 1_000
        )
        XCTAssertEqual(first.frameRevision, 1)
        XCTAssertEqual(first.imageRevision, 1)
        XCTAssertEqual(first.frameID, "one")
        XCTAssertTrue(first.stable)
        XCTAssertNotNil(first.image)

        coordinator.ingest(try pixelBuffer(red: 255, green: 0, blue: 0), frameID: "one-again")
        let unchanged = try coordinator.observe(
            visual: true,
            afterRevision: first.frameRevision,
            maximumWaitMilliseconds: 1_000
        )
        XCTAssertEqual(unchanged.frameRevision, 2)
        XCTAssertEqual(unchanged.changeRevision, 1)
        XCTAssertEqual(unchanged.imageRevision, 1)
        XCTAssertEqual(unchanged.image, first.image)

        coordinator.ingest(try pixelBuffer(red: 0, green: 0, blue: 255), frameID: "two")
        let second = try coordinator.observe(
            visual: true,
            afterRevision: unchanged.frameRevision,
            maximumWaitMilliseconds: 1_000
        )
        XCTAssertEqual(second.frameRevision, 3)
        XCTAssertEqual(second.changeRevision, 2)
        XCTAssertEqual(second.imageRevision, 2)
        XCTAssertEqual(second.frameID, "two")
        XCTAssertNotEqual(first.image, second.image)

        coordinator.clear()
        XCTAssertThrowsError(
            try coordinator.observe(visual: false, afterRevision: nil, maximumWaitMilliseconds: 0)
        )
    }

    func testAccessibilitySelectorRequiresAMatchingField() throws {
        XCTAssertThrowsError(try validateAccessibilitySelector([:]))
        XCTAssertNoThrow(try validateAccessibilitySelector(["identifier": "submit"]))
        XCTAssertNoThrow(try validateAccessibilitySelector(["placeholder": "Merchant"]))
        XCTAssertThrowsError(try validateAccessibilitySelector(["exact": true]))
    }

    func testFindsFocalUIKitApplicationBundleID() {
        let domain = """
            50359 - UIKitApplication:com.example.app[06ff][rb-legacy]
            4747 - UIKitApplication:com.apple.mobilecal[e65c][rb-legacy]
            """
        XCTAssertEqual(
            ProbeCoordinator.applicationServiceLabels(domain),
            [
                "UIKitApplication:com.example.app[06ff][rb-legacy]",
                "UIKitApplication:com.apple.mobilecal[e65c][rb-legacy]",
            ]
        )
        XCTAssertEqual(
            ProbeCoordinator.focalBundleID(
                """
                state = running
                bundle id = com.example.app
                spawn role = ui focal (1)
                """),
            "com.example.app"
        )
        XCTAssertNil(
            ProbeCoordinator.focalBundleID(
                """
                bundle id = com.example.background
                spawn role = background (2)
                """)
        )
    }

    func testFragmentedFrames() throws {
        let encoded = WireFrame(kind: .response, payload: Data("hello".utf8)).encoded
        var decoder = FrameDecoder()
        XCTAssertTrue(try decoder.append(encoded.prefix(3)).isEmpty)
        let frames = try decoder.append(encoded.dropFirst(3))
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].kind, .response)
        XCTAssertEqual(String(data: frames[0].payload, encoding: .utf8), "hello")
    }

    func testRejectsOversizedFrame() {
        var data = Data([FrameKind.request.rawValue])
        var length = UInt32(FrameDecoder.maximumPayload + 1).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        var decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.append(data))
    }

    func testCodecNegotiationHonorsClientPreference() {
        XCTAssertEqual(preferredCodec(["h264", "mjpeg"]), "h264")
        XCTAssertEqual(preferredCodec(["mjpeg", "h264"]), "mjpeg")
        XCTAssertEqual(preferredCodec(["av1", "mjpeg"]), "mjpeg")
        XCTAssertEqual(preferredCodec([]), "mjpeg")
    }

    func testADBDeviceParserRetainsTransportStatesAndAttributes() {
        let records = ADBClient.parseDevices(
            """
            List of devices attached
            emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1
            R58M1234 unauthorized usb:1-2 transport_id:2
            192.168.1.2:37123 offline transport_id:3

            """)
        XCTAssertEqual(records.count, 3)
        XCTAssertEqual(records[0].serial, "emulator-5554")
        XCTAssertEqual(records[0].attributes["model"], "sdk_gphone64_arm64")
        XCTAssertEqual(records[1].state, "unauthorized")
        XCTAssertEqual(records[2].serial, "192.168.1.2:37123")
    }

    func testADBPropertyParserReadsOneCompleteGetpropSnapshot() {
        let properties = AndroidDeviceProvider.parseProperties(
            """
            [ro.build.version.release]: [16]
            [ro.build.version.sdk]: [36]
            [ro.product.model]: [Pixel 9 Pro XL]
            [sys.boot_completed]: [1]
            """)
        XCTAssertEqual(properties["ro.build.version.release"], "16")
        XCTAssertEqual(properties["ro.product.model"], "Pixel 9 Pro XL")
        XCTAssertEqual(properties["sys.boot_completed"], "1")
    }

    func testAndroidDisplayDimensionsFollowCurrentRotation() {
        let portrait = AndroidDeviceProvider.orientedSize(width: 1_344, height: 2_992, rotation: 0)
        XCTAssertEqual(portrait.width, 1_344)
        XCTAssertEqual(portrait.height, 2_992)
        let landscape = AndroidDeviceProvider.orientedSize(width: 1_344, height: 2_992, rotation: 1)
        XCTAssertEqual(landscape.width, 2_992)
        XCTAssertEqual(landscape.height, 1_344)
    }

    func testAndroidDisplayDensityPrefersOverride() {
        XCTAssertEqual(
            AndroidDeviceProvider.parseDisplayDensity(
                "Physical density: 480\nOverride density: 420\n"
            ),
            420
        )
        XCTAssertEqual(AndroidDeviceProvider.parseDisplayDensity("Physical density: 480\n"), 480)
    }

    func testADBResolverHonorsExplicitPathBeforeSDKAndPATH() throws {
        let explicit = try temporaryExecutable("exit 0\n")
        let environment = [
            "SIMVIEW_ADB_PATH": explicit.path,
            "ANDROID_SDK_ROOT": "/not/the/selected/sdk",
            "PATH": "/not/the/selected/path",
        ]
        XCTAssertEqual(ADBResolver.resolve(environment: environment), explicit.path)
    }

    func testADBClientPassesSerialAndArgumentsWithoutAShell() throws {
        let executable = try temporaryExecutable("printf '%s\\n' \"$@\"\n")
        let result = try ADBClient(executable: executable.path).require(
            ["shell", "input", "text", "hello;touch /tmp/not-run"],
            serial: "emulator-5554;also-not-run"
        )
        XCTAssertEqual(
            result.text.split(whereSeparator: \.isNewline).map(String.init),
            ["-s", "emulator-5554;also-not-run", "shell", "input", "text", "hello;touch /tmp/not-run"]
        )
    }

    func testADBClientBoundsOutputAndEnforcesDeadline() throws {
        let verbose = try temporaryExecutable("printf 123456789\n")
        XCTAssertThrowsError(
            try ADBClient(executable: verbose.path).execute([], maximumOutput: 4)
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "ADB_OUTPUT_TOO_LARGE")
        }

        let slow = try temporaryExecutable("exec sleep 5\n")
        XCTAssertThrowsError(
            try ADBClient(executable: slow.path).execute([], timeout: 0.05)
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "ADB_COMMAND_TIMEOUT")
        }
    }

    func testAndroidHierarchyParserMapsSemanticsAndBounds() throws {
        let xml = Data(
            """
            <?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
            <hierarchy rotation="0">
              <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="dev.simview.fixture" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
                <node index="0" text="Continue" resource-id="dev.simview.fixture:id/continue" class="android.widget.Button" package="dev.simview.fixture" content-desc="Continue action" clickable="true" enabled="true" bounds="[100,200][500,320]" />
              </node>
            </hierarchy>
            """.utf8
        )
        let parser = AndroidHierarchyParser(maxNodes: 10)
        let root = try parser.parse(xml)
        XCTAssertEqual(parser.nodeCount, 2)
        let children = try XCTUnwrap(root["children"] as? [[String: Any]])
        XCTAssertEqual(children[0]["identifier"] as? String, "dev.simview.fixture:id/continue")
        XCTAssertEqual(children[0]["label"] as? String, "Continue action")
        XCTAssertEqual((children[0]["bounds"] as? [String: Int])?["width"], 400)
        XCTAssertEqual(children[0]["actions"] as? [String], ["click"])
    }

    func testAndroidPointInspectionReturnsANodeAndSnapshotScopedReference() throws {
        let executable = try temporaryExecutable(
            """
            if [ "$3" = "exec-out" ]; then
              printf '%s' "<hierarchy rotation='0'><node class='android.widget.Button' package='dev.simview.fixture' content-desc='Continue' clickable='true' enabled='true' bounds='[0,0][1080,2400]' /></hierarchy>"
            fi
            exit 0
            """
        )
        let service = AndroidAccessibilityService(
            client: try ADBClient(executable: executable.path),
            serial: "emulator-5554"
        )
        let element = try service.elementAtPoint(x: 0.5, y: 0.5)
        XCTAssertNotNil(element["ref"] as? String)
        XCTAssertTrue((element["ref"] as? String)?.hasPrefix("android:") == true)
        XCTAssertNil(element["element"])
    }

    func testAndroidInteractiveSnapshotRetainsTextOnlyNodes() throws {
        let executable = try temporaryExecutable(
            """
            if [ "$3" = "exec-out" ]; then
              printf '%s' "<hierarchy rotation='0'><node class='android.widget.FrameLayout' bounds='[0,0][1080,2400]'><node text='Welcome back' class='android.widget.TextView' bounds='[40,80][500,160]' /></node></hierarchy>"
            fi
            exit 0
            """
        )
        let service = AndroidAccessibilityService(
            client: try ADBClient(executable: executable.path),
            serial: "emulator-5554"
        )
        let snapshot = try service.snapshot(scope: "interactive")
        let root = try XCTUnwrap(snapshot["root"] as? [String: Any])
        let children = try XCTUnwrap(root["children"] as? [[String: Any]])
        XCTAssertEqual(children.first?["value"] as? String, "Welcome back")
    }

    func testAndroidAccessibilityRetriesADegradedRootOnlyHierarchyTwice() throws {
        let state = FileManager.default.temporaryDirectory
            .appendingPathComponent("simview-android-accessibility-\(UUID().uuidString).count")
        addTeardownBlock { try? FileManager.default.removeItem(at: state) }
        let executable = try temporaryExecutable(
            """
            if [ "$3" = "exec-out" ]; then
              count=0
              if [ -f "\(state.path)" ]; then count=$(cat "\(state.path)"); fi
              count=$((count + 1))
              printf '%s' "$count" > "\(state.path)"
              if [ "$count" -lt 3 ]; then
                printf '%s' "<hierarchy rotation='0'><node class='android.widget.FrameLayout' bounds='[0,0][0,0]' /></hierarchy>"
              else
                printf '%s' "<hierarchy rotation='0'><node class='android.widget.FrameLayout' bounds='[0,0][1080,2400]'><node text='Continue' class='android.widget.Button' clickable='true' enabled='true' bounds='[100,200][500,320]' /></node></hierarchy>"
              fi
            fi
            exit 0
            """
        )
        let service = AndroidAccessibilityService(
            client: try ADBClient(executable: executable.path),
            serial: "emulator-5554"
        )

        let snapshot = try service.snapshot(scope: "interactive", timeout: 3)
        let stats = try XCTUnwrap(snapshot["stats"] as? [String: Any])
        XCTAssertEqual(snapshot["source"] as? String, "android-uiautomator")
        XCTAssertEqual(stats["quality"] as? String, "complete")
        XCTAssertEqual(try String(contentsOf: state, encoding: .utf8), "3")
    }

    func testAndroidScreenshotRejectsUndecodablePNGPayload() throws {
        let executable = try temporaryExecutable("printf '\\211PNGnot-an-image'\n")
        let capture = AndroidFrameCapture(
            client: try ADBClient(executable: executable.path),
            serial: "emulator-5554"
        )
        XCTAssertThrowsError(try capture.screenshot()) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "ANDROID_SCREENSHOT_INVALID")
        }
    }

    func testAndroidShellTextFallbackQuotesRemoteMetacharacters() throws {
        let executable = try temporaryExecutable(
            """
            [ "$4" = "input text 'hello;touch%s/tmp/pwn'" ] || exit 9
            exit 0
            """
        )
        let device = DeviceDescription(
            id: "android:emulator-5554",
            platform: .android,
            kind: .emulator,
            nativeIdentifier: "emulator-5554",
            name: "Android",
            state: "ready",
            runtime: "Android",
            available: true,
            pixelWidth: 1080,
            pixelHeight: 2400,
            metadata: [:]
        )
        let controller = AndroidController(
            client: try ADBClient(executable: executable.path),
            device: device
        )
        XCTAssertEqual(try controller.typeText("hello;touch /tmp/pwn"), "adb-input-text")
    }

    func testAndroidForegroundComponentParsesCurrentActivityFormats() throws {
        let current = try XCTUnwrap(
            AndroidAccessibilityService.foregroundComponent(
                in: "topResumedActivity=ActivityRecord{42 u0 dev.simview.fixture/.MainActivity t7}"
            )
        )
        XCTAssertEqual(current.package, "dev.simview.fixture")
        XCTAssertEqual(current.activity, ".MainActivity")

        let legacy = try XCTUnwrap(
            AndroidAccessibilityService.foregroundComponent(
                in: "mCurrentFocus=Window{42 u0 dev.simview.fixture/dev.simview.fixture.LegacyActivity}"
            )
        )
        XCTAssertEqual(legacy.package, "dev.simview.fixture")
        XCTAssertEqual(legacy.activity, "dev.simview.fixture.LegacyActivity")
    }

    func testAndroidRotationParserAcceptsLegacyAndCurrentDumpsysFormats() {
        XCTAssertEqual(AndroidController.parseRotation("SurfaceOrientation: 3"), 3)
        XCTAssertEqual(AndroidController.parseRotation("mDisplayRotation=ROTATION_90"), 1)
        XCTAssertEqual(AndroidController.parseRotation("mCurrentRotation=ROTATION_270"), 3)
        XCTAssertEqual(AndroidController.parseRotation("header\n  mRotation=2\nfooter"), 2)
        XCTAssertNil(AndroidController.parseRotation("mCurrentRotation=ROTATION_UNKNOWN"))
    }

    func testAndroidRotationParserIgnoresCaptureVirtualDisplay() {
        let output = """
            mDisplayRotation=ROTATION_0
              displayId=23
              mCurrentRotation=ROTATION_0
            mDisplayRotation=ROTATION_90
              displayId=0
              mCurrentRotation=ROTATION_90
            """
        XCTAssertEqual(AndroidController.parseRotation(output), 0)
        XCTAssertEqual(AndroidController.parseDefaultDisplayRotation(output), 1)
    }

    func testAndroidH264NormalizerBuildsAVCCConfigurationAndFrames() throws {
        let sps = Data([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1E, 0xAA])
        let pps = Data([0, 0, 1, 0x68, 0xCE, 0x3C, 0x80])
        let configuration = try H264Normalizer.configuration(csd0: sps, csd1: pps)
        XCTAssertEqual(configuration.prefix(6), Data([1, 0x42, 0, 0x1E, 0xFF, 0xE1]))

        let annexB = Data([0, 0, 0, 1, 0x65, 1, 2, 0, 0, 1, 0x06, 3])
        XCTAssertEqual(
            try H264Normalizer.accessUnit(annexB),
            Data([0, 0, 0, 3, 0x65, 1, 2, 0, 0, 0, 2, 0x06, 3])
        )
        let avcc = Data([0, 0, 0, 2, 0x61, 7, 0, 0, 0, 2, 0x06, 8])
        XCTAssertEqual(try H264Normalizer.accessUnit(avcc), avcc)
        var ambiguousAVCC = Data([0, 0, 1, 44])
        ambiguousAVCC.append(Data(repeating: 0x61, count: 300))
        XCTAssertEqual(try H264Normalizer.accessUnit(ambiguousAVCC), ambiguousAVCC)
    }

    func testAndroidAgentHandshakeRejectsVersionOrAuthenticationFailure() throws {
        XCTAssertNoThrow(
            try AndroidAgentHandshake.validate(Data([0x53, 0x56, 0x41, 0x31, 0, 0, 0, 4, 0, 0, 0, 0]))
        )
        XCTAssertThrowsError(
            try AndroidAgentHandshake.validate(Data([0x53, 0x56, 0x41, 0x31, 0, 0, 0, 2, 0, 0, 0, 0]))
        )
        XCTAssertThrowsError(
            try AndroidAgentHandshake.validate(Data([0x53, 0x56, 0x41, 0x31, 0, 0, 0, 4, 0, 0, 0, 1]))
        )
    }

    func testH264EncoderAcceptsABGRAPixelBuffer() async throws {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            320,
            180,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
            &pixelBuffer
        )
        XCTAssertEqual(status, kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixelBuffer)
        let encoder = H264Encoder()
        let encoded = try await encoder.encode(buffer)
        XCTAssertFalse(encoded.bytes.isEmpty)
        XCTAssertTrue(encoded.keyframe)
        await encoder.stop()
    }

    func testH264DecoderProducesABGRAObservationFrame() async throws {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            160,
            90,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
            &pixelBuffer
        )
        XCTAssertEqual(status, kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixelBuffer)
        let encoder = H264Encoder()
        let encoded = try await encoder.encode(buffer)
        let configuration = try XCTUnwrap(encoded.configuration)
        let decoded = expectation(description: "decoded Android H.264 frame")
        let decoder = H264Decoder()
        try decoder.configure(configuration) { frame, _ in
            XCTAssertEqual(CVPixelBufferGetPixelFormatType(frame), kCVPixelFormatType_32BGRA)
            XCTAssertEqual(CVPixelBufferGetWidth(frame), 160)
            XCTAssertEqual(CVPixelBufferGetHeight(frame), 90)
            decoded.fulfill()
        }
        decoder.decode(encoded.bytes, timestampMicros: 1_000)
        await fulfillment(of: [decoded], timeout: 2)
        decoder.stop()
        await encoder.stop()
    }
}
