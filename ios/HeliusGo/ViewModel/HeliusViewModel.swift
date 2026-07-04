import Foundation
import Combine
import CoreLocation
import CoreGraphics
import UIKit
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
    @Published var beaconMessage = "SOS"
    @Published var routeDistanceM: Double?
    @Published var routeEtaMin: Double?
    @Published var relativeBearing: Double?
    @Published var routeTargetName = ""

    // GPS / voice
    @Published var gpsLive = false
    @Published var isListening = false

    /// Demo Mode pins the position to the La Luz preset (for indoor demos and
    /// the simulator). Off = real Core Location fixes are used wherever you are;
    /// `locate` then reports pack coverage honestly. Persisted across launches.
    @Published var demoMode: Bool {
        didSet {
            UserDefaults.standard.set(demoMode, forKey: Self.demoModeKey)
            applyFixSource()
        }
    }

    let location = LocationProvider()
    let speech = SpeechRecognizer()
    let speaker = Speaker()
    let mapBridge = MapBridge()

    private var engine: HeliusEngine
    private var currentHeliusId: UUID?
    private var targetCoord: LatLon?
    private var deviceHeading: Double?
    private var lastRealFix: CLLocation?
    private var bag = Set<AnyCancellable>()

    private static let demoModeKey = "helius.demoMode"
    private static let engineKey = "helius.engine"

    var packName: String { HeliusRuntime.packName }
    var backendLabel: String { "CPU" }

    init() {
        // Demo Mode defaults ON so the canonical La Luz scene works out of the
        // box (simulator, indoor demo); turning it off uses real GPS anywhere.
        demoMode = UserDefaults.standard.object(forKey: Self.demoModeKey) as? Bool ?? true

        if Self.preferredEngineKind() == .mock {
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
        pushFixToMap() // seed the map with the current (preset or live) fix
        Task.detached(priority: .userInitiated) { [weak self] in
            HeliusRuntime.shared.loadGraphIfNeeded()
            await self?.warmUp()
        }
    }

    // MARK: Engine selection

    private static func preferredEngineKind() -> EngineKind {
        if let env = ProcessInfo.processInfo.environment["HELIUS_ENGINE"] {
            return env == "mock" ? .mock : .liteRT
        }
        return UserDefaults.standard.string(forKey: engineKey) == "mock" ? .mock : .liteRT
    }

    /// Settings toggle: swap engines live. The old engine is dropped and the
    /// new one warmed up; the preference persists across launches.
    func switchEngine(to kind: EngineKind) {
        guard kind != engineKind else { return }
        UserDefaults.standard.set(kind == .mock ? "mock" : "litert", forKey: Self.engineKey)
        engine = kind == .mock ? MockEngine() : LiteRTEngine()
        engineKind = kind
        Task.detached(priority: .userInitiated) { [weak self] in
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
            runTestSignIfRequested()
            runTestBeaconIfRequested()
        } catch {
            setStatus(.error("\(error)".prefix(60).description))
        }
    }

    /// DEBUG-only test affordance: when launched with `HELIUS_TEST_SIGN=<image path>`,
    /// load that image as the pending sign and fire read_sign — so the OCR→Gemma
    /// translate path can be verified on the simulator without driving the
    /// out-of-process photo picker. Never compiled into release builds.
    private func runTestSignIfRequested() {
        #if DEBUG
        guard let path = ProcessInfo.processInfo.environment["HELIUS_TEST_SIGN"],
              !path.isEmpty, let img = UIImage(contentsOfFile: path)?.cgImage else { return }
        DispatchQueue.main.async {
            HeliusRuntime.shared.pendingSignImage = img
            self.send(Self.readSignPrompt, display: "\u{1F4F7} Read this trail sign.")
        }
        #endif
    }

    /// DEBUG-only test affordance: `HELIUS_TEST_BEACON=1` arms the SOS beacon
    /// right after warm-up, so the no-torch screen-strobe fallback can be
    /// exercised on the simulator (the mock engine's script never calls
    /// morse_beacon). Never compiled into release builds.
    private func runTestBeaconIfRequested() {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["HELIUS_TEST_BEACON"] == "1" else { return }
        DispatchQueue.main.async {
            TorchController.shared.start(message: "SOS")
            self.reduce(.beacon(active: true, pattern: Morse.encode("SOS"), message: "SOS"))
        }
        #endif
    }

    // MARK: Sending

    func sendCurrentInput() { send(input) }

    /// - Parameter display: optional text shown in the user bubble instead of `raw`
    ///   (the model still receives `raw`). Used by the sign-capture flow to show a
    ///   clean "Read this trail sign" while sending the model an explicit read_sign
    ///   instruction.
    func send(_ raw: String, display: String? = nil) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard case .ready = lifecycle else { return }

        messages.append(ChatMessage(role: .user, text: display ?? text))
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
            if let coords = HeliusRuntime.shared.lastRoute?.coordinates, coords.count > 1 {
                mapBridge.drawRoute(coords)
            }
        case .beacon(let active, let pattern, let message):
            beaconActive = active
            beaconPattern = pattern
            beaconMessage = message
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

    /// The prompt auto-sent after a sign photo is captured. Phrased to signal that a
    /// photo now exists, so the model calls read_sign instead of asking for an image.
    static let readSignPrompt =
        "Use the read_sign tool now to read the trail sign I just photographed (the photo is already captured on-device), then translate it to English and tell me in one line what it means for my hike."

    func onSignImage(_ cg: CGImage) {
        HeliusRuntime.shared.pendingSignImage = cg
        send(Self.readSignPrompt, display: "\u{1F4F7} Read this trail sign.")
    }

    // MARK: Location / compass

    /// Real fixes are accepted ANYWHERE (no bbox gate) unless Demo Mode pins
    /// the position to the La Luz preset. `locate` reports pack coverage
    /// honestly when the real position is outside the Sandia data.
    private func onLocation(_ loc: CLLocation) {
        lastRealFix = loc
        guard !demoMode else { return }
        applyRealFix(loc)
    }

    private func applyRealFix(_ loc: CLLocation) {
        let c = loc.coordinate
        gpsLive = true
        HeliusRuntime.shared.currentFix = Fix(
            lat: c.latitude,
            lon: c.longitude,
            accuracyM: Int(max(1, loc.horizontalAccuracy)),
            elevationM: Int(loc.altitude)
        )
        HeliusRuntime.shared.fixIsLive = true
        pushFixToMap()
        recomputeBearing()
    }

    /// Re-syncs runtime fix + map after a Demo Mode flip.
    private func applyFixSource() {
        if demoMode {
            HeliusRuntime.shared.currentFix = .lostHiker
            HeliusRuntime.shared.fixIsLive = false
            gpsLive = false
            pushFixToMap()
            recomputeBearing()
        } else if let loc = lastRealFix {
            applyRealFix(loc)
        }
    }

    private func pushFixToMap() {
        let f = HeliusRuntime.shared.currentFix
        mapBridge.setFix(lat: f.lat, lon: f.lon, accuracyM: f.accuracyM)
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
