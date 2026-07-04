import XCTest
@testable import HeliusCore

final class HeliusCoreTests: XCTestCase {

    // Real pack graph, referenced by absolute path (not copied into the repo).
    static let graphPath = "/Users/georgeteifel/dev/helius/public/data/packs/sandia/graph.bin"

    private func loadGraphData() throws -> Data {
        let url = URL(fileURLWithPath: Self.graphPath)
        return try Data(contentsOf: url)
    }

    private func loadGraph() throws -> RoutingGraph {
        try RoutingGraph.load(loadGraphData())
    }

    // MARK: - 1. Parse sanity

    func testParseSanity() throws {
        let data = try loadGraphData()

        // magic == "HLXG"
        let magic = String(bytes: data.prefix(4), encoding: .ascii)
        XCTAssertEqual(magic, "HLXG", "bad magic bytes")

        let rg = try RoutingGraph.load(data)
        XCTAssertEqual(rg.version, 1, "version must be 1")

        // file length == 44 + nodeCount*8 + edgeCount*20 + polylinePointCount*8 + tagsBlobBytes
        let expected = 44 + rg.nodeCount * 8 + rg.edgeCount * 20 + rg.polylinePointCount * 8 + rg.tagsBlobBytes
        XCTAssertEqual(data.count, expected, "file length does not match header-derived size")
        XCTAssertEqual(expected, rg.expectedFileLength)

        XCTAssertGreaterThan(rg.nodeCount, 0)
        XCTAssertGreaterThan(rg.edgeCount, 0)
        print("[parse] nodes=\(rg.nodeCount) edges=\(rg.edgeCount) polyPts=\(rg.polylinePointCount) tagsBytes=\(rg.tagsBlobBytes) fileLen=\(data.count)")
    }

    // MARK: - 2. La Luz route (the non-negotiable test)

    func testLaLuzRouteDistanceWithinOnePercent() throws {
        let rg = try loadGraph()
        let from = LatLon(lat: Fix.lostHiker.lat, lon: Fix.lostHiker.lon)
        let result = rg.findRoute(from: from, to: RouteDestination.trailhead.coord)

        XCTAssertNil(result.error, "route should succeed, got \(String(describing: result.error))")

        let oracle = 10_640.0
        let pctDiff = abs(result.distanceM - oracle) / oracle * 100
        print(String(format: "[laluz] distanceM=%.1f m  etaMin=%.1f  steps=%d  coords=%d  diff=%.3f%% vs %.0f",
                     result.distanceM, result.etaMin, result.steps.count, result.coordinates.count, pctDiff, oracle))
        if let first = result.steps.first { print("[laluz] first step: \(first.instruction)") }

        XCTAssertLessThanOrEqual(pctDiff, 1.0, "distance \(result.distanceM) not within 1% of \(oracle)")
        XCTAssertGreaterThan(result.etaMin, 0)
        XCTAssertGreaterThan(result.steps.count, 0)
        XCTAssertGreaterThan(result.coordinates.count, 1)
        XCTAssertNil(result.ascentM, "v1 graph has no elevation; ascentM must be nil")
    }

    // MARK: - 3. Sun math

    func testSunTimesEveningWindow() throws {
        var cal = Calendar(identifier: .gregorian)
        let denver = TimeZone(identifier: "America/Denver")!
        cal.timeZone = denver

        var comps = DateComponents()
        comps.year = 2026; comps.month = 7; comps.day = 4; comps.hour = 12; comps.minute = 0
        let noon = cal.date(from: comps)!

        let lat = Fix.lostHiker.lat
        let lon = Fix.lostHiker.lon
        let t = sunTimes(date: noon, lat: lat, lon: lon)

        // civil dusk is after sunset; sunset is after sunrise.
        XCTAssertGreaterThan(t.sunset, t.sunrise, "sunset should be after sunrise")
        XCTAssertGreaterThan(t.civilDuskEnd, t.sunset, "civil dusk should be after sunset")

        // Sunset falls in a sane evening window (local time).
        let sunsetHour = cal.component(.hour, from: t.sunset)
        XCTAssertGreaterThanOrEqual(sunsetHour, 19, "sunset hour \(sunsetHour) too early")
        XCTAssertLessThanOrEqual(sunsetHour, 21, "sunset hour \(sunsetHour) too late")

        let sun = daylightLeft(now: noon, lat: lat, lon: lon)
        XCTAssertGreaterThan(sun.minutesToSunset, 0)
        XCTAssertGreaterThanOrEqual(sun.minutesToDark, sun.minutesToSunset, "dark countdown must be >= sunset countdown")

        let fmt = DateFormatter()
        fmt.timeZone = denver
        fmt.dateFormat = "HH:mm"
        print("[sun] sunrise=\(fmt.string(from: t.sunrise)) sunset=\(fmt.string(from: t.sunset)) dusk=\(fmt.string(from: t.civilDuskEnd)) toSunset=\(sun.minutesToSunset)m toDark=\(sun.minutesToDark)m")
    }

    // MARK: - 4. haversine sanity

    func testHaversineOneDegreeLatitude() {
        let d = haversineM(35.0, -106.0, 36.0, -106.0)
        // 1 degree of latitude ~ 111 km (111.19 km for R = 6371 km).
        XCTAssertGreaterThan(d, 110_000, "1 deg lat should be ~111 km")
        XCTAssertLessThan(d, 112_000, "1 deg lat should be ~111 km")
        print(String(format: "[haversine] 1 deg lat = %.1f m", d))
    }

    // MARK: - Extra: pace_eta helper sanity

    func testPaceEta() {
        // 5000 m flat at 5 km/h = 60 min.
        XCTAssertEqual(paceEtaMinutes(distanceM: 5000, ascentM: 0), 60)
        // + 300 m climb = +30 min.
        XCTAssertEqual(paceEtaMinutes(distanceM: 5000, ascentM: 300), 90)
        // negative ascent clamped to 0.
        XCTAssertEqual(paceEtaMinutes(distanceM: 5000, ascentM: -100), 60)
    }
}
