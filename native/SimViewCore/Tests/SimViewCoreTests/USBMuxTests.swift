import Foundation
import XCTest

@testable import SimViewCore

final class USBMuxTests: XCTestCase {
    func testPacketRoundTripUsesLittleEndianHeader() throws {
        let packet = USBMuxPacket(tag: 0x1234_5678, payload: Data("plist".utf8))
        let encoded = packet.encoded

        XCTAssertEqual(Array(encoded.prefix(4)), [21, 0, 0, 0])
        XCTAssertEqual(Array(encoded[4..<8]), [1, 0, 0, 0])
        XCTAssertEqual(Array(encoded[8..<12]), [8, 0, 0, 0])
        XCTAssertEqual(Array(encoded[12..<16]), [0x78, 0x56, 0x34, 0x12])

        let decoded = try USBMuxPacket.decode(
            header: Data(encoded.prefix(16)),
            payload: Data(encoded.dropFirst(16))
        )
        XCTAssertEqual(decoded.tag, packet.tag)
        XCTAssertEqual(decoded.payload, packet.payload)
    }

    func testPacketRejectsOversizedOrInconsistentLength() {
        var header = USBMuxPacket(tag: 1, payload: Data()).encoded
        header[0] = 17
        XCTAssertThrowsError(try USBMuxPacket.decode(header: header, payload: Data()))
    }

    func testDeviceParsingAndCanonicalIdentifier() {
        let device = USBMuxClient.parseDevice([
            "DeviceID": 42,
            "Properties": [
                "SerialNumber": "00008140-001234567890001C",
                "ConnectionType": "USB",
            ],
        ])
        XCTAssertEqual(
            device,
            USBMuxDevice(
                deviceID: 42,
                serialNumber: "00008140-001234567890001C",
                connectionType: "USB"
            )
        )
        XCTAssertEqual(
            USBMuxClient.canonicalUDID("00008140-001234567890001C"),
            "00008140001234567890001c"
        )
    }

    func testMalformedDeviceEntriesAreIgnored() {
        XCTAssertNil(USBMuxClient.parseDevice(["DeviceID": 1]))
        XCTAssertNil(USBMuxClient.parseDevice(["Properties": ["SerialNumber": "device"]]))
    }

    func testConnectPortUsesNetworkByteOrderInsidePlist() {
        XCTAssertEqual(USBMuxClient.networkOrderedPort(8_100), 0xA4_1F)
    }
}
