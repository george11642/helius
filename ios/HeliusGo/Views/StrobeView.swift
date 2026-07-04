import SwiftUI

/// Full-screen white-strobe Morse beacon — the fallback signaling surface when
/// the device has no torch (simulator, iPad, torch hardware failure). Flashes
/// the same unit-timed on/off timeline the torch uses (Morse.timeline), with a
/// max-brightness white screen as the "on" state, looping until stopped.
struct StrobeView: View {
    let message: String
    let pattern: String
    let onStop: () -> Void

    @State private var flashOn = false
    @State private var savedBrightness: CGFloat = UIScreen.main.brightness

    var body: some View {
        ZStack {
            (flashOn ? Color.white : Color.black).ignoresSafeArea()

            VStack(spacing: 14) {
                Spacer()
                Text("SOS BEACON — SCREEN STROBE")
                    .font(.system(size: 13, weight: .heavy, design: .monospaced))
                    .foregroundStyle(flashOn ? .black : Theme.danger)
                Text(pattern)
                    .font(Theme.mono(15, weight: .bold))
                    .foregroundStyle(flashOn ? .black : Theme.text)
                Text("No torch on this device — the screen is the light.\nHold it high, face it toward searchers.")
                    .multilineTextAlignment(.center)
                    .font(.footnote)
                    .foregroundStyle(flashOn ? .black.opacity(0.7) : Theme.textDim)
                Spacer()
                Button(action: onStop) {
                    Text("STOP BEACON")
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundStyle(Theme.bg)
                        .padding(.horizontal, 28).padding(.vertical, 12)
                        .background(Theme.danger)
                        .clipShape(Capsule())
                }
                .padding(.bottom, 40)
            }
        }
        .task { await strobeLoop() }
        .onAppear {
            savedBrightness = UIScreen.main.brightness
            UIScreen.main.brightness = 1.0
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            UIScreen.main.brightness = savedBrightness
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }

    /// Same unit timing as TorchController: dot 1u, dash 3u, letter gap 3u,
    /// word gap 7u, 1.4 s between repeats. Cancelled automatically when the
    /// view leaves the hierarchy (`.task`).
    private func strobeLoop() async {
        let timeline = Morse.timeline(message, unitMs: 200)
        guard !timeline.isEmpty else { return }
        while !Task.isCancelled {
            for step in timeline {
                if Task.isCancelled { return }
                flashOn = step.on
                try? await Task.sleep(nanoseconds: UInt64(step.ms) * 1_000_000)
            }
            flashOn = false
            try? await Task.sleep(nanoseconds: 1_400_000_000)
        }
    }
}
