import CoreVideo
import Darwin
import XCTest

@testable import SimViewCore

final class ProtocolTests: XCTestCase {
    private func coreDeviceRecord(
        udid: String = "00008110-001234560123401E",
        platform: String = "iOS",
        reality: String = "physical",
        pairing: String = "paired",
        developerMode: String = "enabled",
        transport: String = "wired",
        locked: Bool? = false
    ) -> [String: Any] {
        var deviceProperties: [String: Any] = [
            "name": "Test iPhone",
            "osVersionNumber": "26.0",
            "developerModeStatus": developerMode,
            "ddiServicesAvailable": true,
        ]
        if let locked { deviceProperties["isLocked"] = locked }
        return [
            "identifier": "A3A9A44B-49B0-46AA-A12C-A78815B16BE7",
            "visibilityClass": "default",
            "connectionProperties": [
                "pairingState": pairing,
                "transportType": transport,
                "tunnelState": "connected",
            ],
            "deviceProperties": deviceProperties,
            "hardwareProperties": [
                "platform": platform,
                "reality": reality,
                "udid": udid,
                "marketingName": "iPhone 17 Pro",
                "productType": "iPhone18,1",
                "hardwareModel": "V53AP",
            ],
        ]
    }

    private func coreDeviceJSON(_ devices: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "info": ["jsonVersion": 3, "outcome": "success"],
            "result": ["devices": devices],
        ])
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

    func testAccessibilitySelectorRequiresAMatchingField() throws {
        XCTAssertThrowsError(try validateAccessibilitySelector([:]))
        XCTAssertNoThrow(try validateAccessibilitySelector(["identifier": "submit"]))
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

    func testCoreDeviceParserReturnsOnlyPhysicalIOSDevices() throws {
        let devices = try IOSPhysicalDeviceProvider.parseDevices(
            coreDeviceJSON([
                coreDeviceRecord(),
                coreDeviceRecord(udid: "SIMULATOR-UDID", reality: "simulator"),
                coreDeviceRecord(udid: "ANDROID-UDID", platform: "android"),
            ]),
            runnerReadiness: { _ in "prepared" }
        )

        XCTAssertEqual(devices.count, 1)
        let device = try XCTUnwrap(devices.first)
        XCTAssertEqual(device.id, "ios:00008110-001234560123401E")
        XCTAssertEqual(device.nativeIdentifier, "00008110-001234560123401E")
        XCTAssertEqual(device.kind, .physical)
        XCTAssertEqual(device.state, "ready")
        XCTAssertTrue(device.available)
        XCTAssertEqual(device.runtime, "iOS 26.0")
        XCTAssertEqual(device.metadata["runnerReady"], "prepared")
        XCTAssertEqual(device.metadata["coreDeviceIdentifier"], "A3A9A44B-49B0-46AA-A12C-A78815B16BE7")
    }

    func testCoreDeviceProviderConsumesDocumentedJSONFileInsteadOfStdout() throws {
        let fixture = try coreDeviceJSON([coreDeviceRecord()])
        let provider = IOSPhysicalDeviceProvider(command: { executable, arguments in
            guard executable == "/usr/bin/xcrun",
                let option = arguments.firstIndex(of: "--json-output"),
                arguments.indices.contains(option + 1)
            else {
                return ProcessResult(status: 1, output: "", error: "Missing JSON output path")
            }
            do {
                try fixture.write(to: URL(fileURLWithPath: arguments[option + 1]))
                return ProcessResult(status: 0, output: "not JSON", error: "")
            } catch {
                return ProcessResult(status: 1, output: "", error: error.localizedDescription)
            }
        })

        XCTAssertEqual(try provider.devices().map(\.id), ["ios:00008110-001234560123401E"])
    }

    func testPhysicalIOSCapabilitiesNeverAdvertiseSimulatorOnlyPaths() throws {
        let device = try XCTUnwrap(
            IOSPhysicalDeviceProvider.parseDevices(coreDeviceJSON([coreDeviceRecord()])).first
        )
        let capabilities = device.capabilities
        let capture = try XCTUnwrap(capabilities["capture"] as? [String: Bool])
        let input = try XCTUnwrap(capabilities["input"] as? [String: Any])

        XCTAssertEqual(capture["h264"], true)
        XCTAssertEqual(capture["mjpeg"], false)
        XCTAssertEqual(input["rawTouch"] as? Bool, false)
        XCTAssertEqual(input["buttons"] as? [String], [])
        XCTAssertEqual(capabilities["uikitProbe"] as? Bool, false)
        XCTAssertEqual(capabilities["androidContext"] as? Bool, false)
    }

    func testCoreDeviceParserPreservesTruthfulUnavailableStates() throws {
        let records = [
            coreDeviceRecord(udid: "LOCKED", locked: true),
            coreDeviceRecord(udid: "UNPAIRED", pairing: "unpaired"),
            coreDeviceRecord(udid: "DEVMODE", developerMode: "disabled"),
            coreDeviceRecord(udid: "WIRELESS", transport: "localNetwork"),
            coreDeviceRecord(udid: "UNKNOWN", pairing: ""),
        ]
        let devices = try IOSPhysicalDeviceProvider.parseDevices(coreDeviceJSON(records))

        XCTAssertEqual(
            devices.map(\.state),
            ["locked", "unpaired", "developer-mode-disabled", "unsupported-transport", "unknown"]
        )
        XCTAssertTrue(devices.allSatisfy { !$0.available })
    }

    func testUSBMuxIsAuthoritativeWhenCoreDeviceLabelsWiredDeviceAsLocalNetwork() throws {
        let device = try XCTUnwrap(
            IOSPhysicalDeviceProvider.parseDevices(
                coreDeviceJSON([coreDeviceRecord(transport: "localNetwork")]),
                usbConnected: { $0 == "00008110-001234560123401E" }
            ).first
        )

        XCTAssertEqual(device.state, "ready")
        XCTAssertTrue(device.available)
        XCTAssertEqual(device.metadata["transport"], "localNetwork")
        XCTAssertEqual(device.metadata["usbmuxUSB"], "true")
    }

    func testCoreDeviceParserRejectsMalformedAndUnboundedIdentifiers() throws {
        XCTAssertThrowsError(try IOSPhysicalDeviceProvider.parseDevices(Data("not json".utf8))) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "IOS_DEVICE_DISCOVERY_INVALID")
        }
        XCTAssertThrowsError(try IOSPhysicalDeviceProvider.parseDevices(Data("{}".utf8))) { error in
            XCTAssertEqual((error as? SimViewError)?.code, "IOS_DEVICE_DISCOVERY_INVALID")
        }
        let devices = try IOSPhysicalDeviceProvider.parseDevices(
            coreDeviceJSON([
                coreDeviceRecord(udid: "../../not-a-device"),
                coreDeviceRecord(udid: String(repeating: "A", count: 257)),
            ])
        )
        XCTAssertTrue(devices.isEmpty)
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
            try AndroidAgentHandshake.validate(Data([0x53, 0x56, 0x41, 0x31, 0, 0, 0, 2, 0, 0, 0, 0]))
        )
        XCTAssertThrowsError(
            try AndroidAgentHandshake.validate(Data([0x53, 0x56, 0x41, 0x31, 0, 0, 0, 1, 0, 0, 0, 0]))
        )
        XCTAssertThrowsError(
            try AndroidAgentHandshake.validate(Data([0x53, 0x56, 0x41, 0x31, 0, 0, 0, 2, 0, 0, 0, 1]))
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
}
