import SwiftUI

/// Settings sheet: engine (mock/real), Demo Mode, voice, and about/credits.
struct SettingsView: View {
    @ObservedObject var vm: HeliusViewModel
    @ObservedObject var speaker: Speaker
    @Environment(\.dismiss) private var dismiss

    init(vm: HeliusViewModel) {
        self.vm = vm
        self.speaker = vm.speaker
    }

    var body: some View {
        NavigationView {
            ZStack {
                Theme.bg.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        section("ENGINE") {
                            Picker("Engine", selection: engineBinding) {
                                Text("Gemma 4 E2B (on-device)").tag(EngineKind.liteRT)
                                Text("Mock (scripted demo)").tag(EngineKind.mock)
                            }
                            .pickerStyle(.segmented)
                            caption("The real engine needs the 2.4 GB model in the app's Documents folder; Mock replays the canonical turn instantly.")
                        }

                        section("POSITION") {
                            toggleRow("Demo Mode", isOn: $vm.demoMode,
                                      subtitle: "Pins the position to the La Luz switchbacks preset for indoor demos. Off = live GPS anywhere; coverage vs the \(vm.packName) pack is reported honestly.")
                        }

                        section("VOICE") {
                            toggleRow("Speak answers aloud", isOn: $speaker.enabled,
                                      subtitle: "On-device text-to-speech reads each answer so you can keep your eyes on the trail.")
                        }

                        section("OFFLINE PACK") {
                            HStack {
                                Image(systemName: "map.fill").foregroundStyle(Theme.amber)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(vm.packName).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                                    Text("basemap + trail graph + POIs, bundled — zero network")
                                        .font(Theme.mono(10)).foregroundStyle(Theme.textDim)
                                }
                                Spacer()
                                Text("OFFLINE").font(.system(size: 9, weight: .bold, design: .monospaced))
                                    .foregroundStyle(Theme.good)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Theme.good.opacity(0.14)).clipShape(Capsule())
                            }
                        }

                        section("ABOUT") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Helius Go").font(.system(size: 15, weight: .heavy)).foregroundStyle(Theme.text)
                                caption("An off-grid trail agent that runs entirely on this phone: Gemma 4 E2B via LiteRT-LM, offline MapLibre + PMTiles maps, on-device routing, speech and vision. No account, no server, no signal required.")
                                caption("Map data © OpenStreetMap contributors · Protomaps basemap · MapLibre GL · PMTiles · Noto Sans (OFL). Non-medical guidance only.")
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.foregroundStyle(Theme.amber)
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var engineBinding: Binding<EngineKind> {
        Binding(get: { vm.engineKind }, set: { vm.switchEngine(to: $0) })
    }

    // MARK: pieces

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(Theme.textDim)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.panel)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.stroke, lineWidth: 1))
    }

    private func toggleRow(_ title: String, isOn: Binding<Bool>, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: isOn) {
                Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
            }
            .tint(Theme.amber)
            caption(subtitle)
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(Theme.textDim)
    }
}
