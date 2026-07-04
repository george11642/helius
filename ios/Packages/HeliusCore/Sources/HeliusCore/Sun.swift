import Foundation

// Offline sunset/sunrise math (NOAA solar-position approximation).
// Deterministic, no network, no deps. Ported verbatim from `src/lib/sun.ts`;
// good to ~1 minute — plenty for field use.

private let RAD = Double.pi / 180
private let DAY_MS = 86_400_000.0
private let J1970 = 2_440_588.0
private let J2000 = 2_451_545.0

/// Matches JavaScript `Math.round` (round half toward +infinity) rather than
/// Swift's default round-half-away-from-zero, so the ported math stays bit-faithful.
@inline(__always) private func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

private func toJulian(_ date: Date) -> Double { date.timeIntervalSince1970 * 1000.0 / DAY_MS - 0.5 + J1970 }
private func fromJulian(_ j: Double) -> Date { Date(timeIntervalSince1970: (j + 0.5 - J1970) * DAY_MS / 1000.0) }
private func toDays(_ date: Date) -> Double { toJulian(date) - J2000 }

private func solarMeanAnomaly(_ d: Double) -> Double { RAD * (357.5291 + 0.98560028 * d) }
private func eclipticLongitude(_ M: Double) -> Double {
    let C = RAD * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M))
    let P = RAD * 102.9372
    return M + C + P + Double.pi
}
private func declination(_ L: Double) -> Double { asin(sin(L) * sin(RAD * 23.4397)) }

private func julianCycle(_ d: Double, _ lw: Double) -> Double { jsRound(d - 0.0009 - lw / (2 * Double.pi)) }
private func approxTransit(_ Ht: Double, _ lw: Double, _ n: Double) -> Double { 0.0009 + (Ht + lw) / (2 * Double.pi) + n }
private func solarTransitJ(_ ds: Double, _ M: Double, _ L: Double) -> Double {
    J2000 + ds + 0.0053 * sin(M) - 0.0069 * sin(2 * L)
}
// cos is clamped to [-1,1]: at polar day/night the raw value leaves the acos
// domain and would yield NaN. Clamping degrades gracefully.
private func hourAngle(_ h: Double, _ phi: Double, _ dec: Double) -> Double {
    let v = (sin(h) - sin(phi) * sin(dec)) / (cos(phi) * cos(dec))
    return acos(max(-1, min(1, v)))
}

/// Sunrise, sunset, and civil-dusk-end (last usable light) for a date + location.
public func sunTimes(date: Date, lat: Double, lon: Double) -> (sunrise: Date, sunset: Date, civilDuskEnd: Date) {
    let lw = RAD * -lon
    let phi = RAD * lat
    let d = toDays(date)
    let n = julianCycle(d, lw)
    let M = solarMeanAnomaly(approxTransit(0, lw, n))
    let L = eclipticLongitude(M)
    let dec = declination(L)

    func timeAt(_ angleDeg: Double, _ rising: Bool) -> Date {
        let w = hourAngle(RAD * angleDeg, phi, dec)
        let a = approxTransit(rising ? -w : w, lw, n)
        return fromJulian(solarTransitJ(a, M, L))
    }

    return (
        sunrise: timeAt(-0.833, true),
        sunset: timeAt(-0.833, false),
        civilDuskEnd: timeAt(-6, false)
    )
}

/// Daylight-remaining summary: sun times plus whole-minute countdowns to sunset
/// and to full (civil) dark, clamped at 0.
public struct SunResult: Equatable, Sendable {
    public let sunrise: Date
    public let sunset: Date
    public let civilDuskEnd: Date
    public let minutesToSunset: Int
    public let minutesToDark: Int
    public init(sunrise: Date, sunset: Date, civilDuskEnd: Date, minutesToSunset: Int, minutesToDark: Int) {
        self.sunrise = sunrise
        self.sunset = sunset
        self.civilDuskEnd = civilDuskEnd
        self.minutesToSunset = minutesToSunset
        self.minutesToDark = minutesToDark
    }
}

public func daylightLeft(now: Date, lat: Double, lon: Double) -> SunResult {
    let t = sunTimes(date: now, lat: lat, lon: lon)
    let minutes = max(0, Int(jsRound(t.sunset.timeIntervalSince(now) / 60.0)))
    let duskMinutes = max(0, Int(jsRound(t.civilDuskEnd.timeIntervalSince(now) / 60.0)))
    return SunResult(
        sunrise: t.sunrise,
        sunset: t.sunset,
        civilDuskEnd: t.civilDuskEnd,
        minutesToSunset: minutes,
        minutesToDark: duskMinutes
    )
}
