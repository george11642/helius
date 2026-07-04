// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HeliusCore",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "HeliusCore", targets: ["HeliusCore"]),
    ],
    targets: [
        .target(
            name: "HeliusCore",
            path: "Sources/HeliusCore"
        ),
        .testTarget(
            name: "HeliusCoreTests",
            dependencies: ["HeliusCore"],
            path: "Tests/HeliusCoreTests"
        ),
    ]
)
