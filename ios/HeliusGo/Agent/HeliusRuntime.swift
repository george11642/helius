import Foundation
import CoreGraphics
import HeliusCore

/// Process-wide shared state + event bus.
///
/// LiteRT-LM instantiates each `Tool` fresh per call, so tools can't be handed
/// dependencies through an initializer. Instead they read live app state — the
/// current GPS fix, the loaded routing graph, a pending camera frame — from this
/// singleton, and emit trace events onto the same bus the view model consumes so
/// the UI chips light up as the agent chains tools.
///
/// Touched from background (tool) threads and the main thread; kept intentionally
/// simple (Swift 5 language mode, very low contention). The fix is guarded by a
/// lock to avoid torn reads; the graph is written once before any turn runs.
final class HeliusRuntime {
    static let shared = HeliusRuntime()
    private init() {}

    // MARK: Live state read by tools

    private let lock = NSLock()
    private var _fix: Fix = .lostHiker
    /// The position `locate` returns. Defaults to the simulated La Luz fix; the
    /// view model overwrites it with a real Core Location fix on device.
    var currentFix: Fix {
        get { lock.lock(); defer { lock.unlock() }; return _fix }
        set { lock.lock(); _fix = newValue; lock.unlock() }
    }

    /// The offline trail graph, loaded once from the bundled `graph.bin`.
    var graph: RoutingGraph?

    /// A frame captured for `read_sign`, consumed on the next read.
    var pendingSignImage: CGImage?

    /// The most recent successful route, for the compass arrow + map.
    var lastRoute: RouteResult?
    var lastRouteDestination: RouteDestination?

    // MARK: Event bus

    private var sink: ((AgentEvent) -> Void)?
    /// The engine sets this to the current turn's emit closure so tools can emit.
    func setSink(_ s: ((AgentEvent) -> Void)?) { sink = s }
    func emit(_ e: AgentEvent) { sink?(e) }

    // MARK: Graph loading

    private var graphLoaded = false
    /// Parses the bundled `graph.bin` (3 MB) into the routable structure. Cheap
    /// (<100 ms); safe to call off the main thread during warm-up.
    func loadGraphIfNeeded() {
        guard !graphLoaded else { return }
        guard let url = Bundle.main.url(forResource: "graph", withExtension: "bin") else {
            NSLog("[Helius] graph.bin missing from bundle")
            return
        }
        do {
            let data = try Data(contentsOf: url)
            graph = try RoutingGraph.load(data)
            graphLoaded = true
            NSLog("[Helius] graph loaded: \(graph?.nodeCount ?? 0) nodes, \(graph?.edgeCount ?? 0) edges")
        } catch {
            NSLog("[Helius] graph load failed: \(error)")
        }
    }
}
