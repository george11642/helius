import Foundation

/// Deterministic scripted engine. Runs the canonical "get me back before dark"
/// turn — emitting the same tool-trace and route events the real engine does —
/// so the full UX can be exercised and screenshotted on the simulator instantly,
/// without waiting on a multi-second model load. Also a safe fallback if the
/// real engine ever fails to initialize on a given device. Selected via the
/// `HELIUS_ENGINE=mock` launch env or a Settings toggle.
final class MockEngine: HeliusEngine {
    let kind: EngineKind = .mock

    func warmUp(onStatus: @escaping (String) -> Void) async throws {
        onStatus("loading mock engine…")
        try? await Task.sleep(nanoseconds: 250_000_000)
        onStatus("ready")
    }

    func send(_ userText: String, emit: @escaping (AgentEvent) -> Void) async {
        emit(.turnStarted)

        await tool(emit, "locate", "fix 35.1983,-106.4439 ±14m @2926m", 41)
        await tool(emit, "sun_clock", "sunset 20:24, 118 min light, dark in 148 min", 23)
        await tool(emit, "route_back", "route to La Luz Trailhead: 10.64 km / 6.61 mi, ~128 min, 84 pts", 62)
        emit(.route(distanceM: 10_640, etaMin: 128, waypointCount: 84))
        await tool(emit, "pace_eta", "ETA 128 min, arrive 22:32 — 20 min AFTER sunset", 7)

        let answer = "You're about 10.6 km / 6.6 mi from the La Luz trailhead — roughly 2 hours 8 minutes on foot, which lands you around 20 minutes after sunset. Start down the La Luz trail now and keep a steady, careful pace. If the light runs out before you reach the bottom, stop where you are and I'll flash an SOS beacon so searchers can find you."

        var emitted = ""
        for word in answer.split(separator: " ") {
            let delta = (emitted.isEmpty ? "" : " ") + word
            emitted += delta
            emit(.token(delta))
            try? await Task.sleep(nanoseconds: 42_000_000)
        }
        emit(.assistantFinal(answer))
        emit(.turnEnded)
    }

    private func tool(_ emit: @escaping (AgentEvent) -> Void, _ name: String, _ summary: String, _ ms: Int) async {
        emit(.toolStarted(name: name, argsSummary: nil))
        try? await Task.sleep(nanoseconds: UInt64(ms) * 6_000_000) // stretch for visibility
        emit(.toolFinished(name: name, summary: summary, ms: ms))
    }
}
