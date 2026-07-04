import Foundation

/// Resolves the on-disk path to the bundled `.litertlm` model.
///
/// Search order:
///   1. `HELIUS_MODEL_PATH` env var (used for fast simulator/dev runs so we don't
///      have to copy a ~2.4 GB file into every build — the simulator can read the
///      host filesystem directly).
///   2. The model bundled into the app (device / sideload builds).
///   3. A known development absolute path (last-resort fallback).
enum ModelLocator {
    /// The generic mobile CPU/XNNPACK bundle for Gemma 4 E2B (text ~0.8 GB resident,
    /// vision/audio loaded on demand).
    static let bundledResourceName = "gemma-4-E2B-it"
    static let bundledResourceExt = "litertlm"

    static let devFallbackPath =
        "/Users/georgeteifel/dev/helius-assets/models/gemma-4-E2B-litert/gemma-4-E2B-it.litertlm"

    static func resolveModelPath() -> String {
        if let p = ProcessInfo.processInfo.environment["HELIUS_MODEL_PATH"], !p.isEmpty {
            return p
        }
        if let url = Bundle.main.url(forResource: bundledResourceName, withExtension: bundledResourceExt) {
            return url.path
        }
        return devFallbackPath
    }

    static func modelExists(at path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }
}
