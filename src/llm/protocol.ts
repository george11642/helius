// Message protocol between the main thread (engine.ts client) and the module
// Worker that hosts transformers.js (llm.worker.ts). Kept in its own file so
// both sides share one source of truth for the wire shapes.

import type { ChatMessage, EngineStatus, GenerateResult, ModelTier, ToolSpec } from '../lib/contract';

/** Raw RGBA pixels lifted off a canvas/bitmap on the main thread, transferable to the worker. */
export interface RawFrame {
  data: ArrayBuffer; // Uint8ClampedArray RGBA buffer
  width: number;
  height: number;
}

// The public contract's UserContentPart is text|audio only. Native Gemma 4
// vision also needs an image placeholder part, which is an internal detail of
// this layer — so we widen the user message here (a superset of ChatMessage)
// rather than change the shared contract. ChatMessage[] stays assignable to
// EngineMessage[].
export type EngineContentPart = { type: 'text'; text: string } | { type: 'audio' } | { type: 'image' };
export type EngineUserMessage = { role: 'user'; content: string | EngineContentPart[] };
export type EngineMessage = Exclude<ChatMessage, { role: 'user' }> | EngineUserMessage;

export type GenerateKind = 'chat' | 'transcribe' | 'vision';

export type WorkerRequest =
  | { type: 'load'; tier: ModelTier; modelBaseUrl: string; prewarm: boolean }
  | { type: 'setTier'; tier: ModelTier }
  | { type: 'prewarm' } // trigger the deferred other-tier pre-warm (after first turn / idle)
  | {
      type: 'generate';
      id: number;
      kind: GenerateKind;
      messages: EngineMessage[];
      tools?: ToolSpec[];
      maxNewTokens?: number;
      audio?: Float32Array;
      image?: RawFrame;
    }
  | { type: 'abort'; id: number };

export type WorkerResponse =
  | { type: 'status'; status: EngineStatus }
  | { type: 'token'; id: number; chunk: string } // raw streamed chunk (markers intact)
  | { type: 'result'; id: number; result: GenerateResult; aborted: boolean }
  | { type: 'error'; id: number; message: string };
