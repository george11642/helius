import Foundation
import WebKit
import HeliusCore

/// Swift → JS bridge into the embedded MapLibre page (web-map/map.js).
///
/// Commands issued before the page reports `ready` are queued and flushed in
/// order once it does — the map takes a beat to boot while the engine and GPS
/// are already producing state. All calls main-thread only (WKWebView rule).
final class MapBridge: NSObject, ObservableObject {
    @Published private(set) var isReady = false
    @Published private(set) var lastError: String?

    weak var webView: WKWebView?
    private var pending: [String] = []

    // MARK: commands

    func setFix(lat: Double, lon: Double, accuracyM: Int) {
        run("window.heliusMap && heliusMap.setFix(\(lat), \(lon), \(accuracyM));")
    }

    /// Draws the route with the web renderer's animated reveal.
    /// - Parameter coordinates: start → destination, in HeliusCore lat/lon.
    func drawRoute(_ coordinates: [LatLon], animateMs: Int = 1800) {
        let pairs = coordinates.map { [$0.lon, $0.lat] }
        guard let data = try? JSONSerialization.data(withJSONObject: pairs),
              let json = String(data: data, encoding: .utf8) else { return }
        run("window.heliusMap && heliusMap.drawRoute(\(json), \(animateMs));")
    }

    func clearRoute() {
        run("window.heliusMap && heliusMap.clearRoute();")
    }

    // MARK: page lifecycle (called by MapWebView's coordinator)

    func pageDidBecomeReady() {
        isReady = true
        let queued = pending
        pending = []
        for js in queued { evaluate(js) }
    }

    func pageDidReport(error: String) {
        lastError = error
        NSLog("[HeliusMap] page error: \(error)")
    }

    func pageDidReset() {
        isReady = false
    }

    // MARK: internals

    private func run(_ js: String) {
        if Thread.isMainThread {
            isReady ? evaluate(js) : pending.append(js)
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.isReady ? self.evaluate(js) : self.pending.append(js)
            }
        }
    }

    private func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js) { _, error in
            if let error { NSLog("[HeliusMap] evaluateJavaScript failed: \(error)") }
        }
    }
}
