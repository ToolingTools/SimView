import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import ObjectiveC

@objc protocol FramebufferDescriptor {
    @objc(
        registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:
    )
    func registerScreenCallbacks(
        uuid: UUID,
        callbackQueue: DispatchQueue,
        frameCallback: @convention(block) @escaping () -> Void,
        surfacesChangedCallback: @convention(block) @escaping () -> Void,
        propertiesChangedCallback: @convention(block) @escaping () -> Void
    )
}

final class FrameCapture: @unchecked Sendable {
    typealias Callback = @Sendable (CVPixelBuffer, CMTime, String) -> Void

    private let queue = DispatchQueue(label: "dev.simview.capture", qos: .userInteractive)
    private var descriptors: [NSObject] = []
    private var callbackUUIDs: [ObjectIdentifier: UUID] = [:]
    private var lastSeeds: [ObjectIdentifier: UInt32] = [:]
    private var ioClient: NSObject?
    private var callback: Callback?
    private var idleTimer: DispatchSourceTimer?
    private var pixelBufferPool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0
    private var poolPixelFormat: OSType = 0
    private var lastCapture = DispatchTime.now()
    private var frameCount: UInt64 = 0
    private(set) var width = 0
    private(set) var height = 0
    private(set) var latestFrame: CVPixelBuffer?

    func start(udid: String, callback: @escaping Callback) throws {
        stop()
        self.callback = callback
        Xcode.loadFrameworks()
        guard let device = SimulatorRuntime.object(udid: udid) else {
            throw SimViewError("DEVICE_NOT_FOUND", "Simulator \(udid) was not found")
        }
        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw SimViewError("DEVICE_NOT_BOOTED", "Simulator is \(state), not Booted")
        }
        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw SimViewError("SIMULATOR_IO_UNAVAILABLE", "SimulatorKit did not expose device IO")
        }
        ioClient = io
        try wireFramebuffers()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
        timer.setEventHandler { [weak self] in
            guard let self, DispatchTime.now().uptimeNanoseconds - self.lastCapture.uptimeNanoseconds >= 200_000_000
            else { return }
            self.capture(force: true)
        }
        timer.resume()
        idleTimer = timer
    }

    func stop() {
        idleTimer?.cancel()
        idleTimer = nil
        let selector = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
        for descriptor in descriptors {
            if let uuid = callbackUUIDs[ObjectIdentifier(descriptor)], descriptor.responds(to: selector) {
                descriptor.perform(selector, with: uuid)
            }
        }
        descriptors.removeAll()
        callbackUUIDs.removeAll()
        lastSeeds.removeAll()
        ioClient = nil
        callback = nil
        pixelBufferPool = nil
        poolWidth = 0
        poolHeight = 0
        poolPixelFormat = 0
        latestFrame = nil
        width = 0
        height = 0
        frameCount = 0
        lastCapture = DispatchTime.now()
    }

    private func wireFramebuffers() throws {
        guard let ioClient else {
            throw SimViewError("SIMULATOR_IO_UNAVAILABLE", "No SimulatorKit IO client")
        }
        let unregisterSelector = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
        for descriptor in descriptors {
            if let uuid = callbackUUIDs[ObjectIdentifier(descriptor)],
                descriptor.responds(to: unregisterSelector)
            {
                descriptor.perform(unregisterSelector, with: uuid)
            }
        }
        descriptors.removeAll()
        callbackUUIDs.removeAll()
        lastSeeds.removeAll()

        ioClient.perform(NSSelectorFromString("updateIOPorts"))
        guard let ports = ioClient.value(forKey: "deviceIOPorts") as? [NSObject] else {
            throw SimViewError("FRAMEBUFFER_PORTS_UNAVAILABLE", "SimulatorKit did not expose IO ports")
        }
        let candidates = ports.compactMap { port -> NSObject? in
            guard
                let identifier = port.perform(NSSelectorFromString("portIdentifier"))?.takeUnretainedValue(),
                "\(identifier)" == "com.apple.framebuffer.display",
                let descriptor = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
                descriptor.responds(to: NSSelectorFromString("framebufferSurface"))
            else { return nil }
            return descriptor
        }
        guard !candidates.isEmpty else {
            throw SimViewError("FRAMEBUFFER_NOT_FOUND", "No active framebuffer display descriptor was found")
        }
        descriptors = candidates
        for descriptor in candidates {
            guard descriptor.responds(to: #selector(FramebufferDescriptor.registerScreenCallbacks)) else {
                continue
            }
            let uuid = UUID()
            callbackUUIDs[ObjectIdentifier(descriptor)] = uuid
            (descriptor as AnyObject).registerScreenCallbacks(
                uuid: uuid,
                callbackQueue: queue,
                frameCallback: { [weak self] in self?.capture() },
                surfacesChangedCallback: { [weak self] in
                    guard let self else { return }
                    try? self.wireFramebuffers()
                },
                propertiesChangedCallback: {}
            )
        }
        capture(force: true)
    }

    private func bestSurface() -> (NSObject, IOSurface)? {
        var best: (NSObject, IOSurface)?
        var bestArea = 0
        for descriptor in descriptors {
            guard let raw = descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue()
            else { continue }
            let surface = unsafeDowncast(raw, to: IOSurface.self)
            let area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface)
            if area > bestArea {
                bestArea = area
                best = (descriptor, surface)
            }
        }
        return best
    }

    private func capture(force: Bool = false) {
        guard let (descriptor, surface) = bestSurface() else { return }
        let now = DispatchTime.now()
        if !force,
            frameCount > 0,
            now.uptimeNanoseconds - lastCapture.uptimeNanoseconds < 16_666_667
        {
            return
        }
        let identity = ObjectIdentifier(descriptor)
        let seed = IOSurfaceGetSeed(surface)
        if frameCount > 0, lastSeeds[identity] == seed, !force { return }
        lastSeeds[identity] = seed

        var unmanaged: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault,
            surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &unmanaged
        )
        guard status == kCVReturnSuccess, let source = unmanaged?.takeRetainedValue(),
            let frame = copyFrame(source)
        else { return }
        width = CVPixelBufferGetWidth(frame)
        height = CVPixelBufferGetHeight(frame)
        latestFrame = frame
        frameCount += 1
        lastCapture = now
        callback?(frame, CMTime(value: CMTimeValue(frameCount), timescale: 60), "\(frameCount)")
    }

    private func copyFrame(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source)
        let height = CVPixelBufferGetHeight(source)
        let pixelFormat = CVPixelBufferGetPixelFormatType(source)
        if pixelBufferPool == nil
            || poolWidth != width
            || poolHeight != height
            || poolPixelFormat != pixelFormat
        {
            let poolAttributes: [CFString: Any] = [
                kCVPixelBufferPoolMinimumBufferCountKey: 3
            ]
            let pixelBufferAttributes: [CFString: Any] = [
                kCVPixelBufferWidthKey: width,
                kCVPixelBufferHeightKey: height,
                kCVPixelBufferPixelFormatTypeKey: pixelFormat,
                kCVPixelBufferIOSurfacePropertiesKey: [:],
            ]
            var pool: CVPixelBufferPool?
            guard
                CVPixelBufferPoolCreate(
                    kCFAllocatorDefault,
                    poolAttributes as CFDictionary,
                    pixelBufferAttributes as CFDictionary,
                    &pool
                ) == kCVReturnSuccess, let pool
            else { return nil }
            pixelBufferPool = pool
            poolWidth = width
            poolHeight = height
            poolPixelFormat = pixelFormat
        }
        guard let pixelBufferPool else { return nil }
        var destination: CVPixelBuffer?
        guard
            CVPixelBufferPoolCreatePixelBuffer(
                kCFAllocatorDefault,
                pixelBufferPool,
                &destination
            ) == kCVReturnSuccess, let destination
        else { return nil }
        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(destination, [])
        defer {
            CVPixelBufferUnlockBaseAddress(destination, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard
            let sourceBase = CVPixelBufferGetBaseAddress(source),
            let destinationBase = CVPixelBufferGetBaseAddress(destination)
        else { return nil }
        let sourceStride = CVPixelBufferGetBytesPerRow(source)
        let destinationStride = CVPixelBufferGetBytesPerRow(destination)
        let copied = min(sourceStride, destinationStride)
        for row in 0..<height {
            memcpy(
                destinationBase.advanced(by: row * destinationStride),
                sourceBase.advanced(by: row * sourceStride),
                copied
            )
        }
        return destination
    }
}
