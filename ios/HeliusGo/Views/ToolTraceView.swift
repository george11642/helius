import SwiftUI

/// Horizontal strip of tool chips that light up as the agent chains tools —
/// locate() → sun_clock() → route_back() — mirroring the web app's trace.
struct ToolTraceView: View {
    let chips: [TraceChip]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips) { chip in
                    ChipView(chip: chip)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .frame(height: chips.isEmpty ? 0 : 44)
        .opacity(chips.isEmpty ? 0 : 1)
        .animation(.easeInOut(duration: 0.2), value: chips)
    }
}

private struct ChipView: View {
    let chip: TraceChip

    var body: some View {
        HStack(spacing: 6) {
            icon
            Text(chip.name + "()")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
            if let ms = chip.ms {
                Text("\(ms)ms").font(Theme.mono(10)).foregroundStyle(Theme.textDim)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(color.opacity(0.12))
        .overlay(Capsule().stroke(color.opacity(0.5), lineWidth: 1))
        .clipShape(Capsule())
    }

    @ViewBuilder private var icon: some View {
        switch chip.state {
        case .running:
            ProgressView().controlSize(.mini).tint(Theme.amber)
        case .done:
            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.good)
        case .failed:
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.danger)
        }
    }

    private var color: Color {
        switch chip.state {
        case .running: return Theme.amber
        case .done: return Theme.good
        case .failed: return Theme.danger
        }
    }
}
