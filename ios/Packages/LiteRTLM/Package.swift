// swift-tools-version:5.9
// Local vendored copy of Google's LiteRT-LM Swift API.
//
// We vendor the prebuilt CLiteRTLM.xcframework (iOS device + simulator slices,
// from the official v0.13.1 release) plus the official Swift wrapper sources,
// instead of pulling the package over the network via SPM's remote binaryTarget.
// Rationale: the remote binary-artifact fetch is slow/unreliable, and an
// offline-first field app should build without a network round-trip. The wrapper
// sources are unmodified from google-ai-edge/LiteRT-LM @ v0.13.1 (swift/).
import PackageDescription

let package = Package(
    name: "LiteRTLM",
    platforms: [
        .iOS(.v15)
    ],
    products: [
        .library(name: "LiteRTLM", targets: ["LiteRTLM"])
    ],
    targets: [
        .binaryTarget(
            name: "CLiteRTLM",
            path: "Frameworks/CLiteRTLM.xcframework"
        ),
        .target(
            name: "LiteRTLM",
            dependencies: ["CLiteRTLM"],
            path: "Sources/LiteRTLM",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-all_load"])
            ]
        ),
    ]
)
