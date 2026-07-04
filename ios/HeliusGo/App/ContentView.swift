import SwiftUI

/// Helius Go — single-screen night-ops UI. Status header, tool-trace chips,
/// chat transcript with a live compass to the next waypoint, a torch-beacon
/// banner, and a voice/text input bar.
struct ContentView: View {
    @StateObject private var vm = HeliusViewModel()
    @State private var showCamera = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                StatusHeaderView(
                    engineKind: vm.engineKind,
                    lifecycle: vm.lifecycle,
                    gpsLive: vm.gpsLive,
                    backendLabel: vm.backendLabel
                )

                ToolTraceView(chips: vm.chips)

                ZStack(alignment: .topTrailing) {
                    if vm.messages.isEmpty {
                        emptyState
                    } else {
                        TranscriptView(messages: vm.messages)
                    }
                    if vm.routeDistanceM != nil {
                        CompassView(
                            relativeBearing: vm.relativeBearing,
                            distanceM: vm.routeDistanceM,
                            label: vm.routeTargetName
                        )
                        .padding(.top, 12)
                        .padding(.trailing, 14)
                    }
                }

                if vm.beaconActive { beaconBanner }

                inputBar
            }
        }
        .onAppear { vm.onAppear() }
        .sheet(isPresented: $showCamera) {
            ImagePicker { cg in vm.onSignImage(cg) }
                .ignoresSafeArea()
        }
    }

    // MARK: empty state

    private var emptyState: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "mountain.2.fill")
                .font(.system(size: 44))
                .foregroundStyle(Theme.amber.opacity(0.85))
            Text("Lost the trail? Ask Helius.")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text("Runs entirely on your phone — no signal needed.")
                .font(.footnote)
                .foregroundStyle(Theme.textDim)
            VStack(spacing: 8) {
                examplePrompt("Get me back to the trailhead before dark")
                examplePrompt("How much daylight do I have left?")
            }
            .padding(.top, 6)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func examplePrompt(_ text: String) -> some View {
        Button { vm.send(text) } label: {
            Text("\u{201C}\(text)\u{201D}")
                .font(.system(size: 13))
                .foregroundStyle(Theme.amber)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(Theme.amberDim)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .disabled({ if case .ready = vm.lifecycle { return false } else { return true } }())
    }

    // MARK: beacon banner

    private var beaconBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "flashlight.on.fill")
                .foregroundStyle(Theme.bg)
                .padding(8)
                .background(Theme.danger)
                .clipShape(Circle())
                .modifier(PulseModifier())
            VStack(alignment: .leading, spacing: 1) {
                Text("SOS BEACON ACTIVE").font(.system(size: 12, weight: .heavy)).foregroundStyle(Theme.danger)
                Text(vm.beaconPattern).font(Theme.mono(11)).foregroundStyle(Theme.textDim)
            }
            Spacer()
            Button("STOP") { vm.stopBeacon() }
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Theme.bg)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(Theme.danger)
                .clipShape(Capsule())
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Theme.danger.opacity(0.12))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.danger.opacity(0.4)), alignment: .top)
    }

    // MARK: input bar

    private var inputBar: some View {
        HStack(spacing: 10) {
            Button { showCamera = true } label: {
                Image(systemName: "camera.viewfinder")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.textDim)
            }

            Button { vm.speaker.enabled.toggle() } label: {
                Image(systemName: vm.speaker.enabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(vm.speaker.enabled ? Theme.amber : Theme.textDim)
            }

            HStack {
                TextField("", text: $vm.input, prompt: Text(placeholder).foregroundColor(Theme.textDim))
                    .foregroundStyle(Theme.text)
                    .tint(Theme.amber)
                    .submitLabel(.send)
                    .onSubmit { vm.sendCurrentInput() }
                if !vm.input.isEmpty {
                    Button { vm.sendCurrentInput() } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 22)).foregroundStyle(Theme.amber)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(Theme.panel)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(Theme.stroke, lineWidth: 1))

            MicButton(isRecording: vm.isListening,
                      onPress: { vm.micPressed() },
                      onRelease: { vm.micReleased() })
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(Theme.bg)
    }

    private var placeholder: String {
        switch vm.lifecycle {
        case .ready: return vm.isListening ? "listening…" : "Talk or type to Helius"
        case .thinking: return "Helius is working…"
        case .loading: return "loading model…"
        case .error: return "engine error"
        case .idle: return "starting…"
        }
    }
}

/// A gentle pulsing highlight for the active-beacon icon.
private struct PulseModifier: ViewModifier {
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .opacity(on ? 0.55 : 1.0)
            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
    }
}
