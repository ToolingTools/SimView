// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "SimViewCore",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "simview-core", targets: ["SimViewCore"]),
    ],
    targets: [
        .target(
            name: "SimViewAXShim",
            path: "Sources/SimViewAXShim",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("AppKit"),
            ]
        ),
        .executableTarget(
            name: "SimViewCore",
            dependencies: ["SimViewAXShim"],
            path: "Sources/SimViewCore",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("IOSurface"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("ImageIO"),
            ]
        ),
        .testTarget(
            name: "SimViewCoreTests",
            dependencies: ["SimViewCore"],
            path: "Tests/SimViewCoreTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
