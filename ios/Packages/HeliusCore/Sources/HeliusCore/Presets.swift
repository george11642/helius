import Foundation

/// A GPS fix. In the field this is fed by Core Location; in the demo it is the
/// baked-in simulated position. Mirrors `src/tools/location.ts::GpsFix`.
public struct Fix: Sendable, Equatable {
    public let lat: Double
    public let lon: Double
    public let accuracyM: Int
    public let elevationM: Int
    public init(lat: Double, lon: Double, accuracyM: Int, elevationM: Int) {
        self.lat = lat
        self.lon = lon
        self.accuracyM = accuracyM
        self.elevationM = elevationM
    }

    /// Default simulated fix: La Luz trail upper switchbacks (the demo start).
    public static let lostHiker = Fix(lat: 35.1983, lon: -106.4439, accuracyM: 14, elevationM: 2926)
}

/// Route destinations. Slot order matches `src/tools/route.ts::DEST_SLOT`
/// (trailhead=0, crest=1, tram_station=2); coordinates come from the sandia
/// pack's pois.json trailheads[0/1/2].
public enum RouteDestination: String, CaseIterable, Sendable {
    case trailhead
    case crest
    case tram_station

    public var displayName: String {
        switch self {
        case .trailhead: return "La Luz Trailhead"
        case .crest: return "Sandia Crest House"
        case .tram_station: return "Tram Top Station"
        }
    }

    public var coord: LatLon {
        switch self {
        case .trailhead: return LatLon(lat: 35.2286, lon: -106.4818)
        case .crest: return LatLon(lat: 35.2103, lon: -106.4485)
        case .tram_station: return LatLon(lat: 35.1899, lon: -106.4059)
        }
    }
}

/// Naismith-rule walking-time estimate in whole minutes: 5 km/h on the flat
/// (83.33 m/min) plus 1 min per 10 m of climb. Mirrors `registry.ts` pace_eta
/// (ascent clamped at 0, result rounded).
public func paceEtaMinutes(distanceM: Double, ascentM: Double) -> Int {
    let ascent = max(0, ascentM)
    let flatMin = distanceM / (5000.0 / 60.0)
    let climbMin = ascent / 10.0
    return Int((flatMin + climbMin).rounded())
}
