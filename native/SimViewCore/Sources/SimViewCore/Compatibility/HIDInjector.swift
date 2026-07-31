import CoreGraphics
import Darwin
import Foundation
import ObjectiveC

final class HIDInjector: @unchecked Sendable {
    private typealias MouseFunction =
        @convention(c) (
            UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?, UInt32, Int32, CGFloat, CGFloat, UInt32
        ) -> UnsafeMutableRawPointer?
    private typealias ButtonFunction =
        @convention(c) (
            Int32, Int32, Int32
        ) -> UnsafeMutableRawPointer?
    private typealias ArbitraryFunction =
        @convention(c) (
            UInt32, UInt32, UInt32, UInt32
        ) -> UnsafeMutableRawPointer?
    private typealias KeyboardFunction =
        @convention(c) (
            UInt32, UInt32
        ) -> UnsafeMutableRawPointer?

    private let queue = DispatchQueue(label: "dev.simview.hid", qos: .userInteractive)
    private var client: NSObject?
    private var sendSelector: Selector?
    private var mouse: MouseFunction?
    private var button: ButtonFunction?
    private var arbitrary: ArbitraryFunction?
    private var keyboard: KeyboardFunction?
    private var device: NSObject?
    private(set) var udid: String?

    func setup(udid: String) throws {
        if self.udid == udid, client != nil { return }
        Xcode.loadFrameworks()
        guard let device = SimulatorRuntime.object(udid: udid) else {
            throw SimViewError("DEVICE_NOT_FOUND", "Simulator \(udid) was not found")
        }
        mouse = load("IndigoHIDMessageForMouseNSEvent", as: MouseFunction.self)
        button = load("IndigoHIDMessageForButton", as: ButtonFunction.self)
        arbitrary = load("IndigoHIDMessageForHIDArbitrary", as: ArbitraryFunction.self)
        keyboard = load("IndigoHIDMessageForKeyboardArbitrary", as: KeyboardFunction.self)
        guard mouse != nil else {
            throw SimViewError("HID_TOUCH_UNAVAILABLE", "SimulatorKit's Indigo touch symbol is unavailable")
        }
        guard let type = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
            throw SimViewError("HID_CLIENT_UNAVAILABLE", "SimDeviceLegacyHIDClient is unavailable")
        }
        let selector = NSSelectorFromString("initWithDevice:error:")
        typealias Initializer =
            @convention(c) (
                AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>
            ) -> AnyObject?
        guard let implementation = class_getMethodImplementation(type, selector) else {
            throw SimViewError("HID_CLIENT_UNAVAILABLE", "HID client initializer is unavailable")
        }
        var error: NSError?
        let allocated = (type as AnyObject).perform(NSSelectorFromString("alloc"))!.takeUnretainedValue()
        let initialized = unsafeBitCast(implementation, to: Initializer.self)(
            allocated as AnyObject,
            selector,
            device,
            &error
        )
        if let error { throw error }
        guard let object = initialized as? NSObject else {
            throw SimViewError("HID_CLIENT_UNAVAILABLE", "HID client initialization failed")
        }
        client = object
        self.device = device
        sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        self.udid = udid
    }

    func touch(phase: String, x: Double, y: Double, edge: UInt32 = 0) throws {
        try validate(x, "x")
        try validate(y, "y")
        let eventType: Int32
        switch phase {
        case "down", "move": eventType = 1
        case "up": eventType = 2
        default: throw SimViewError("INPUT_PHASE_INVALID", "Touch phase must be down, move, or up")
        }
        queue.sync {
            var point = CGPoint(x: x, y: y)
            if let message = mouse?(&point, nil, 0x32, eventType, 1, 1, edge) {
                send(message)
            }
        }
    }

    func tap(x: Double, y: Double, duration: TimeInterval = 0.05) throws {
        try touch(phase: "down", x: x, y: y)
        Thread.sleep(forTimeInterval: max(0.01, duration))
        try touch(phase: "up", x: x, y: y)
    }

    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double, duration: TimeInterval) throws {
        try [fromX, fromY, toX, toY].enumerated().forEach {
            try validate($0.element, ["from.x", "from.y", "to.x", "to.y"][$0.offset])
        }
        let steps = max(2, min(120, Int(duration * 60)))
        try touch(phase: "down", x: fromX, y: fromY)
        for step in 1..<steps {
            let progress = Double(step) / Double(steps)
            try touch(
                phase: "move",
                x: fromX + (toX - fromX) * progress,
                y: fromY + (toY - fromY) * progress
            )
            Thread.sleep(forTimeInterval: duration / Double(steps))
        }
        try touch(phase: "up", x: toX, y: toY)
    }

    func typeText(_ text: String) throws -> String {
        guard keyboard != nil else {
            throw SimViewError("HID_KEYBOARD_UNAVAILABLE", "SimulatorKit keyboard injection is unavailable")
        }
        if let events = KeyboardMap.events(text) {
            for event in events {
                key(usage: event.usage, down: event.down)
                usleep(4_000)
            }
            return "hid"
        }
        guard let udid else {
            throw SimViewError("DEVICE_NOT_SELECTED", "No simulator is selected")
        }
        let copy = run("/usr/bin/xcrun", ["simctl", "pbcopy", udid], input: Data(text.utf8))
        guard copy.status == 0 else {
            throw SimViewError("PASTEBOARD_COPY_FAILED", copy.error.nonEmpty ?? "Could not set simulator pasteboard")
        }
        key(usage: 0xe3, down: true)
        key(usage: 0x19, down: true)
        key(usage: 0x19, down: false)
        key(usage: 0xe3, down: false)
        return "pasteboard"
    }

    func key(usage: UInt32, down: Bool) {
        queue.sync {
            guard let message = keyboard?(usage, down ? 1 : 2) else { return }
            send(message)
        }
    }

    func pressButton(_ name: String) throws {
        guard let udid else {
            throw SimViewError("DEVICE_NOT_SELECTED", "No simulator is selected")
        }
        switch name {
        case "home":
            let result = run("/usr/bin/xcrun", ["simctl", "launch", udid, "com.apple.springboard"])
            if result.status != 0 {
                pressLegacy(source: 0)
            }
        case "lock":
            pressLegacy(source: 1)
        case "volume-up":
            pressArbitrary(page: 0x0c, usage: 0xe9)
        case "volume-down":
            pressArbitrary(page: 0x0c, usage: 0xea)
        case "action":
            pressArbitrary(page: 0x0c, usage: 0xcf)
        default:
            throw SimViewError("INPUT_BUTTON_INVALID", "Unsupported button: \(name)")
        }
    }

    func setOrientation(_ name: String) throws {
        let orientation: UInt32
        switch name {
        case "portrait": orientation = 1
        case "portrait-upside-down": orientation = 2
        case "landscape-right": orientation = 3
        case "landscape-left": orientation = 4
        default:
            throw SimViewError("ORIENTATION_INVALID", "Unsupported orientation: \(name)")
        }
        guard let device else {
            throw SimViewError("DEVICE_NOT_SELECTED", "No simulator is selected")
        }
        let selector = NSSelectorFromString("lookup:error:")
        typealias Lookup =
            @convention(c) (
                AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
            ) -> mach_port_t
        guard let implementation = class_getMethodImplementation(object_getClass(device), selector) else {
            throw SimViewError("ORIENTATION_BACKEND_UNAVAILABLE", "PurpleWorkspacePort lookup is unavailable")
        }
        var error: NSError?
        let port = unsafeBitCast(implementation, to: Lookup.self)(
            device,
            selector,
            "PurpleWorkspacePort",
            &error
        )
        guard port != 0 else {
            throw error
                ?? SimViewError(
                    "ORIENTATION_BACKEND_UNAVAILABLE",
                    "PurpleWorkspacePort was not found; Simulator.app may need to be running"
                )
        }
        var buffer = [UInt8](repeating: 0, count: 112)
        let sent = buffer.withUnsafeMutableBufferPointer { pointer -> kern_return_t in
            let base = UnsafeMutableRawPointer(pointer.baseAddress!)
            let header = base.assumingMemoryBound(to: mach_msg_header_t.self)
            header.pointee.msgh_bits = mach_msg_bits_t(MACH_MSG_TYPE_COPY_SEND)
            header.pointee.msgh_size = 108
            header.pointee.msgh_remote_port = port
            header.pointee.msgh_local_port = mach_port_t(MACH_PORT_NULL)
            header.pointee.msgh_voucher_port = mach_port_t(MACH_PORT_NULL)
            header.pointee.msgh_id = 0x7b
            base.storeBytes(of: UInt32(50) | UInt32(0x20000), toByteOffset: 0x18, as: UInt32.self)
            base.storeBytes(of: UInt32(4), toByteOffset: 0x48, as: UInt32.self)
            base.storeBytes(of: orientation, toByteOffset: 0x4c, as: UInt32.self)
            return mach_msg_send(header)
        }
        guard sent == KERN_SUCCESS else {
            throw SimViewError("ORIENTATION_SEND_FAILED", "mach_msg_send returned \(sent)")
        }
    }

    private func pressLegacy(source: Int32) {
        queue.sync {
            if let down = button?(source, 1, 0x33) { send(down) }
            usleep(50_000)
            if let up = button?(source, 2, 0x33) { send(up) }
        }
    }

    private func pressArbitrary(page: UInt32, usage: UInt32) {
        queue.sync {
            if let down = arbitrary?(0x32, page, usage, 1) { send(down) }
            usleep(50_000)
            if let up = arbitrary?(0x32, page, usage, 2) { send(up) }
        }
    }

    private func send(_ message: UnsafeMutableRawPointer) {
        guard let client, let sendSelector else {
            free(message)
            return
        }
        typealias Sender =
            @convention(c) (
                AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?
            ) -> Void
        guard let implementation = class_getMethodImplementation(object_getClass(client), sendSelector) else {
            free(message)
            return
        }
        unsafeBitCast(implementation, to: Sender.self)(
            client,
            sendSelector,
            message,
            ObjCBool(true),
            nil,
            nil
        )
    }

    private func validate(_ value: Double, _ name: String) throws {
        guard value.isFinite, value >= 0, value <= 1 else {
            throw SimViewError("INPUT_COORDINATE_INVALID", "\(name) must be normalized from 0 to 1")
        }
    }
}

private func load<T>(_ name: String, as type: T.Type) -> T? {
    guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
    return unsafeBitCast(pointer, to: type)
}

private enum KeyboardMap {
    struct Event {
        let usage: UInt32
        let down: Bool
    }

    static func events(_ text: String) -> [Event]? {
        var result: [Event] = []
        for character in text {
            guard let specification = specification(character) else { return nil }
            if specification.shift { result.append(Event(usage: 0xe1, down: true)) }
            result.append(Event(usage: specification.usage, down: true))
            result.append(Event(usage: specification.usage, down: false))
            if specification.shift { result.append(Event(usage: 0xe1, down: false)) }
        }
        return result
    }

    private static func specification(_ character: Character) -> (usage: UInt32, shift: Bool)? {
        let value = String(character)
        if let ascii = value.utf8.first, value.utf8.count == 1 {
            if ascii >= 97, ascii <= 122 { return (0x04 + UInt32(ascii - 97), false) }
            if ascii >= 65, ascii <= 90 { return (0x04 + UInt32(ascii - 65), true) }
        }
        let plain = "1234567890-=[]\\;'`,./"
        let shifted = "!@#$%^&*()_+{}|:\"~<>?"
        let usages: [UInt32] = Array(0x1e...0x27) + [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38]
        if let index = plain.firstIndex(of: character) {
            return (usages[plain.distance(from: plain.startIndex, to: index)], false)
        }
        if let index = shifted.firstIndex(of: character) {
            return (usages[shifted.distance(from: shifted.startIndex, to: index)], true)
        }
        switch character {
        case " ": return (0x2c, false)
        case "\n": return (0x28, false)
        case "\t": return (0x2b, false)
        default: return nil
        }
    }
}
