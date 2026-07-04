import SwiftUI

/// Top strip: app mark, model/engine state, GPS source badge, settings gear.
struct StatusHeaderView: View {
    let engineKind: EngineKind
    let lifecycle: EngineLifecycle
    let gpsLive: Bool
    let demoMode: Bool
    let backendLabel: String
    let onSettings: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 9, height: 9)
                .shadow(color: statusColor.opacity(0.8), radius: 4)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text("HELIUS").font(.system(size: 15, weight: .heavy)).foregroundStyle(Theme.text)
                    Text("GO").font(.system(size: 15, weight: .heavy)).foregroundStyle(Theme.amber)
                }
                Text(statusText)
                    .font(Theme.mono(10.5))
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Badge(text: engineKind.rawValue, color: Theme.amber)
                Badge(text: gpsBadgeText, color: gpsBadgeColor)
            }
            Button(action: onSettings) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.textDim)
                    .padding(.leading, 2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.panel)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.stroke), alignment: .bottom)
    }

    private var gpsBadgeText: String {
        if demoMode { return "DEMO FIX" }
        return gpsLive ? "GPS LIVE" : "GPS WAIT"
    }

    private var gpsBadgeColor: Color {
        if demoMode { return Theme.amber }
        return gpsLive ? Theme.good : Theme.textDim
    }

    private var statusColor: Color {
        switch lifecycle {
        case .ready: return Theme.good
        case .thinking, .loading: return Theme.amber
        case .error: return Theme.danger
        case .idle: return Theme.textDim
        }
    }

    private var statusText: String {
        switch lifecycle {
        case .idle: return "offline · not loaded"
        case .loading(let s): return s
        case .ready: return "on-device · no network"
        case .thinking: return "thinking…"
        case .error(let e): return "error: \(e)"
        }
    }
}

private struct Badge: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.14))
            .clipShape(Capsule())
    }
}
