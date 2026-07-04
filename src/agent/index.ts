// Public façade for the whole LLM/agent/tool layer. The UI imports ONLY this
// (plus types from ../lib/contract). createHelius wires the worker engine, the
// tool registry, and the agent loop together and hands back a small surface.

import type { AgentEventHandler, ModelTier } from '../lib/contract';
import { createEngine, frameFromImage } from '../llm/engine';
import { createTools } from '../tools/registry';
import { createAgentLoop } from './loop';
import { SYSTEM_PROMPT } from './prompt';

export interface Helius {
  sendText(text: string): Promise<void>;
  sendVoice(audio: Float32Array): Promise<void>; // 16kHz mono
  readSign(image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Promise<void>;
  setTier(tier: ModelTier): Promise<void>;
  abort(): void;
  getStats(): { decodeTps: number; prefillMs: number } | null;
}

export interface CreateHeliusOptions {
  /** Base URL of the model mirror, trailing slash, e.g. 'http://localhost:8737/models/'. */
  modelBaseUrl: string;
  /** Single sink for every AgentEvent (engine status, tokens, tool trace, speak, ...). */
  onEvent: AgentEventHandler;
}

export async function createHelius(opts: CreateHeliusOptions): Promise<Helius> {
  const engine = createEngine(opts.modelBaseUrl, (status) => opts.onEvent({ type: 'engine-status', status }));

  const registry = createTools({
    emit: opts.onEvent,
    engine: {
      visionInfer: async (frame, prompt) => {
        const r = await engine.visionInfer(frame, prompt);
        return { text: r.text, rawText: r.rawText };
      },
    },
  });

  const loop = createAgentLoop({ engine, registry, emit: opts.onEvent, systemPrompt: SYSTEM_PROMPT });

  // Kick off the default-tier load; progress + ready/error surface through
  // onEvent (engine-status). We don't block façade creation on it so the UI
  // can render its loading state immediately — the worker queues any early
  // sendText behind the in-flight load.
  void engine.load('E2B').catch(() => {
    /* surfaced via engine-status 'error' */
  });

  return {
    sendText: (text) => loop.runText(text),
    sendVoice: (audio) => loop.runVoice(audio),
    readSign: (image) => loop.readSign(frameFromImage(image)),
    setTier: (tier) => engine.setTier(tier),
    abort: () => loop.abort(),
    getStats: () => engine.getStats(),
  };
}

export type { AgentLoop } from './loop';
