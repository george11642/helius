import SwiftUI
import LiteRTLM

// STAGE 1 — LiteRT-LM integration probe. This view exists only to prove the
// SPM + xcframework link and that a .litertlm model loads and generates on the
// simulator. It is replaced by the real Helius UI in Stage 2.
struct ContentView: View {
    @State private var output = ""
    @State private var status = "idle"
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Helius Go").font(.title2.bold())
            Text("LiteRT-LM integration probe").font(.caption).foregroundStyle(.secondary)
            Text(status)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.orange)
            Divider()
            ScrollView {
                Text(output.isEmpty ? "—" : output)
                    .font(.system(.body, design: .default))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            Button(action: { Task { await run() } }) {
                Text(busy ? "Working…" : "Init + Generate")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
            .disabled(busy)
        }
        .padding()
    }

    private func run() async {
        busy = true
        defer { busy = false }
        do {
            let path = ModelLocator.resolveModelPath()
            status = "loading \(URL(fileURLWithPath: path).lastPathComponent)…"
            let cfg = try EngineConfig(
                modelPath: path,
                backend: .cpu(),
                maxNumTokens: 1024,
                cacheDir: NSTemporaryDirectory()
            )
            let engine = Engine(engineConfig: cfg)
            let t0 = Date()
            try await engine.initialize()
            let loadS = String(format: "%.1f", Date().timeIntervalSince(t0))
            status = "loaded in \(loadS)s — generating…"
            let convo = try await engine.createConversation()
            var acc = ""
            let t1 = Date()
            for try await chunk in convo.sendMessageStream(
                Message("You are a calm wilderness guide. In one short sentence, what is the first thing a hiker who has lost the trail near sunset should do?")
            ) {
                acc += chunk.toString
                output = acc
            }
            let genS = String(format: "%.1f", Date().timeIntervalSince(t1))
            status = "done — load \(loadS)s, gen \(genS)s"
        } catch {
            status = "ERROR"
            output = "\(error)"
        }
    }
}
