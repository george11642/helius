import SwiftUI
import WebKit

/// Collapsible offline-map panel that sits above the transcript. Hosts the
/// bundled MapLibre + PMTiles page (web-map/) in a WKWebView served entirely
/// from the app bundle via MapSchemeHandler — no network, ever.
struct MapPanelView: View {
    @ObservedObject var bridge: MapBridge
    let packName: String
    @Binding var expanded: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            // Kept in the hierarchy when collapsed (height 0) so the WKWebView —
            // and the route/fix state inside it — survives collapse/expand.
            MapWebView(bridge: bridge)
                .frame(height: expanded ? 264 : 0)
                .clipped()
        }
        .background(Theme.panel)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.stroke), alignment: .bottom)
    }

    private var header: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "map.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.amber)
                Text(packName.uppercased())
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.text)
                Text("OFFLINE PACK")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.good)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.good.opacity(0.14))
                    .clipShape(Capsule())
                Spacer()
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.textDim)
                    .rotationEffect(.degrees(expanded ? 0 : -90))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }
}

/// The WKWebView host. The bridge keeps a weak reference to the web view and
/// evaluates JS on it; the coordinator receives ready/error messages from the
/// page and forwards them to the bridge.
private struct MapWebView: UIViewRepresentable {
    let bridge: MapBridge

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MapSchemeHandler(), forURLScheme: MapSchemeHandler.scheme)
        config.userContentController.add(context.coordinator, name: "helius")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x0a / 255, green: 0x0e / 255, blue: 0x14 / 255, alpha: 1)
        webView.scrollView.isScrollEnabled = false // MapLibre handles all gestures
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        bridge.webView = webView
        bridge.pageDidReset()
        webView.load(URLRequest(url: MapSchemeHandler.indexURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        bridge.webView = webView
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let bridge: MapBridge
        init(bridge: MapBridge) { self.bridge = bridge }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "helius", let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                bridge.pageDidBecomeReady()
            case "error":
                bridge.pageDidReport(error: body["message"] as? String ?? "unknown")
            default:
                break
            }
        }
    }
}
