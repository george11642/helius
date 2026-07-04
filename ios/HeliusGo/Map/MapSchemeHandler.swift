import Foundation
import WebKit

/// Serves the bundled `web-map/` folder (MapLibre page, vendor JS, glyphs,
/// sprites, and the Sandia basemap.pmtiles) to the embedded WKWebView over the
/// custom `helius://local/...` scheme — the whole map loads with zero network.
///
/// Range requests are honored (206 + Content-Range): the pmtiles JS client
/// reads the 28 MB archive with byte-range fetches (16 KB header, then leaf
/// directories/tiles), so without ranges every tile fetch would pull the whole
/// file. Files are memory-mapped, so serving a subrange never copies the
/// archive into memory.
final class MapSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "helius"
    static let indexURL = URL(string: "\(scheme)://local/index.html")!

    /// Tasks WebKit has stopped — calling didReceive/didFinish on a stopped
    /// task throws an Obj-C exception, so completed work checks first.
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskId = ObjectIdentifier(urlSchemeTask)
        lock.lock(); stopped.remove(taskId); lock.unlock()

        guard let url = urlSchemeTask.request.url,
              let fileURL = resolve(url) else {
            respondNotFound(urlSchemeTask, url: urlSchemeTask.request.url)
            return
        }

        // .alwaysMapped: the 28 MB pmtiles is mmap'd, not read into RAM.
        guard let data = try? Data(contentsOf: fileURL, options: .alwaysMapped) else {
            respondNotFound(urlSchemeTask, url: url)
            return
        }

        let total = data.count
        var status = 200
        var body = data
        var headers: [String: String] = [
            "Content-Type": mimeType(for: fileURL.pathExtension),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        ]

        if let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range"),
           let (lo, hi) = parseRange(rangeHeader, total: total) {
            status = 206
            body = data.subdata(in: lo..<(hi + 1))
            headers["Content-Range"] = "bytes \(lo)-\(hi)/\(total)"
        }
        headers["Content-Length"] = "\(body.count)"

        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            respondNotFound(urlSchemeTask, url: url)
            return
        }
        deliver(urlSchemeTask, taskId) {
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(body)
            urlSchemeTask.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(urlSchemeTask)); lock.unlock()
    }

    // MARK: internals

    /// Maps helius://local/<path> onto the bundled web-map folder, rejecting
    /// any traversal outside it.
    private func resolve(_ url: URL) -> URL? {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web-map", isDirectory: true) else { return nil }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let fileURL = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard fileURL.path.hasPrefix(root.standardizedFileURL.path) else { return nil }
        return FileManager.default.fileExists(atPath: fileURL.path) ? fileURL : nil
    }

    /// Parses `bytes=a-b`, `bytes=a-`, `bytes=-n` (single range only, which is
    /// all pmtiles/WebKit emit). Returns a closed [lo, hi] within the file.
    private func parseRange(_ header: String, total: Int) -> (Int, Int)? {
        guard total > 0, header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst("bytes=".count).split(separator: ",")[0]
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let loStr = parts[0].trimmingCharacters(in: .whitespaces)
        let hiStr = parts[1].trimmingCharacters(in: .whitespaces)

        if loStr.isEmpty {
            // suffix range: last n bytes
            guard let n = Int(hiStr), n > 0 else { return nil }
            return (max(0, total - n), total - 1)
        }
        guard let lo = Int(loStr), lo >= 0, lo < total else { return nil }
        let hi = Int(hiStr).map { min($0, total - 1) } ?? (total - 1)
        guard hi >= lo else { return nil }
        return (lo, hi)
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "pbf": return "application/x-protobuf"
        case "pmtiles": return "application/octet-stream"
        default: return "application/octet-stream"
        }
    }

    private func respondNotFound(_ task: WKURLSchemeTask, url: URL?) {
        let taskId = ObjectIdentifier(task)
        guard let url else {
            deliver(task, taskId) { task.didFailWithError(URLError(.badURL)) }
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Length": "0"])!
        deliver(task, taskId) {
            task.didReceive(response)
            task.didFinish()
        }
    }

    /// Runs `work` only if WebKit has not stopped the task in the meantime.
    private func deliver(_ task: WKURLSchemeTask, _ taskId: ObjectIdentifier, work: () -> Void) {
        lock.lock()
        let isStopped = stopped.contains(taskId)
        lock.unlock()
        guard !isStopped else { return }
        work()
    }
}
