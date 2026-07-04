import Foundation

// Binary parser for graph.bin (format: src/map/graph-format.md). All multi-byte
// values are little-endian; coordinates are microdegrees (value / 1e6). Ported
// from `src/map/graph-core.mjs::parseGraph`.

private let HEADER_SIZE = 44
private let NODE_SIZE = 8
private let EDGE_SIZE = 20
private let POLY_SIZE = 8

/// Compact tag object for an edge's source OSM way (absent fields are nil).
public struct GraphTag: Sendable, Equatable {
    public let highway: String?
    public let name: String?
    public let sacScale: String?
    public let surface: String?
    public init(highway: String?, name: String?, sacScale: String?, surface: String?) {
        self.highway = highway
        self.name = name
        self.sacScale = sacScale
        self.surface = surface
    }
}

/// Bounding box in decimal degrees.
public struct GraphBBox: Sendable, Equatable {
    public let minLat: Double
    public let minLon: Double
    public let maxLat: Double
    public let maxLon: Double
}

struct RawEdge {
    let nodeA: Int
    let nodeB: Int
    let lengthM: Double
    let tagIdx: Int
    let polyline: [LatLon] // decoded to absolute degrees, nodeA -> nodeB order
}

struct RawGraph {
    let version: Int
    let nodeCount: Int
    let edgeCount: Int
    let polylinePointCount: Int
    let tagCount: Int
    let tagsBlobBytes: Int
    let nodeLat: [Double]
    let nodeLon: [Double]
    let edges: [RawEdge]
    let tags: [GraphTag]
    let bbox: GraphBBox
}

public enum GraphParseError: Error, CustomStringConvertible {
    case tooSmall(Int)
    case badMagic(String)
    case unsupportedVersion(Int)
    case truncated(expected: Int, actual: Int)
    case tagCountMismatch(header: Int, blob: Int)
    case tagsDecode(String)

    public var description: String {
        switch self {
        case .tooSmall(let n): return "graph.bin: file too small (\(n) bytes, need >= \(HEADER_SIZE))"
        case .badMagic(let m): return "graph.bin: bad magic \"\(m)\" (expected HLXG)"
        case .unsupportedVersion(let v): return "graph.bin: unsupported version \(v)"
        case .truncated(let e, let a): return "graph.bin: truncated (expected \(e) bytes, got \(a))"
        case .tagCountMismatch(let h, let b): return "graph.bin: tag count mismatch (header says \(h), blob has \(b))"
        case .tagsDecode(let s): return "graph.bin: tags decode failed: \(s)"
        }
    }
}

private struct TagDTO: Decodable {
    let highway: String?
    let name: String?
    let sac_scale: String?
    let surface: String?
}

func parseGraph(_ data: Data) throws -> RawGraph {
    let bytes = [UInt8](data)
    let n = bytes.count
    if n < HEADER_SIZE { throw GraphParseError.tooSmall(n) }

    // Manual little-endian byte assembly — no alignment assumptions.
    @inline(__always) func u16(_ o: Int) -> Int {
        Int(UInt16(bytes[o]) | (UInt16(bytes[o + 1]) << 8))
    }
    @inline(__always) func u32(_ o: Int) -> UInt32 {
        UInt32(bytes[o]) | (UInt32(bytes[o + 1]) << 8) | (UInt32(bytes[o + 2]) << 16) | (UInt32(bytes[o + 3]) << 24)
    }
    @inline(__always) func i32(_ o: Int) -> Int32 { Int32(bitPattern: u32(o)) }
    @inline(__always) func f32(_ o: Int) -> Float { Float(bitPattern: u32(o)) }

    let magic = String(bytes: bytes[0..<4], encoding: .ascii) ?? ""
    if magic != "HLXG" { throw GraphParseError.badMagic(magic) }
    let version = u16(4)
    if version != 1 { throw GraphParseError.unsupportedVersion(version) }

    let nodeCount = Int(u32(8))
    let edgeCount = Int(u32(12))
    let polylinePointCount = Int(u32(16))
    let tagCount = Int(u32(20))
    let tagsBlobBytes = Int(u32(24))
    let bbox = GraphBBox(
        minLat: Double(i32(28)) / 1e6,
        minLon: Double(i32(32)) / 1e6,
        maxLat: Double(i32(36)) / 1e6,
        maxLon: Double(i32(40)) / 1e6
    )

    let nodeTableEnd = HEADER_SIZE + nodeCount * NODE_SIZE
    let edgeTableStart = nodeTableEnd
    let polyPoolStart = edgeTableStart + edgeCount * EDGE_SIZE
    let tagsBlobStart = polyPoolStart + polylinePointCount * POLY_SIZE
    let expectedLen = tagsBlobStart + tagsBlobBytes
    if n < expectedLen { throw GraphParseError.truncated(expected: expectedLen, actual: n) }

    var nodeLat = [Double](repeating: 0, count: nodeCount)
    var nodeLon = [Double](repeating: 0, count: nodeCount)
    var off = HEADER_SIZE
    for i in 0..<nodeCount {
        nodeLat[i] = Double(i32(off)) / 1e6
        nodeLon[i] = Double(i32(off + 4)) / 1e6
        off += NODE_SIZE
    }

    var edges = [RawEdge]()
    edges.reserveCapacity(edgeCount)
    off = edgeTableStart
    for _ in 0..<edgeCount {
        let nodeA = Int(u32(off))
        let nodeB = Int(u32(off + 4))
        let lengthM = Double(f32(off + 8))
        let polylineOffset = Int(u32(off + 12))
        let polylineCount = u16(off + 16)
        let tagIdx = u16(off + 18)
        off += EDGE_SIZE

        var polyline = [LatLon]()
        polyline.reserveCapacity(polylineCount)
        var pOff = polyPoolStart + polylineOffset * POLY_SIZE
        var lat: Int32 = 0
        var lon: Int32 = 0
        for p in 0..<polylineCount {
            let a = i32(pOff)
            let b = i32(pOff + 4)
            if p == 0 {
                lat = a
                lon = b
            } else {
                lat = lat &+ a
                lon = lon &+ b
            }
            polyline.append(LatLon(lat: Double(lat) / 1e6, lon: Double(lon) / 1e6))
            pOff += POLY_SIZE
        }

        edges.append(RawEdge(nodeA: nodeA, nodeB: nodeB, lengthM: lengthM, tagIdx: tagIdx, polyline: polyline))
    }

    let tagsData = Data(bytes[tagsBlobStart ..< tagsBlobStart + tagsBlobBytes])
    let tags: [GraphTag]
    do {
        let dtos = try JSONDecoder().decode([TagDTO].self, from: tagsData)
        tags = dtos.map { GraphTag(highway: $0.highway, name: $0.name, sacScale: $0.sac_scale, surface: $0.surface) }
    } catch {
        throw GraphParseError.tagsDecode(String(describing: error))
    }
    if tags.count != tagCount {
        throw GraphParseError.tagCountMismatch(header: tagCount, blob: tags.count)
    }

    return RawGraph(
        version: version,
        nodeCount: nodeCount,
        edgeCount: edgeCount,
        polylinePointCount: polylinePointCount,
        tagCount: tagCount,
        tagsBlobBytes: tagsBlobBytes,
        nodeLat: nodeLat,
        nodeLon: nodeLon,
        edges: edges,
        tags: tags,
        bbox: bbox
    )
}
