import SwiftUI

/// A big, field-usable bearing arrow pointing toward the next waypoint on the
/// route back. `relativeBearing` is (targetBearing − deviceHeading) in degrees;
/// nil hides the arrow (no route yet / no heading).
struct CompassView: View {
    let relativeBearing: Double?
    let distanceM: Double?
    let label: String

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                Circle().stroke(Theme.stroke, lineWidth: 2)
                Circle().fill(Theme.panel)
                ForEach(0..<8) { i in
                    Rectangle()
                        .fill(Theme.stroke)
                        .frame(width: 1.5, height: i % 2 == 0 ? 9 : 5)
                        .offset(y: -33)
                        .rotationEffect(.degrees(Double(i) * 45))
                }
                Image(systemName: "location.north.fill")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(relativeBearing == nil ? Theme.textDim : Theme.amber)
                    .rotationEffect(.degrees(relativeBearing ?? 0))
                    .animation(.easeOut(duration: 0.2), value: relativeBearing)
            }
            .frame(width: 84, height: 84)

            if let d = distanceM {
                Text(formatDistance(d)).font(Theme.mono(13, weight: .bold)).foregroundStyle(Theme.text)
            }
            Text(label.uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(Theme.textDim)
        }
        .padding(12)
        .background(Theme.panel.opacity(0.9))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.stroke, lineWidth: 1))
    }

    private func formatDistance(_ m: Double) -> String {
        m < 1000 ? "\(Int(m.rounded())) m" : String(format: "%.1f km", m / 1000)
    }
}
