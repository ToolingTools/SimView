import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO

final class AndroidFrameCapture: @unchecked Sendable {
    typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime, String) -> Void

    private let client: ADBClient
    private let serial: String
    private let queue = DispatchQueue(label: "dev.simview.android.capture", qos: .userInteractive)
    private var timer: DispatchSourceTimer?
    private var sequence: UInt64 = 0
    private let stateLock = NSLock()
    private var generation: UInt64 = 0
    private var active = false
    private var capturedWidth = 0
    private var capturedHeight = 0

    var width: Int { dimensions.width }
    var height: Int { dimensions.height }

    private var dimensions: (width: Int, height: Int) {
        stateLock.lock()
        defer { stateLock.unlock() }
        return (capturedWidth, capturedHeight)
    }

    init(client: ADBClient, serial: String) {
        self.client = client
        self.serial = serial
    }

    func start(handler: @escaping FrameHandler) {
        stop()
        stateLock.lock()
        generation &+= 1
        let generation = generation
        active = true
        stateLock.unlock()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(250), leeway: .milliseconds(25))
        timer.setEventHandler { [weak self] in
            guard let self,
                let captured = try? self.capture(cancelled: { !self.isActive(generation) }),
                let pixelBuffer = Self.pixelBuffer(from: captured.image)
            else { return }
            self.sequence &+= 1
            handler(pixelBuffer, CMClockGetTime(CMClockGetHostTimeClock()), String(self.sequence))
        }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        stateLock.lock()
        generation &+= 1
        active = false
        stateLock.unlock()
        timer?.cancel()
        timer = nil
    }

    func screenshot() throws -> Data {
        try capture().data
    }

    private func capture(cancelled: @escaping @Sendable () -> Bool = { false }) throws -> (data: Data, image: CGImage) {
        let result = try client.require(
            ["exec-out", "screencap", "-p"], serial: serial, cancelled: cancelled)
        guard result.output.starts(with: [0x89, 0x50, 0x4E, 0x47]) else {
            throw SimViewError("ANDROID_SCREENSHOT_INVALID", "ADB screencap did not return a PNG image")
        }
        guard let source = CGImageSourceCreateWithData(result.output as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw SimViewError("ANDROID_SCREENSHOT_INVALID", "ADB screencap returned an invalid PNG image")
        }
        stateLock.lock()
        capturedWidth = image.width
        capturedHeight = image.height
        stateLock.unlock()
        return (result.output, image)
    }

    private func isActive(_ generation: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return active && self.generation == generation
    }

    private static func pixelBuffer(from image: CGImage) -> CVPixelBuffer? {
        var buffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:],
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        guard
            CVPixelBufferCreate(
                kCFAllocatorDefault,
                image.width,
                image.height,
                kCVPixelFormatType_32BGRA,
                attributes as CFDictionary,
                &buffer
            ) == kCVReturnSuccess, let buffer
        else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer),
            let context = CGContext(
                data: base,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue
                    | CGImageAlphaInfo.premultipliedFirst.rawValue
            )
        else { return nil }
        context.translateBy(x: 0, y: CGFloat(image.height))
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return buffer
    }
}

final class AndroidController: @unchecked Sendable {
    private let client: ADBClient
    private let device: DeviceDescription
    private var displayWidth: Int
    private var displayHeight: Int
    private var originalUserRotation: String?
    private var originalFixedToUserRotation: String?

    init(client: ADBClient, device: DeviceDescription) {
        self.client = client
        self.device = device
        displayWidth = device.pixelWidth ?? 0
        displayHeight = device.pixelHeight ?? 0
    }

    func updateDisplayDimensions(width: Int, height: Int) {
        displayWidth = width
        displayHeight = height
    }

    func stop() {
        if let originalUserRotation {
            let arguments: [String]
            if originalUserRotation == "free" {
                arguments = ["shell", "cmd", "window", "user-rotation", "-d", "0", "free"]
            } else {
                let fields = originalUserRotation.split(whereSeparator: \.isWhitespace).map(String.init)
                if fields.count == 2, fields[0] == "lock", Int(fields[1]).map({ (0...3).contains($0) }) == true {
                    arguments = ["shell", "cmd", "window", "user-rotation", "-d", "0", "lock", fields[1]]
                } else {
                    arguments = []
                }
            }
            if !arguments.isEmpty {
                _ = try? client.execute(arguments, serial: device.nativeIdentifier, timeout: 5)
            }
        }
        if let originalFixedToUserRotation,
            ["default", "enabled", "disabled", "enabled_if_no_auto_rotation"]
                .contains(originalFixedToUserRotation)
        {
            _ = try? client.execute(
                [
                    "shell", "cmd", "window", "fixed-to-user-rotation", "-d", "0",
                    originalFixedToUserRotation,
                ],
                serial: device.nativeIdentifier,
                timeout: 5
            )
        }
        originalUserRotation = nil
        originalFixedToUserRotation = nil
    }

    func tap(x: Double, y: Double, duration: Double = 0.05) throws {
        let point = try coordinates(x: x, y: y)
        if duration >= 0.4 {
            _ = try client.require(
                [
                    "shell", "input", "swipe", "\(point.x)", "\(point.y)", "\(point.x)", "\(point.y)",
                    "\(Int(duration * 1_000))",
                ],
                serial: device.nativeIdentifier
            )
        } else {
            _ = try client.require(
                ["shell", "input", "tap", "\(point.x)", "\(point.y)"],
                serial: device.nativeIdentifier
            )
        }
    }

    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double, duration: Double) throws {
        let from = try coordinates(x: fromX, y: fromY)
        let to = try coordinates(x: toX, y: toY)
        _ = try client.require(
            [
                "shell", "input", "swipe", "\(from.x)", "\(from.y)", "\(to.x)", "\(to.y)",
                "\(Int(max(0.05, duration) * 1_000))",
            ],
            serial: device.nativeIdentifier
        )
    }

    func typeText(_ text: String) throws -> String {
        guard !text.contains("\0") else {
            throw SimViewError("PARAMETER_INVALID", "Text input cannot contain a null byte")
        }
        guard text.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7E }) else {
            throw SimViewError("INPUT_TEXT_UNSUPPORTED", "ADB shell fallback supports ASCII text only")
        }
        let encoded = text.replacingOccurrences(of: " ", with: "%s")
        let quoted = "'" + encoded.replacingOccurrences(of: "'", with: "'\\''") + "'"
        _ = try client.require(["shell", "input text \(quoted)"], serial: device.nativeIdentifier)
        return "adb-input-text"
    }

    func pressButton(_ button: String) throws {
        let keyCode: String
        switch button {
        case "back": keyCode = "KEYCODE_BACK"
        case "home": keyCode = "KEYCODE_HOME"
        case "overview", "appSwitch": keyCode = "KEYCODE_APP_SWITCH"
        case "power", "lock": keyCode = "KEYCODE_POWER"
        case "volume-up", "volumeUp": keyCode = "KEYCODE_VOLUME_UP"
        case "volume-down", "volumeDown": keyCode = "KEYCODE_VOLUME_DOWN"
        default:
            throw SimViewError("INPUT_BUTTON_UNSUPPORTED", "Android does not support button \(button)")
        }
        _ = try client.require(["shell", "input", "keyevent", keyCode], serial: device.nativeIdentifier)
    }

    func key(usage: UInt32, down: Bool) throws {
        guard down else { return }
        _ = try client.require(
            ["shell", "input", "keyevent", "\(usage)"],
            serial: device.nativeIdentifier
        )
    }

    func setOrientation(_ orientation: String) throws {
        guard device.kind == .emulator else {
            throw SimViewError(
                "ORIENTATION_UNSUPPORTED",
                "Orientation control is available only for Android emulators"
            )
        }
        let desired: Int
        switch orientation {
        case "portrait": desired = 0
        case "landscape-right", "landscapeRight": desired = 1
        case "portrait-upside-down", "portraitUpsideDown": desired = 2
        case "landscape-left", "landscapeLeft": desired = 3
        default:
            throw SimViewError("PARAMETER_INVALID", "Unknown orientation \(orientation)")
        }
        if try currentRotation() == desired { return }
        if originalUserRotation == nil {
            originalUserRotation = try client.require(
                ["shell", "cmd", "window", "user-rotation", "-d", "0"],
                serial: device.nativeIdentifier
            ).text.trimmingCharacters(in: .whitespacesAndNewlines)
            originalFixedToUserRotation = try client.require(
                ["shell", "cmd", "window", "fixed-to-user-rotation", "-d", "0"],
                serial: device.nativeIdentifier
            ).text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // Modern emulator images may honor a foreground activity's requested
        // orientation over sensor changes. Use WindowManager's reversible,
        // emulator-only user-rotation policy and restore both values on stop.
        _ = try client.require(
            ["shell", "cmd", "window", "fixed-to-user-rotation", "-d", "0", "enabled"],
            serial: device.nativeIdentifier
        )
        _ = try client.require(
            ["shell", "cmd", "window", "user-rotation", "-d", "0", "lock", "\(desired)"],
            serial: device.nativeIdentifier
        )
        let deadline = Date().addingTimeInterval(6)
        var observedRotation: Int?
        repeat {
            Thread.sleep(forTimeInterval: 0.2)
            observedRotation = try currentRotation()
            if observedRotation == desired { return }
        } while Date() < deadline
        throw SimViewError(
            "ORIENTATION_FAILED",
            "The Android emulator did not reach rotation \(desired); last observed \(observedRotation.map(String.init) ?? "unknown")"
        )
    }

    private func currentRotation() throws -> Int {
        let displays = try client.require(
            ["shell", "dumpsys", "window", "displays"],
            serial: device.nativeIdentifier
        )
        if let rotation = Self.parseDefaultDisplayRotation(displays.text) { return rotation }

        let input = try client.require(
            ["shell", "dumpsys", "input"],
            serial: device.nativeIdentifier
        )
        if let rotation = Self.parseDefaultDisplayRotation(input.text) { return rotation }

        // Some older WindowManager builds expose rotation only in the complete
        // window dump rather than the display-specific or input dumps.
        let window = try client.require(
            ["shell", "dumpsys", "window", "windows"],
            serial: device.nativeIdentifier
        )
        guard let rotation = Self.parseDefaultDisplayRotation(window.text) else {
            throw SimViewError("ORIENTATION_UNAVAILABLE", "Android did not report its display rotation")
        }
        return rotation
    }

    static func parseRotation(_ output: String) -> Int? {
        let patterns: [(String, (Int) -> Int?)] = [
            (#"SurfaceOrientation:\s*([0-3])"#, { (0...3).contains($0) ? $0 : nil }),
            (
                #"\bmDisplayRotation=ROTATION_(0|90|180|270)\b"#,
                {
                    switch $0 {
                    case 0: return 0
                    case 90: return 1
                    case 180: return 2
                    case 270: return 3
                    default: return nil
                    }
                }
            ),
            (
                #"\bmCurrentRotation=ROTATION_(0|90|180|270)\b"#,
                {
                    switch $0 {
                    case 0: return 0
                    case 90: return 1
                    case 180: return 2
                    case 270: return 3
                    default: return nil
                    }
                }
            ),
            (#"(?m)^\s*mRotation=([0-3])\s*$"#, { (0...3).contains($0) ? $0 : nil }),
        ]
        for (pattern, normalize) in patterns {
            guard let expression = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(output.startIndex..., in: output)
            guard let match = expression.firstMatch(in: output, range: range),
                let valueRange = Range(match.range(at: 1), in: output),
                let value = Int(output[valueRange]),
                let normalized = normalize(value)
            else { continue }
            return normalized
        }
        return nil
    }

    static func parseDefaultDisplayRotation(_ output: String) -> Int? {
        if let expression = try? NSRegularExpression(pattern: #"(?m)^\s*displayId=0\s*$"#) {
            let range = NSRange(output.startIndex..., in: output)
            if let match = expression.firstMatch(in: output, range: range),
                let marker = Range(match.range, in: output)
            {
                // Virtual displays are listed first on current Android builds.
                // Parse only the default-display suffix so their fixed rotation
                // cannot mask the physical display's authoritative state.
                return parseRotation(String(output[marker.upperBound...]))
            }
        }
        return parseRotation(output)
    }

    private func coordinates(x: Double, y: Double) throws -> (x: Int, y: Int) {
        guard (0...1).contains(x), (0...1).contains(y),
            displayWidth > 0, displayHeight > 0
        else {
            throw SimViewError(
                "INPUT_COORDINATES_UNAVAILABLE",
                "Android input requires normalized coordinates and known display bounds"
            )
        }
        return (
            Int((x * Double(max(1, displayWidth - 1))).rounded()),
            Int((y * Double(max(1, displayHeight - 1))).rounded())
        )
    }
}
