import XCTest

@testable import SimViewCore

final class AccessibilitySnapshotRetryTests: XCTestCase {
    func testRetriesATransientRootOnlyApplicationAndReturnsTheRecoveredTree() throws {
        var attempts = 0
        var delays = 0
        let recovered = try captureAccessibilitySnapshotWithRetry(
            maximumAttempts: 3,
            delay: { delays += 1 }
        ) {
            attempts += 1
            if attempts < 3 { return self.emptyApplicationSnapshot(id: "placeholder-\(attempts)") }
            return self.snapshot(
                id: "recovered",
                root: [
                    "ref": "ax:recovered:0",
                    "role": "AXApplication",
                    "children": [["ref": "ax:recovered:1", "role": "AXButton"]],
                ],
                nodeCount: 2
            )
        }

        XCTAssertEqual(attempts, 3)
        XCTAssertEqual(delays, 2)
        XCTAssertEqual(recovered["snapshotId"] as? String, "recovered")
    }

    func testPersistentRootOnlyApplicationIsReturnedAsDegradedAfterTheBoundedRetry() throws {
        var attempts = 0
        let result = try captureAccessibilitySnapshotWithRetry(
            maximumAttempts: 3,
            delay: {}
        ) {
            attempts += 1
            return self.emptyApplicationSnapshot(id: "placeholder-\(attempts)")
        }

        let stats = try XCTUnwrap(result["stats"] as? [String: Any])
        XCTAssertEqual(attempts, 3)
        XCTAssertEqual(stats["quality"] as? String, "degraded")
        XCTAssertEqual(stats["reason"] as? String, "root-only-application")
    }

    func testDoesNotRetryAValidLeafApplication() throws {
        var attempts = 0
        let leaf = snapshot(
            id: "leaf",
            root: [
                "ref": "ax:leaf:0",
                "role": "AXApplication",
                "label": "Single-view application",
                "enabled": true,
            ],
            nodeCount: 1
        )
        let result = try captureAccessibilitySnapshotWithRetry(
            maximumAttempts: 3,
            delay: { XCTFail("A valid leaf application must not be delayed") }
        ) {
            attempts += 1
            return leaf
        }

        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(result["snapshotId"] as? String, "leaf")
    }

    func testDoesNotRetryAnIntentionallyTruncatedRoot() throws {
        var attempts = 0
        var truncated = emptyApplicationSnapshot(id: "budget-one")
        truncated["stats"] = ["nodeCount": 1, "truncated": true, "quality": "partial"]
        _ = try captureAccessibilitySnapshotWithRetry(maximumAttempts: 3, delay: {}) {
            attempts += 1
            return truncated
        }

        XCTAssertEqual(attempts, 1)
    }

    func testDoesNotRetryACaptureError() throws {
        var attempts = 0
        XCTAssertThrowsError(
            try captureAccessibilitySnapshotWithRetry(maximumAttempts: 3, delay: {}) {
                attempts += 1
                throw NSError(domain: "test", code: 1)
            }
        )
        XCTAssertEqual(attempts, 1)
    }

    private func emptyApplicationSnapshot(id: String) -> [String: Any] {
        snapshot(
            id: id,
            root: [
                "ref": "ax:\(id):0",
                "role": "AXApplication",
                "enabled": false,
                "frame": [
                    "points": ["x": 0, "y": 0, "width": 0, "height": 0],
                    "normalized": ["x": 0, "y": 0, "width": 0, "height": 0],
                ],
            ],
            nodeCount: 1
        )
    }

    private func snapshot(id: String, root: [String: Any], nodeCount: Int) -> [String: Any] {
        [
            "schemaVersion": 1,
            "snapshotId": id,
            "capturedAt": "2026-08-08T10:00:00.000Z",
            "source": "core-simulator-ax",
            "screen": ["x": 0, "y": 0, "width": 402, "height": 874],
            "root": root,
            "stats": ["nodeCount": nodeCount, "truncated": false, "quality": "complete"],
        ]
    }
}
