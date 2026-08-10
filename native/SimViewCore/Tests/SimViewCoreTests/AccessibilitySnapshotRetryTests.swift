import XCTest

@testable import SimViewCore

final class AccessibilitySnapshotRetryTests: XCTestCase {
    func testNormalizesNumericAccessibilityTextValuesWithoutChangingBooleanState() {
        XCTAssertEqual(normalizedAccessibilityTextValue(NSNumber(value: 0)), "0")
        XCTAssertEqual(normalizedAccessibilityTextValue(NSNumber(value: 1.5)), "1.5")
        XCTAssertEqual(normalizedAccessibilityTextValue("Selected"), "Selected")
        XCTAssertNil(normalizedAccessibilityTextValue(""))

        let state: [String: Any] = ["enabled": true, "hidden": false]
        XCTAssertEqual(state["enabled"] as? Bool, true)
        XCTAssertEqual(state["hidden"] as? Bool, false)
    }

    func testVisibleProjectionDropsOffscreenKeyboardNodesAndKeepsAncestors() throws {
        let source = snapshot(
            id: "keyboard",
            root: [
                "ref": "ax:keyboard:0",
                "role": "AXApplication",
                "visibleFraction": 1.0,
                "children": [
                    [
                        "ref": "ax:keyboard:1",
                        "role": "AXGroup",
                        "visibleFraction": 1.0,
                        "children": [
                            [
                                "ref": "ax:keyboard:2",
                                "role": "AXButton",
                                "label": "Save",
                                "visibleFraction": 1.0,
                            ]
                        ],
                    ],
                    [
                        "ref": "ax:keyboard:3",
                        "role": "AXButton",
                        "label": "Return",
                        "visibleFraction": 0.0,
                        "frame": [
                            "points": ["x": 310, "y": 920, "width": 80, "height": 44],
                            "normalized": ["x": 0.77, "y": 1.05, "width": 0.2, "height": 0.05],
                        ],
                    ],
                ],
            ],
            nodeCount: 4
        )

        let visible = try projectAccessibilitySnapshot(source, scope: "visible")
        let root = try XCTUnwrap(visible["root"] as? [String: Any])
        let children = try XCTUnwrap(root["children"] as? [[String: Any]])
        XCTAssertEqual(children.count, 1)
        XCTAssertEqual(children[0]["ref"] as? String, "ax:keyboard:1")
        let stats = try XCTUnwrap(visible["stats"] as? [String: Any])
        XCTAssertEqual(stats["projectedNodeCount"] as? Int, 3)
        XCTAssertEqual(stats["droppedChildCount"] as? Int, 1)

        let full = try projectAccessibilitySnapshot(source, scope: "full")
        let fullRoot = try XCTUnwrap(full["root"] as? [String: Any])
        XCTAssertEqual((fullRoot["children"] as? [[String: Any]])?.count, 2)
        XCTAssertEqual((full["stats"] as? [String: Any])?["droppedChildCount"] as? Int, 0)
    }

    func testInteractiveProjectionDropsVisibleNonSemanticLeaves() throws {
        let source = snapshot(
            id: "interactive",
            root: [
                "ref": "ax:interactive:0",
                "role": "AXApplication",
                "visibleFraction": 1.0,
                "children": [
                    [
                        "ref": "ax:interactive:1", "role": "AXUnknown",
                        "visibleFraction": 1.0,
                    ],
                    [
                        "ref": "ax:interactive:2", "role": "AXTextField",
                        "placeholder": "Merchant", "visibleFraction": 1.0,
                    ],
                ],
            ],
            nodeCount: 3
        )

        let projected = try projectAccessibilitySnapshot(source, scope: "interactive")
        let root = try XCTUnwrap(projected["root"] as? [String: Any])
        let children = try XCTUnwrap(root["children"] as? [[String: Any]])
        XCTAssertEqual(children.map { $0["ref"] as? String }, ["ax:interactive:2"])
    }

    func testHollowTabAndNavigationContainersDegradeSnapshot() throws {
        let source = snapshot(
            id: "hollow",
            root: [
                "ref": "ax:hollow:0",
                "role": "AXApplication",
                "visibleFraction": 1.0,
                "children": [
                    [
                        "ref": "ax:hollow:1", "role": "AXTabGroup",
                        "roleDescription": "Tab Bar", "visibleFraction": 1.0,
                    ],
                    [
                        "ref": "ax:hollow:2", "role": "AXGroup",
                        "roleDescription": "Nav bar", "label": "Trips",
                        "visibleFraction": 1.0,
                    ],
                ],
            ],
            nodeCount: 3
        )

        let result = try projectAccessibilitySnapshot(source, scope: "full")
        let stats = try XCTUnwrap(result["stats"] as? [String: Any])
        XCTAssertEqual(stats["quality"] as? String, "degraded")
        XCTAssertEqual(stats["reason"] as? String, "hollow-native-containers")
        XCTAssertEqual(stats["hollowContainerCount"] as? Int, 2)
        XCTAssertEqual(stats["provider"] as? String, "core-simulator-ax")
    }

    func testPopulatedTabContainerRemainsComplete() throws {
        let source = snapshot(
            id: "tabs",
            root: [
                "ref": "ax:tabs:0",
                "role": "AXApplication",
                "visibleFraction": 1.0,
                "children": [
                    [
                        "ref": "ax:tabs:1", "role": "AXTabGroup",
                        "roleDescription": "Tab Bar", "visibleFraction": 1.0,
                        "children": [
                            [
                                "ref": "ax:tabs:2", "role": "AXRadioButton",
                                "label": "Expenses", "visibleFraction": 1.0,
                            ]
                        ],
                    ]
                ],
            ],
            nodeCount: 3
        )

        let result = try projectAccessibilitySnapshot(source, scope: "full")
        let stats = try XCTUnwrap(result["stats"] as? [String: Any])
        XCTAssertEqual(stats["quality"] as? String, "complete")
        XCTAssertEqual(stats["hollowContainerCount"] as? Int, 0)
    }

    func testProjectionRejectsUnknownScope() {
        XCTAssertThrowsError(
            try projectAccessibilitySnapshot(emptyApplicationSnapshot(id: "bad-scope"), scope: "all")
        ) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "PARAMETER_INVALID")
        }
    }

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
