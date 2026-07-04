// Public façade for the whole LLM/agent/tool layer. The UI imports ONLY this
// (plus types from ../lib/contract). createHelius wires the worker engine, the
// tool registry, and the agent loop together and hands back a small surface.

import type { AgentEventHandler, ModelTier } from '../lib/contract';
import { createEngine, frameFromImage } from '../llm/engine';
import { createTools } from '../tools/registry';
import { setPack } from '../tools/pack';
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
  /** Region pack for the map + routing graph (default 'sandia'). */
  pack?: string;
  /**
   * Pre-warm BOTH model tiers at startup for an instant E2B↔E4B hot-swap.
   * Default false — pre-warming two q4f16 stacks risks a WebGPU OOM on ordinary
   * machines. Enable only where memory is known-ample (e.g. the demo box, via a
   * URL param / localStorage flag the shell reads).
   */
  prewarm?: boolean;
}

export async function createHelius(opts: CreateHeliusOptions): Promise<Helius> {
  setPack(opts.pack ?? 'sandia');

  const engine = createEngine(
    opts.modelBaseUrl,
    (status) => opts.onEvent({ type: 'engine-status', status }),
    opts.prewarm ?? false,
  );

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
