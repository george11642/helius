import Foundation

/// A geographic coordinate in decimal degrees.
public struct LatLon: Equatable, Sendable {
    public let lat: Double
    public let lon: Double
    public init(lat: Double, lon: Double) {
        self.lat = lat
        self.lon = lon
    }
}

/// Great-circle distance in meters between two coordinates.
///
/// Ported verbatim from `src/map/graph-core.mjs::haversineM` (R = 6_371_000 m).
public func haversineM(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
    let R = 6_371_000.0
    let p1 = lat1 * Double.pi / 180
    let p2 = lat2 * Double.pi / 180
    let dPhi = (lat2 - lat1) * Double.pi / 180
    let dLambda = (lon2 - lon1) * Double.pi / 180
    let sPhi = sin(dPhi / 2)
    let sLambda = sin(dLambda / 2)
    let a = sPhi * sPhi + cos(p1) * cos(p2) * sLambda * sLambda
    return 2 * R * asin(sqrt(a))
}
