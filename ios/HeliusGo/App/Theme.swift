import SwiftUI

/// Night-ops palette shared with the Helius web app: near-black background,
/// amber accent, mono numerals. Designed to be readable by a cold, tired hiker
/// in the dark without wrecking night vision.
enum Theme {
    static let bg = Color(hex: 0x0a0e14)
    static let panel = Color(hex: 0x11161f)
    static let panelHi = Color(hex: 0x1a212e)
    static let stroke = Color(hex: 0x263042)
    static let amber = Color(hex: 0xffb454)
    static let amberDim = Color(hex: 0xffb454).opacity(0.16)
    static let text = Color(hex: 0xe6edf3)
    static let textDim = Color(hex: 0x8b98a9)
    static let good = Color(hex: 0x7fd962)
    static let warn = Color(hex: 0xffb454)
    static let danger = Color(hex: 0xff6b6b)

    /// Monospaced, tabular figures for all numerals (distances, ETAs, clocks).
    static func mono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xff) / 255.0
        let g = Double((hex >> 8) & 0xff) / 255.0
        let b = Double(hex & 0xff) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}
