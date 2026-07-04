import Foundation
import LiteRTLM

/// The real on-device engine: Gemma 4 E2B via LiteRT-LM (CPU / XNNPACK). One
/// `Conversation` is created at warm-up with the Helius system prompt and the
/// seven tools, then reused across turns so context (KV cache) carries over.
/// LiteRT-LM runs the tool-call loop internally; the tools emit trace events, and
/// this engine forwards the assistant's answer.
final class LiteRTEngine: HeliusEngine {
    let kind: EngineKind = .liteRT

    private var engine: Engine?
    private var conversation: Conversation?

    /// Sum of input + output tokens (KV-cache size). Bounds RAM; ample for a
    /// 6-step tool chain plus a short answer.
    private let maxTokens = 2048

    func warmUp(onStatus: @escaping (String) -> Void) async throws {
        onStatus("locating model…")
        let path = ModelLocator.resolveModelPath()
        guard ModelLocator.modelExists(at: path) else {
            throw NSError(domain: "Helius", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "model not found at \(path)"])
        }

        onStatus("loading Gemma 4 E2B…")
        let config = try EngineConfig(
            modelPath: path,
            backend: .cpu(),
            maxNumTokens: maxTokens,
            cacheDir: NSTemporaryDirectory()
        )
        let engine = Engine(engineConfig: config)
        let t0 = Date()
        try await engine.initialize()
        onStatus(String(format: "loaded in %.1fs — arming tools…", Date().timeIntervalSince(t0)))

        // Constrained decoding makes Gemma's function-calling reliable — Google's
        // stated purpose for this flag ("primarily used for function calling").
        // Must opt in before setting it; it is read when the Conversation is created.
        ExperimentalFlags.optIntoExperimentalAPIs()
        ExperimentalFlags.enableConversationConstrainedDecoding = true

        let convoConfig = ConversationConfig(
            systemMessage: Message(SystemPrompt.text, role: .system),
            tools: HeliusTools.all()
        )
        self.conversation = try await engine.createConversation(with: convoConfig)
        self.engine = engine
        onStatus("ready")
    }

    func send(_ userText: String, emit: @escaping (AgentEvent) -> Void) async {
        guard let conversation else {
            emit(.failed("engine not ready"))
            return
        }
        // Tools emit their trace events through this sink for the duration of the turn.
        HeliusRuntime.shared.setSink(emit)
        defer { HeliusRuntime.shared.setSink(nil) }

        emit(.turnStarted)
        do {
            // LiteRT-LM runs the full tool-call loop and returns the final answer.
            let response = try await conversation.sendMessage(Message(userText))
            let text = response.toString.trimmingCharacters(in: .whitespacesAndNewlines)

            // Reveal the (already generated) answer word-by-word for a live feel.
            let words = text.split(separator: " ", omittingEmptySubsequences: true)
            for (i, w) in words.enumerated() {
                emit(.token((i == 0 ? "" : " ") + w))
                try? await Task.sleep(nanoseconds: 26_000_000)
            }
            emit(.assistantFinal(text.isEmpty ? "(no answer)" : text))
            emit(.turnEnded)
        } catch {
            emit(.failed("\(error)"))
        }
    }
}
