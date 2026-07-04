import Foundation

// Routable structure + A* over graph.bin. Ported from `src/map/graph-core.mjs`
// (buildRoutingGraph / nearestNode / findConnectingEdge / findRoute), with the
// ngraph.path dependency replaced by a self-contained binary-heap A*.

// Grid cell size for the nearestNode spatial index, in degrees. Coarser than
// the 300m off-network threshold on purpose (see graph-core.mjs).
private let CELL_DEG = 0.005
private let OFF_NETWORK_M = 300.0
private let WALK_KMH = 5.0 // Naismith flat-ground rate; no ascent term (no elevation in v1)

public struct RouteStep: Equatable, Sendable {
    public let instruction: String
    public let distanceM: Double
    public init(instruction: String, distanceM: Double) {
        self.instruction = instruction
        self.distanceM = distanceM
    }
}

public enum RouteError: Equatable, Sendable {
    case offNetwork(nearestM: Double)
    case noPath
}

/// Result of a routing query. On success `error == nil` and the geometry/steps
/// are populated; on failure `error` is set and the numeric fields are zero/empty.
public struct RouteResult: Sendable, Equatable {
    public let distanceM: Double
    public let etaMin: Double
    public let ascentM: Double?
    public let steps: [RouteStep]
    public let coordinates: [LatLon] // [lat, lon] order, start -> goal
    public let error: RouteError?

    public var isSuccess: Bool { error == nil }

    public init(
        distanceM: Double,
        etaMin: Double,
        ascentM: Double?,
        steps: [RouteStep],
        coordinates: [LatLon],
        error: RouteError?
    ) {
        self.distanceM = distanceM
        self.etaMin = etaMin
        self.ascentM = ascentM
        self.steps = steps
        self.coordinates = coordinates
        self.error = error
    }

    static func failure(_ e: RouteError) -> RouteResult {
        RouteResult(distanceM: 0, etaMin: 0, ascentM: nil, steps: [], coordinates: [], error: e)
    }
}

private struct GridCell: Hashable {
    let x: Int
    let y: Int
}

/// Min-heap (by f-score) open set for A*. Lazy-deletion: stale entries are
/// skipped on pop via a closed set, so no decrease-key is needed.
private struct BinaryHeap {
    private var fs: [Double] = []
    private var ns: [Int] = []

    mutating func push(_ f: Double, _ node: Int) {
        fs.append(f)
        ns.append(node)
        var i = ns.count - 1
        while i > 0 {
            let parent = (i - 1) >> 1
            if fs[parent] <= fs[i] { break }
            fs.swapAt(parent, i)
            ns.swapAt(parent, i)
            i = parent
        }
    }

    mutating func pop() -> (f: Double, node: Int)? {
        if ns.isEmpty { return nil }
        let topF = fs[0]
        let topN = ns[0]
        let lastF = fs.removeLast()
        let lastN = ns.removeLast()
        if !ns.isEmpty {
            fs[0] = lastF
            ns[0] = lastN
            var i = 0
            let count = ns.count
            while true {
                let l = 2 * i + 1
                let r = 2 * i + 2
                var smallest = i
                if l < count && fs[l] < fs[smallest] { smallest = l }
                if r < count && fs[r] < fs[smallest] { smallest = r }
                if smallest == i { break }
                fs.swapAt(i, smallest)
                ns.swapAt(i, smallest)
                i = smallest
            }
        }
        return (topF, topN)
    }
}

/// The routable graph: parsed data plus a node adjacency list and a spatial
/// index for snapping. Immutable after construction.
public final class RoutingGraph {
    let raw: RawGraph
    private let adjacency: [[Int]] // nodeIdx -> [edgeIdx] touching it (edge-index order)
    private let spatialIndex: [GridCell: [Int]]

    // Header/count accessors for parse-sanity checks.
    public var version: Int { raw.version }
    public var nodeCount: Int { raw.nodeCount }
    public var edgeCount: Int { raw.edgeCount }
    public var polylinePointCount: Int { raw.polylinePointCount }
    public var tagCount: Int { raw.tagCount }
    public var tagsBlobBytes: Int { raw.tagsBlobBytes }
    public var bbox: GraphBBox { raw.bbox }

    /// Expected total file length per the format spec, for validation.
    public var expectedFileLength: Int {
        44 + raw.nodeCount * 8 + raw.edgeCount * 20 + raw.polylinePointCount * 8 + raw.tagsBlobBytes
    }

    init(raw: RawGraph) {
        self.raw = raw
        var adj = [[Int]](repeating: [], count: raw.nodeCount)
        for (edgeIdx, e) in raw.edges.enumerated() {
            adj[e.nodeA].append(edgeIdx)
            adj[e.nodeB].append(edgeIdx)
        }
        self.adjacency = adj

        var idx = [GridCell: [Int]]()
        for i in 0..<raw.nodeCount {
            let key = GridCell(
                x: Int(floor(raw.nodeLat[i] / CELL_DEG)),
                y: Int(floor(raw.nodeLon[i] / CELL_DEG))
            )
            idx[key, default: []].append(i)
        }
        self.spatialIndex = idx
    }

    /// Parse graph.bin bytes and build the routable index in one step.
    public static func load(_ data: Data) throws -> RoutingGraph {
        RoutingGraph(raw: try parseGraph(data))
    }

    // MARK: - Snapping

    /// Nearest kept-vertex to a coordinate, using the ring-expanding grid search
    /// (rings 1..6, accept the first ring with any candidate). Returns nil only
    /// for an empty graph or a point with no nodes within the 6-ring window.
    public func nearestNode(lat: Double, lon: Double) -> (nodeIdx: Int, distM: Double)? {
        if raw.nodeCount == 0 { return nil }
        let cx = Int(floor(lat / CELL_DEG))
        let cy = Int(floor(lon / CELL_DEG))

        for ring in 1...6 {
            var candidates = Set<Int>()
            for dx in -ring...ring {
                for dy in -ring...ring {
                    if let list = spatialIndex[GridCell(x: cx + dx, y: cy + dy)] {
                        candidates.formUnion(list)
                    }
                }
            }
            if candidates.isEmpty { continue }

            var best = -1
            var bestD = Double.infinity
            for nodeIdx in candidates {
                let d = haversineM(lat, lon, raw.nodeLat[nodeIdx], raw.nodeLon[nodeIdx])
                if d < bestD {
                    bestD = d
                    best = nodeIdx
                }
            }
            return (best, bestD)
        }
        return nil
    }

    // MARK: - Edge lookup

    /// The edge connecting two adjacent kept-vertices, and whether traversal runs
    /// with (forward) or against the stored nodeA->nodeB polyline direction.
    private func findConnectingEdge(_ fromIdx: Int, _ toIdx: Int) -> (edgeIdx: Int, forward: Bool)? {
        for edgeIdx in adjacency[fromIdx] {
            let e = raw.edges[edgeIdx]
            if e.nodeA == fromIdx && e.nodeB == toIdx { return (edgeIdx, true) }
            if e.nodeB == fromIdx && e.nodeA == toIdx { return (edgeIdx, false) }
        }
        return nil
    }

    // MARK: - A*

    /// Optimal A* from `start` to `goal`. g = running sum of edge lengthM;
    /// h = haversine(current, goal) (admissible + consistent). Returns the node
    /// path start..goal inclusive, or nil if disconnected.
    private func aStar(_ start: Int, _ goal: Int) -> [Int]? {
        let goalLat = raw.nodeLat[goal]
        let goalLon = raw.nodeLon[goal]

        var gScore = [Double](repeating: .infinity, count: raw.nodeCount)
        var cameFrom = [Int](repeating: -1, count: raw.nodeCount)
        var closed = [Bool](repeating: false, count: raw.nodeCount)
        gScore[start] = 0

        var heap = BinaryHeap()
        heap.push(haversineM(raw.nodeLat[start], raw.nodeLon[start], goalLat, goalLon), start)

        while let top = heap.pop() {
            let node = top.node
            if closed[node] { continue }
            if node == goal {
                var path = [Int]()
                var cur = goal
                while cur != -1 {
                    path.append(cur)
                    if cur == start { break }
                    cur = cameFrom[cur]
                }
                return path.reversed()
            }
            closed[node] = true
            let gNode = gScore[node]
            for edgeIdx in adjacency[node] {
                let e = raw.edges[edgeIdx]
                let neighbor = e.nodeA == node ? e.nodeB : e.nodeA
                if closed[neighbor] { continue }
                let tentative = gNode + e.lengthM
                if tentative < gScore[neighbor] {
                    gScore[neighbor] = tentative
                    cameFrom[neighbor] = node
                    let h = haversineM(raw.nodeLat[neighbor], raw.nodeLon[neighbor], goalLat, goalLon)
                    heap.push(tentative + h, neighbor)
                }
            }
        }
        return nil
    }

    // MARK: - findRoute

    /// Route from `from` to `to`. Snaps both endpoints (rejecting > 300 m off the
    /// network), runs A*, then walks the node path to build coalesced legs, turn
    /// steps, the full polyline, and the summed distance/ETA.
    public func findRoute(from: LatLon, to: LatLon) -> RouteResult {
        guard let fromSnap = nearestNode(lat: from.lat, lon: from.lon) else {
            return .failure(.offNetwork(nearestM: .infinity))
        }
        if fromSnap.distM > OFF_NETWORK_M {
            return .failure(.offNetwork(nearestM: fromSnap.distM))
        }
        guard let toSnap = nearestNode(lat: to.lat, lon: to.lon) else {
            return .failure(.offNetwork(nearestM: .infinity))
        }
        if toSnap.distM > OFF_NETWORK_M {
            return .failure(.offNetwork(nearestM: toSnap.distM))
        }

        if fromSnap.nodeIdx == toSnap.nodeIdx {
            let p = LatLon(lat: raw.nodeLat[fromSnap.nodeIdx], lon: raw.nodeLon[fromSnap.nodeIdx])
            return RouteResult(distanceM: 0, etaMin: 0, ascentM: nil, steps: [], coordinates: [p, p], error: nil)
        }

        guard let nodePath = aStar(fromSnap.nodeIdx, toSnap.nodeIdx), nodePath.count > 1 else {
            return .failure(.noPath)
        }

        var coords = [LatLon]()
        var distanceM = 0.0
        var legs: [(label: String, distanceM: Double)] = []

        for i in 0..<(nodePath.count - 1) {
            let a = nodePath[i]
            let b = nodePath[i + 1]
            guard let hit = findConnectingEdge(a, b) else {
                // graph inconsistency (JS throws here) — treat as no path.
                return .failure(.noPath)
            }
            let edge = raw.edges[hit.edgeIdx]
            let pts = hit.forward ? edge.polyline : Array(edge.polyline.reversed())

            if coords.isEmpty { coords.append(pts[0]) }
            if pts.count > 1 {
                for p in 1..<pts.count { coords.append(pts[p]) }
            }

            distanceM += edge.lengthM
            let tag = (edge.tagIdx >= 0 && edge.tagIdx < raw.tags.count)
                ? raw.tags[edge.tagIdx]
                : GraphTag(highway: nil, name: nil, sacScale: nil, surface: nil)
            let label = tag.name ?? genericLabelFor(tag.highway)
            if let last = legs.last, last.label == label {
                legs[legs.count - 1].distanceM += edge.lengthM
            } else {
                legs.append((label: label, distanceM: edge.lengthM))
            }
        }

        let steps = legs.enumerated().map { idx, leg in
            RouteStep(
                instruction: "\(idx == 0 ? "Follow" : "Turn onto") \(leg.label) \(formatDistance(leg.distanceM))",
                distanceM: leg.distanceM
            )
        }

        return RouteResult(
            distanceM: distanceM,
            etaMin: (distanceM / 1000 / WALK_KMH) * 60,
            ascentM: nil,
            steps: steps,
            coordinates: coords,
            error: nil
        )
    }

    /// Convenience overload routing from a `Fix` to a named `RouteDestination`.
    public func findRoute(from: Fix, to: RouteDestination) -> RouteResult {
        findRoute(from: LatLon(lat: from.lat, lon: from.lon), to: to.coord)
    }
}

// MARK: - Label + distance formatting (ported from graph-core.mjs)

func genericLabelFor(_ highway: String?) -> String {
    switch highway {
    case "footway", "path": return "the trail"
    case "track": return "the track"
    case "steps": return "the steps"
    case "bridleway": return "the bridleway"
    case "cycleway": return "the cycleway"
    case "service": return "the service road"
    case "residential", "unclassified", "tertiary", "secondary", "primary": return "the road"
    default: return "the path"
    }
}

func formatDistance(_ meters: Double) -> String {
    if meters < 1000 { return "\(Int(meters.rounded())) m" }
    return String(format: "%.1f km", meters / 1000)
}
