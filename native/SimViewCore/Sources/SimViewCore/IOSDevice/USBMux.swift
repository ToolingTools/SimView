import Darwin
import Foundation

struct USBMuxDevice: Sendable, Equatable {
    let deviceID: UInt32
    let serialNumber: String
    let connectionType: String
}

struct USBMuxPacket: Sendable {
    static let protocolVersion: UInt32 = 1
    static let plistMessage: UInt32 = 8
    static let headerLength = 16
    static let maximumPayload = 1 * 1024 * 1024

    let tag: UInt32
    let payload: Data

    var encoded: Data {
        var data = Data()
        data.appendLittleEndian(UInt32(Self.headerLength + payload.count))
        data.appendLittleEndian(Self.protocolVersion)
        data.appendLittleEndian(Self.plistMessage)
        data.appendLittleEndian(tag)
        data.append(payload)
        return data
    }

    static func decode(header: Data, payload: Data) throws -> USBMuxPacket {
        guard header.count == headerLength else {
            throw SimViewError("USBMUX_PROTOCOL_INVALID", "usbmuxd returned an incomplete header")
        }
        let length = Int(header.littleEndianUInt32(at: 0))
        guard length >= headerLength, length - headerLength == payload.count,
            payload.count <= maximumPayload
        else {
            throw SimViewError("USBMUX_PROTOCOL_INVALID", "usbmuxd returned an invalid packet length")
        }
        guard header.littleEndianUInt32(at: 4) == protocolVersion,
            header.littleEndianUInt32(at: 8) == plistMessage
        else {
            throw SimViewError("USBMUX_PROTOCOL_UNSUPPORTED", "usbmuxd returned an unsupported protocol packet")
        }
        return USBMuxPacket(tag: header.littleEndianUInt32(at: 12), payload: payload)
    }
}

final class USBMuxTunnel: @unchecked Sendable {
    private let lock = NSLock()
    private var descriptor: Int32

    init(descriptor: Int32) { self.descriptor = descriptor }

    deinit { close() }

    func takeDescriptor() throws -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard descriptor >= 0 else {
            throw SimViewError("USBMUX_TUNNEL_CLOSED", "The device tunnel has already been closed")
        }
        let result = descriptor
        descriptor = -1
        return result
    }

    func close() {
        lock.lock()
        let value = descriptor
        descriptor = -1
        lock.unlock()
        if value >= 0 {
            Darwin.shutdown(value, SHUT_RDWR)
            Darwin.close(value)
        }
    }
}

final class USBMuxClient: @unchecked Sendable {
    static let defaultSocketPath = "/var/run/usbmuxd"

    private let socketPath: String
    private let timeout: TimeInterval
    private let maximumPayload: Int
    private var nextTag: UInt32 = 1
    private let tagLock = NSLock()

    init(
        socketPath: String = USBMuxClient.defaultSocketPath,
        timeout: TimeInterval = 5,
        maximumPayload: Int = USBMuxPacket.maximumPayload
    ) {
        self.socketPath = socketPath
        self.timeout = timeout
        self.maximumPayload = min(maximumPayload, USBMuxPacket.maximumPayload)
    }

    func devices() throws -> [USBMuxDevice] {
        let fd = try openSocket()
        defer { Darwin.close(fd) }
        let response = try request(
            [
                "MessageType": "ListDevices",
                "ClientVersionString": "simview-core",
                "ProgName": "simview-core",
                "kLibUSBMuxVersion": 3,
                "BundleID": "dev.simview",
            ], on: fd)
        guard let entries = response["DeviceList"] as? [[String: Any]] else {
            throw SimViewError("USBMUX_PROTOCOL_INVALID", "usbmuxd omitted DeviceList")
        }
        return entries.compactMap(Self.parseDevice)
    }

    func connect(udid: String, port: UInt16) throws -> USBMuxTunnel {
        let listed = try devices()
        let canonical = Self.canonicalUDID(udid)
        let matches = listed.filter {
            Self.canonicalUDID($0.serialNumber) == canonical
                && $0.connectionType.caseInsensitiveCompare("USB") == .orderedSame
        }
        guard let device = matches.first else {
            let connectedByOtherTransport = listed.contains {
                Self.canonicalUDID($0.serialNumber) == canonical
            }
            throw SimViewError(
                connectedByOtherTransport ? "IOS_DEVICE_USB_REQUIRED" : "IOS_DEVICE_NOT_CONNECTED",
                connectedByOtherTransport
                    ? "Physical iOS v1 requires a direct USB connection"
                    : "The physical iOS device is not connected through usbmuxd"
            )
        }

        let fd = try openSocket()
        do {
            let response = try request(
                [
                    "MessageType": "Connect",
                    "ClientVersionString": "simview-core",
                    "ProgName": "simview-core",
                    "kLibUSBMuxVersion": 3,
                    "BundleID": "dev.simview",
                    "DeviceID": device.deviceID,
                    // usbmuxd expects the port number in network byte order inside the plist integer.
                    "PortNumber": Self.networkOrderedPort(port),
                ], on: fd)
            let result = (response["Number"] as? NSNumber)?.intValue
            guard result == 0 else {
                throw SimViewError(
                    "USBMUX_CONNECT_FAILED",
                    "usbmuxd rejected the device connection",
                    details: ["result": result as Any]
                )
            }
            try clearTimeout(fd)
            return USBMuxTunnel(descriptor: fd)
        } catch {
            Darwin.close(fd)
            throw error
        }
    }

    static func parseDevice(_ entry: [String: Any]) -> USBMuxDevice? {
        guard let properties = entry["Properties"] as? [String: Any],
            let deviceNumber = entry["DeviceID"] as? NSNumber,
            let serial = properties["SerialNumber"] as? String,
            !serial.isEmpty
        else { return nil }
        return USBMuxDevice(
            deviceID: deviceNumber.uint32Value,
            serialNumber: serial,
            connectionType: properties["ConnectionType"] as? String ?? "unknown"
        )
    }

    static func canonicalUDID(_ value: String) -> String {
        value.replacingOccurrences(of: "-", with: "").lowercased()
    }

    static func networkOrderedPort(_ port: UInt16) -> UInt16 {
        UInt16(bigEndian: port)
    }

    private func openSocket() throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw SimViewError("USBMUX_SOCKET_FAILED", String(cString: strerror(errno)))
        }
        do {
            try configureTimeout(fd)
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let maximum = MemoryLayout.size(ofValue: address.sun_path)
            guard socketPath.utf8.count < maximum else {
                throw SimViewError("USBMUX_SOCKET_PATH_INVALID", "The usbmuxd socket path is too long")
            }
            _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: maximum) { destination in
                    socketPath.withCString { source in strncpy(destination, source, maximum - 1) }
                }
            }
            let status = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard status == 0 else {
                throw SimViewError(
                    "USBMUX_UNAVAILABLE",
                    "Could not connect to Apple's usbmuxd: \(String(cString: strerror(errno)))"
                )
            }
            return fd
        } catch {
            Darwin.close(fd)
            throw error
        }
    }

    private func request(_ dictionary: [String: Any], on fd: Int32) throws -> [String: Any] {
        let payload = try PropertyListSerialization.data(
            fromPropertyList: dictionary,
            format: .xml,
            options: 0
        )
        guard payload.count <= maximumPayload else {
            throw SimViewError("USBMUX_REQUEST_TOO_LARGE", "The usbmuxd request exceeds the payload limit")
        }
        let tag = allocateTag()
        try writeAll(USBMuxPacket(tag: tag, payload: payload).encoded, to: fd)
        let header = try readExactly(USBMuxPacket.headerLength, from: fd)
        let length = Int(header.littleEndianUInt32(at: 0))
        guard length >= USBMuxPacket.headerLength, length - USBMuxPacket.headerLength <= maximumPayload else {
            throw SimViewError("USBMUX_RESPONSE_TOO_LARGE", "The usbmuxd response exceeds the payload limit")
        }
        let packet = try USBMuxPacket.decode(
            header: header,
            payload: try readExactly(length - USBMuxPacket.headerLength, from: fd)
        )
        guard packet.tag == tag else {
            throw SimViewError("USBMUX_PROTOCOL_INVALID", "usbmuxd returned an unexpected request tag")
        }
        guard
            let object = try PropertyListSerialization.propertyList(
                from: packet.payload,
                options: [],
                format: nil
            ) as? [String: Any]
        else {
            throw SimViewError("USBMUX_PROTOCOL_INVALID", "usbmuxd returned a malformed plist")
        }
        return object
    }

    private func allocateTag() -> UInt32 {
        tagLock.lock()
        defer { tagLock.unlock() }
        let value = nextTag
        nextTag = nextTag == UInt32.max ? 1 : nextTag + 1
        return value
    }

    private func configureTimeout(_ fd: Int32) throws {
        let integral = floor(timeout)
        var value = timeval(
            tv_sec: Int(integral),
            tv_usec: Int32((timeout - integral) * 1_000_000)
        )
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &value, socklen_t(MemoryLayout<timeval>.size)) == 0,
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &value, socklen_t(MemoryLayout<timeval>.size)) == 0
        else {
            throw SimViewError("USBMUX_SOCKET_FAILED", String(cString: strerror(errno)))
        }
    }

    private func clearTimeout(_ fd: Int32) throws {
        var value = timeval()
        guard
            setsockopt(
                fd, SOL_SOCKET, SO_RCVTIMEO, &value,
                socklen_t(MemoryLayout<timeval>.size)) == 0,
            setsockopt(
                fd, SOL_SOCKET, SO_SNDTIMEO, &value,
                socklen_t(MemoryLayout<timeval>.size)) == 0
        else {
            throw SimViewError("USBMUX_SOCKET_FAILED", String(cString: strerror(errno)))
        }
    }

    private func readExactly(_ count: Int, from fd: Int32) throws -> Data {
        guard count >= 0, count <= maximumPayload else {
            throw SimViewError("USBMUX_PROTOCOL_INVALID", "usbmuxd returned an invalid payload size")
        }
        var result = Data(count: count)
        var offset = 0
        while offset < count {
            let read = result.withUnsafeMutableBytes { raw in
                Darwin.recv(fd, raw.baseAddress!.advanced(by: offset), count - offset, 0)
            }
            if read < 0, errno == EINTR { continue }
            guard read > 0 else {
                let message = read == 0 ? "connection closed" : String(cString: strerror(errno))
                throw SimViewError("USBMUX_DISCONNECTED", "usbmuxd disconnected: \(message)")
            }
            offset += read
        }
        return result
    }

    private func writeAll(_ data: Data, to fd: Int32) throws {
        let success = data.withUnsafeBytes { raw -> Bool in
            guard var pointer = raw.baseAddress else { return data.isEmpty }
            var remaining = raw.count
            while remaining > 0 {
                let written = Darwin.send(fd, pointer, remaining, MSG_NOSIGNAL)
                if written < 0, errno == EINTR { continue }
                if written <= 0 { return false }
                pointer = pointer.advanced(by: written)
                remaining -= written
            }
            return true
        }
        guard success else {
            throw SimViewError("USBMUX_DISCONNECTED", "Could not write to usbmuxd")
        }
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }

    func littleEndianUInt32(at offset: Int) -> UInt32 {
        subdata(in: offset..<(offset + 4)).withUnsafeBytes {
            $0.loadUnaligned(as: UInt32.self).littleEndian
        }
    }
}
