import Foundation
import Combine
import CoreLocation
import CoreGraphics
import HeliusCore

/// Owns app state and turns the engine/tool `AgentEvent` stream into observable
/// UI state. Plain `ObservableObject` (not `@MainActor`) targeting iOS 16; every
/// `@Published` mutation is funneled onto the main thread.
final class HeliusViewModel: ObservableObject {
    // Transcript + trace
    @Published var messages: [ChatMessage] = []
    @Published var chips: [TraceChip] = []
    @Published var input = ""

    // Engine
    @Published var lifecycle: EngineLifecycle = .idle
    @Published private(set) var engineKind: EngineKind = .liteRT

    // Side-effects surfaced in the UI
    @Published var beaconActive = false
    @Published var beaconPattern = "... --- ..."
    @Published var routeDistanceM: Double?
    @Published var routeEtaMin: Double?
    @Published var relativeBearing: Double?
    @Published var routeTargetName = ""

    // GPS / voice
    @Published var gpsLive = false
    @Published var isListening = false

    let location = LocationProvider()
    let speech = SpeechRecognizer()
    let speaker = Speaker()

    private let engine: HeliusEngine
    private var currentHeliusId: UUID?
    private var targetCoord: LatLon?
    private var deviceHeading: Double?
    private var bag = Set<AnyCancellable>()

    // Sandia pack bbox [minLon, minLat, maxLon, maxLat] — real fixes outside this
    // (e.g. a simulator's default location) are ignored so routing stays valid.
    private let packBBox = (minLon: -107.15, minLat: 34.65, maxLon: -106.15, maxLat: 35.55)

    var backendLabel: String { "CPU" }

    init() {
        if ProcessInfo.processInfo.environment["HELIUS_ENGINE"] == "mock" {
            engine = MockEngine()
            engineKind = .mock
        } else {
            engine = LiteRTEngine()
            engineKind = .liteRT
        }

        location.$lastLocation
            .receive(on: DispatchQueue.main)
            .compactMap { $0 }
            .sink { [weak self] loc in self?.onLocation(loc) }
            .store(in: &bag)
        location.$heading
            .receive(on: DispatchQueue.main)
            .compactMap { $0 }
            .sink { [weak self] h in self?.onHeading(h) }
            .store(in: &bag)
    }

    func onAppear() {
        location.start()
        speech.requestAuthorization()
        Task.detached(priority: .userInitiated) { [weak self] in
            HeliusRuntime.shared.loadGraphIfNeeded()
            await self?.warmUp()
        }
    }

    private func warmUp() async {
        setStatus(.loading("starting \(engineKind.rawValue)…"))
        do {
            try await engine.warmUp { [weak self] s in
                DispatchQueue.main.async { self?.lifecycle = .loading(s) }
            }
            setStatus(.ready)
        } catch {
            setStatus(.error("\(error)".prefix(60).description))
        }
    }

    // MARK: Sending

    func sendCurrentInput() { send(input) }

    func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard case .ready = lifecycle else { return }

        messages.append(ChatMessage(role: .user, text: text))
        let helius = ChatMessage(role: .helius, text: "")
        currentHeliusId = helius.id
        messages.append(helius)
        chips = []
        input = ""
        lifecycle = .thinking

        let emit: (AgentEvent) -> Void = { event in
            DispatchQueue.main.async { self.reduce(event) }
        }
        let engine = self.engine
        Task.detached(priority: .userInitiated) {
            await engine.send(text, emit: emit)
        }
    }

    private func reduce(_ e: AgentEvent) {
        switch e {
        case .turnStarted:
            break
        case .token(let delta):
            appendHelius(delta)
        case .toolStarted(let name, _):
            chips.append(TraceChip(name: name, state: .running))
        case .toolFinished(let name, let summary, let ms):
            if let i = chips.lastIndex(where: { $0.name == name && $0.state == .running }) {
                chips[i].state = .done
                chips[i].summary = summary
                chips[i].ms = ms
            }
        case .toolFailed(let name, let summary, let ms):
            if let i = chips.lastIndex(where: { $0.name == name && $0.state == .running }) {
                chips[i].state = .failed
                chips[i].summary = summary
                chips[i].ms = ms
            }
        case .route(let d, let eta, _):
            routeDistanceM = d
            routeEtaMin = eta
            routeTargetName = HeliusRuntime.shared.lastRouteDestination?.displayName ?? "waypoint"
            updateRouteTarget()
        case .beacon(let active, let pattern):
            beaconActive = active
            beaconPattern = pattern
        case .assistantFinal(let text):
            setHelius(text)
            if speaker.enabled { speaker.speak(text) }
        case .turnEnded:
            lifecycle = .ready
        case .failed(let msg):
            setHelius("(problem: \(msg))")
            lifecycle = .ready
        }
    }

    // MARK: Voice

    func micPressed() {
        guard case .ready = lifecycle else { return }
        speech.start()
        isListening = true
    }

    func micReleased() {
        let text = speech.stop()
        isListening = false
        if !text.isEmpty { send(text) }
    }

    // MARK: Beacon / camera

    func stopBeacon() {
        TorchController.shared.stop()
        beaconActive = false
    }

    func onSignImage(_ cg: CGImage) {
        HeliusRuntime.shared.pendingSignImage = cg
        send("Read this trail sign and tell me, in one line, what it means for my hike.")
    }

    // MARK: Location / compass

    private func onLocation(_ loc: CLLocation) {
        let c = loc.coordinate
        guard c.longitude >= packBBox.minLon, c.longitude <= packBBox.maxLon,
              c.latitude >= packBBox.minLat, c.latitude <= packBBox.maxLat else {
            return // outside the loaded pack — keep the simulated fix
        }
        gpsLive = true
        HeliusRuntime.shared.currentFix = Fix(
            lat: c.latitude,
            lon: c.longitude,
            accuracyM: Int(max(1, loc.horizontalAccuracy)),
            elevationM: Int(loc.altitude)
        )
        recomputeBearing()
    }

    private func onHeading(_ h: CLHeading) {
        deviceHeading = h.trueHeading >= 0 ? h.trueHeading : h.magneticHeading
        recomputeBearing()
    }

    private func updateRouteTarget() {
        guard let coords = HeliusRuntime.shared.lastRoute?.coordinates, coords.count > 1 else {
            targetCoord = nil
            return
        }
        targetCoord = coords[1] // the next point along the route after the start
        recomputeBearing()
    }

    private func recomputeBearing() {
        guard let t = targetCoord else { relativeBearing = nil; return }
        let f = HeliusRuntime.shared.currentFix
        let target = bearingDeg(fromLat: f.lat, fromLon: f.lon, toLat: t.lat, toLon: t.lon)
        if let h = deviceHeading {
            var rel = (target - h).truncatingRemainder(dividingBy: 360)
            if rel < 0 { rel += 360 }
            relativeBearing = rel
        } else {
            relativeBearing = target // no compass (e.g. simulator): show north-up bearing
        }
    }

    // MARK: helpers

    private func appendHelius(_ delta: String) {
        guard let id = currentHeliusId, let i = messages.lastIndex(where: { $0.id == id }) else { return }
        messages[i].text += delta
    }

    private func setHelius(_ text: String) {
        guard let id = currentHeliusId, let i = messages.lastIndex(where: { $0.id == id }) else { return }
        messages[i].text = text
    }

    private func setStatus(_ s: EngineLifecycle) {
        DispatchQueue.main.async { self.lifecycle = s }
    }
}

/// Initial bearing (degrees, 0 = north) along the great circle from A to B.
func bearingDeg(fromLat: Double, fromLon: Double, toLat: Double, toLon: Double) -> Double {
    let dLon = (toLon - fromLon) * .pi / 180
    let y1 = fromLat * .pi / 180
    let y2 = toLat * .pi / 180
    let y = sin(dLon) * cos(y2)
    let x = cos(y1) * sin(y2) - sin(y1) * cos(y2) * cos(dLon)
    let deg = atan2(y, x) * 180 / .pi
    return deg < 0 ? deg + 360 : deg
}
