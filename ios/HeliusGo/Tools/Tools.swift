import Foundation
import HeliusCore
import LiteRTLM

// The seven Helius tools, as LiteRT-LM `Tool` conformances. LiteRT-LM generates
// each tool's JSON schema from its `@ToolParam` properties, parses the model's
// calls, decodes the arguments, runs `run()`, and feeds the result back — up to
// 25 chained calls — automatically. Tools are stateless (re-instantiated per
// call) so they read live state from `HeliusRuntime.shared` and emit trace
// events onto its bus. The JSON returned from `run()` mirrors the web app's tool
// contract so the model behaves identically.

// MARK: - small helpers

private func fmt4(_ v: Double) -> String { String(format: "%.4f", v) }
private func elapsedMs(_ t0: Date) -> Int { Int((Date().timeIntervalSince(t0) * 1000).rounded()) }

private let hhmmFormatter: DateFormatter = {
    let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none; return f
}()
private func hhmm(_ d: Date) -> String { hhmmFormatter.string(from: d) }

private let isoFormatter = ISO8601DateFormatter()
private func iso(_ d: Date) -> String { isoFormatter.string(from: d) }

// MARK: - locate

struct LocateTool: Tool {
    static let name = "locate"
    static let description =
        "Get the user's current position (lat, lon, accuracy, elevation) from GPS or the simulated fix."

    func run() async throws -> Any {
        let rt = HeliusRuntime.shared
        rt.emit(.toolStarted(name: Self.name, argsSummary: nil))
        let t0 = Date()
        let f = rt.currentFix
        let source = rt.fixIsLive ? "gps" : "demo_preset"
        let offPackKm = HeliusRuntime.coverageKm(lat: f.lat, lon: f.lon)

        var summary = "fix \(fmt4(f.lat)),\(fmt4(f.lon)) ±\(f.accuracyM)m @\(f.elevationM)m"
        var result: [String: Any] = [
            "lat": f.lat, "lon": f.lon, "accuracy_m": f.accuracyM, "elevation_m": f.elevationM,
            "source": source,
            "pack": HeliusRuntime.packName,
            "in_pack_coverage": offPackKm == 0,
        ]
        if offPackKm > 0 {
            // Honest coverage report: the fix is real but the offline trail data
            // doesn't cover it, so routing tools will fail off-network here.
            let kmStr = String(format: "%.0f", offPackKm)
            summary += " — outside \(HeliusRuntime.packName) pack, \(kmStr) km away"
            result["coverage_note"] =
                "Position is outside the \(HeliusRuntime.packName) pack coverage, ~\(kmStr) km from the nearest trail data. Offline routing is unavailable here."
        }
        rt.emit(.toolFinished(name: Self.name, summary: summary, ms: elapsedMs(t0)))
        return result
    }
}

// MARK: - sun_clock

struct SunClockTool: Tool {
    static let name = "sun_clock"
    static let description =
        "Get sunset time and remaining minutes of daylight and usable light at the current position and date."

    func run() async throws -> Any {
        let rt = HeliusRuntime.shared
        rt.emit(.toolStarted(name: Self.name, argsSummary: nil))
        let t0 = Date()
        let f = rt.currentFix
        let now = Date()
        let s = daylightLeft(now: now, lat: f.lat, lon: f.lon)
        let summary = "sunset \(hhmm(s.sunset)), \(s.minutesToSunset) min light, dark in \(s.minutesToDark) min"
        rt.emit(.toolFinished(name: Self.name, summary: summary, ms: elapsedMs(t0)))
        return [
            "now": iso(now),
            "sunset": iso(s.sunset),
            "civil_dusk": iso(s.civilDuskEnd),
            "minutes_to_sunset": s.minutesToSunset,
            "minutes_to_dark": s.minutesToDark,
        ]
    }
}

// MARK: - pace_eta

struct PaceEtaTool: Tool {
    static let name = "pace_eta"
    static let description =
        "Estimate walking time (Naismith's rule) for a given distance and optional climb, and whether it beats sunset."

    // NOTE: property names MUST be camelCase. LiteRT-LM exposes them to the model
    // as snake_case (distanceM → distance_m) and decodes the model's args with
    // JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase, which converts the
    // incoming snake_case keys to camelCase before matching CodingKeys. A
    // snake_case property (distance_m) therefore fails to decode (keyNotFound) and
    // the whole tool call throws. Verified with a standalone repro.
    @ToolParam(description: "Distance to cover, in meters.")
    var distanceM: Double
    @ToolParam(description: "Total climb along the way, in meters (0 if flat or descending).")
    var ascentM: Double?

    func run() async throws -> Any {
        let rt = HeliusRuntime.shared
        rt.emit(.toolStarted(name: Self.name, argsSummary: "\(Int(distanceM)) m"))
        let t0 = Date()
        let etaMin = paceEtaMinutes(distanceM: distanceM, ascentM: ascentM ?? 0)
        let now = Date()
        let arrival = now.addingTimeInterval(Double(etaMin) * 60)
        let f = rt.currentFix
        let sun = daylightLeft(now: now, lat: f.lat, lon: f.lon)
        let marginMin = sun.minutesToSunset - etaMin
        let verdict = marginMin >= 0 ? "\(marginMin) min before sunset" : "\(-marginMin) min AFTER sunset"
        let summary = "ETA \(etaMin) min, arrive \(hhmm(arrival)) — \(verdict)"
        rt.emit(.toolFinished(name: Self.name, summary: summary, ms: elapsedMs(t0)))
        return [
            "eta_min": etaMin,
            "arrival": iso(arrival),
            "distance_m": Int(distanceM.rounded()),
            "ascent_m": Int((ascentM ?? 0).rounded()),
            "margin_min": marginMin,
            "beats_sunset": marginMin >= 0,
        ]
    }
}

// MARK: - route_back

struct RouteBackTool: Tool {
    static let name = "route_back"
    static let description =
        "Compute a walking route from the current position back to a known safe destination over the offline trail graph. Returns distance, ETA, and waypoint count."

    @ToolParam(description: "Which safe point to route to: trailhead, crest, or tram_station.")
    var destination: String

    func run() async throws -> Any {
        let rt = HeliusRuntime.shared
        rt.emit(.toolStarted(name: Self.name, argsSummary: destination))
        let t0 = Date()

        guard let graph = rt.graph else {
            rt.emit(.toolFailed(name: Self.name, summary: "route data unavailable", ms: elapsedMs(t0)))
            return ["error": "pack_unavailable"]
        }
        let dest = RouteDestination(rawValue: destination) ?? .trailhead
        let f = rt.currentFix
        let result = graph.findRoute(from: LatLon(lat: f.lat, lon: f.lon), to: dest.coord)

        if let err = result.error {
            let data: [String: Any]
            let summary: String
            switch err {
            case .offNetwork(let m):
                let mi = Int(m.rounded())
                summary = "off-network (~\(mi) m from nearest trail) — can't route to \(dest.displayName)"
                data = ["error": "off_network", "nearest_m": mi, "dest": dest.displayName]
            case .noPath:
                summary = "no trail path to \(dest.displayName)"
                data = ["error": "no_path", "dest": dest.displayName]
            }
            rt.emit(.toolFailed(name: Self.name, summary: summary, ms: elapsedMs(t0)))
            return data
        }

        rt.lastRoute = result
        rt.lastRouteDestination = dest
        rt.emit(.route(distanceM: result.distanceM, etaMin: result.etaMin, waypointCount: result.coordinates.count))

        let km = result.distanceM / 1000
        let mi = km * 0.621371
        let summary = "route to \(dest.displayName): \(String(format: "%.2f", km)) km / \(String(format: "%.2f", mi)) mi, ~\(Int(result.etaMin.rounded())) min, \(result.coordinates.count) pts"
        rt.emit(.toolFinished(name: Self.name, summary: summary, ms: elapsedMs(t0)))
        return [
            "status": "ready",
            "dest": dest.displayName,
            "distance_m": Int(result.distanceM.rounded()),
            "distance_mi": Double((mi * 100).rounded() / 100),
            "eta_min": Int(result.etaMin.rounded()),
            "waypoints": result.coordinates.count,
        ]
    }
}

// MARK: - morse_beacon

struct MorseBeaconTool: Tool {
    static let name = "morse_beacon"
    static let description =
        "Arm, start, or stop the phone's torch flashing a Morse message (default SOS) to make the user findable at night."

    @ToolParam(description: "Action: arm (prepare), start (begin flashing), or stop (end flashing).")
    var mode: String
    @ToolParam(description: "Message to flash. Defaults to SOS.")
    var message: String?

    func run() async throws -> Any {
        let rt = HeliusRuntime.shared
        let msg = (message?.isEmpty == false) ? message! : "SOS"
        let action = (mode == "start") ? "start" : (mode == "stop" ? "stop" : "arm")
        rt.emit(.toolStarted(name: Self.name, argsSummary: "\(action) \(msg)"))
        let t0 = Date()
        let pattern = Morse.encode(msg)

        switch action {
        case "start":
            TorchController.shared.start(message: msg)
            rt.emit(.beacon(active: true, pattern: pattern, message: msg))
        case "stop":
            TorchController.shared.stop()
            rt.emit(.beacon(active: false, pattern: pattern, message: msg))
        default:
            rt.emit(.beacon(active: false, pattern: pattern, message: msg))
        }

        let state = action == "start" ? "flashing" : (action == "stop" ? "stopped" : "armed")
        let summary = "\(msg) beacon \(state) (\(pattern))"
        rt.emit(.toolFinished(name: Self.name, summary: summary, ms: elapsedMs(t0)))
        return [
            "state": state,
            "message": msg,
            "pattern": pattern,
            "unit_ms": 200,
            "has_torch": TorchController.shared.hasTorch,
        ]
    }
}

// MARK: - safety_plan

struct SafetyPlanTool: Tool {
    static let name = "safety_plan"
    static let description =
        "Produce a short, ordered field-safety checklist (shelter, signal, stay-put vs move) from the current position and remaining light. Non-medical."

    @ToolParam(description: "Optional one-line description of the situation.")
    var situation: String?

    func run() async throws -> Any {
        let rt = HeliusRuntime.shared
        rt.emit(.toolStarted(name: Self.name, argsSummary: nil))
        let t0 = Date()
        let f = rt.currentFix
        let sun = daylightLeft(now: Date(), lat: f.lat, lon: f.lon)
        let dark = sun.minutesToDark
        let stayPut = dark < 45

        let steps: [String]
        if stayPut {
            steps = [
                "Stop moving now — with under 45 minutes of light, staying put beats stumbling in the dark.",
                "Find shelter from wind: get below a ridgeline, behind rock or trees, off wet ground.",
                "Arm the Morse beacon (SOS) so searchers and aircraft can spot you after dark.",
                "Put on every layer you have and insulate yourself from the ground before you cool down.",
                "Signal in threes — three whistle blasts or light flashes — and repeat on a regular interval.",
            ]
        } else {
            steps = [
                "Move now — you have about \(dark) minutes of usable light; use it to reach a known point.",
                "Use route_back to the nearest safe destination and check the ETA against sunset with pace_eta.",
                "Keep the descent conservative: known trail over shortcuts, steady pace, no scrambling.",
                "Set a turnaround rule: if light runs out before you arrive, stop and arm the beacon.",
                "Tell someone your plan if you have any signal; otherwise leave it for when you regain it.",
            ]
        }

        let summary = stayPut
            ? "stay-put plan (\(dark) min light): shelter, signal, insulate"
            : "move-now plan (\(dark) min light): route, pace, turnaround"
        rt.emit(.toolFinished(name: Self.name, summary: summary, ms: elapsedMs(t0)))
        return [
            "stay_put": stayPut,
            "minutes_to_dark": dark,
            "steps": steps,
            "note": "Non-medical guidance. For injury or illness, contact emergency services when reachable.",
        ]
    }
}

// MARK: - read_sign

struct ReadSignTool: Tool {
    static let name = "read_sign"
    static let description =
        "Read and translate the trail sign the user just photographed. The captured photo is already available on-device — call this whenever the user asks you to read, translate, or interpret a sign. Transcribes the sign, translates it to English if needed, and gives one short actionable line."

    func run() async throws -> Any {
        let rt = HeliusRuntime.shared
        rt.emit(.toolStarted(name: Self.name, argsSummary: nil))
        let t0 = Date()
        guard let img = rt.pendingSignImage else {
            rt.emit(.toolFailed(name: Self.name, summary: "no camera frame", ms: elapsedMs(t0)))
            return ["error": "no_camera_frame", "hint": "Point the camera at the sign, then ask again."]
        }
        let text = SignReader.recognizeText(in: img).trimmingCharacters(in: .whitespacesAndNewlines)
        rt.pendingSignImage = nil
        let summary = text.isEmpty ? "no text found" : (text.count > 80 ? String(text.prefix(77)) + "…" : text)
        rt.emit(.toolFinished(name: Self.name, summary: summary, ms: elapsedMs(t0)))
        return ["text": text.isEmpty ? "(no readable text on the sign)" : text]
    }
}

// MARK: - registry

enum HeliusTools {
    /// Fresh tool instances for a conversation. Order is informational only.
    static func all() -> [Tool] {
        [
            LocateTool(), SunClockTool(), PaceEtaTool(), RouteBackTool(),
            MorseBeaconTool(), SafetyPlanTool(), ReadSignTool(),
        ]
    }
}
