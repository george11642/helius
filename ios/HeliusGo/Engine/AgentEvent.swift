import Foundation

/// Which engine is backing the app right now.
enum EngineKind: String {
    case liteRT = "Gemma 4 E2B"
    case mock = "Mock"
}

/// Engine lifecycle, surfaced in the status header.
enum EngineLifecycle: Equatable {
    case idle
    case loading(String)
    case ready
    case thinking
    case error(String)
}

/// One chip in the tool-trace strip (locate → sun_clock → route_back …).
struct TraceChip: Identifiable, Equatable {
    enum State: Equatable { case running, done, failed }
    let id = UUID()
    let name: String
    var state: State = .running
    var summary: String? = nil
    var ms: Int? = nil
}

/// A line in the chat transcript.
struct ChatMessage: Identifiable, Equatable {
    enum Role: Equatable { case user, helius }
    let id = UUID()
    let role: Role
    var text: String
}

/// Events emitted by the engine and tools during a single turn. The view model
/// reduces these into observable UI state (transcript text, trace chips, beacon
/// and route side-effects).
enum AgentEvent {
    case turnStarted
    case token(String)
    case toolStarted(name: String, argsSummary: String?)
    case toolFinished(name: String, summary: String?, ms: Int)
    case beacon(active: Bool, pattern: String)
    case route(distanceM: Double, etaMin: Double, waypointCount: Int)
    case assistantFinal(String)
    case turnEnded
    case failed(String)
}

/// Abstraction over the on-device model. `LiteRTEngine` is the real Gemma-4
/// runtime; `MockEngine` is a deterministic scripted stand-in used for fast UI
/// iteration and for proving the full UX on the simulator without waiting on a
/// multi-second model load.
protocol HeliusEngine: AnyObject {
    var kind: EngineKind { get }
    /// Loads/initializes the model. `onStatus` reports human-readable progress.
    func warmUp(onStatus: @escaping (String) -> Void) async throws
    /// Runs one user turn, emitting events until the turn ends. `emit` is always
    /// called on the main actor by the caller's wrapper.
    func send(_ userText: String, emit: @escaping (AgentEvent) -> Void) async
}
