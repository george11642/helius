import SwiftUI

/// The chat transcript. Auto-scrolls to the newest line as tokens stream in.
struct TranscriptView: View {
    let messages: [ChatMessage]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(messages) { msg in
                        MessageBubble(message: msg).id(msg.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            .onChange(of: messages) { _ in
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }
}

private struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 40) }
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 3) {
                Text(message.role == .user ? "YOU" : "HELIUS")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(message.role == .user ? Theme.textDim : Theme.amber)
                Text(message.text.isEmpty ? "…" : message.text)
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(message.role == .user ? .trailing : .leading)
            }
            .padding(.horizontal, 13).padding(.vertical, 9)
            .background(message.role == .user ? Theme.panelHi : Theme.panel)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(message.role == .helius ? Theme.amber.opacity(0.25) : Theme.stroke, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 12))
            if message.role == .helius { Spacer(minLength: 40) }
        }
    }
}
