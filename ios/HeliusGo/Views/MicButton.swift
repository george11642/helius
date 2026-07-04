import SwiftUI

/// Hold-to-talk microphone button. Press starts on-device capture; release ends
/// it and submits the transcript.
struct MicButton: View {
    let isRecording: Bool
    let onPress: () -> Void
    let onRelease: () -> Void

    @GestureState private var pressing = false

    var body: some View {
        ZStack {
            Circle()
                .fill(isRecording ? Theme.danger : Theme.amber)
                .frame(width: 66, height: 66)
                .shadow(color: (isRecording ? Theme.danger : Theme.amber).opacity(0.5),
                        radius: isRecording ? 14 : 6)
                .scaleEffect(pressing ? 0.92 : 1.0)
            Image(systemName: isRecording ? "waveform" : "mic.fill")
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(Theme.bg)
        }
        .animation(.easeOut(duration: 0.12), value: pressing)
        .animation(.easeOut(duration: 0.12), value: isRecording)
        .gesture(
            DragGesture(minimumDistance: 0)
                .updating($pressing) { _, state, _ in
                    if !state { state = true }
                }
                .onEnded { _ in onRelease() }
        )
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.0)
                .onEnded { _ in onPress() }
        )
        .accessibilityLabel(isRecording ? "Recording, release to send" : "Hold to talk")
    }
}
