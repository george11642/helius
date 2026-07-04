// Main-thread client for the worker-hosted inference engine. Owns the Worker,
// tracks in-flight requests by id, and exposes a small typed API to the agent
// loop. All heavy lifting (WebGPU prefill/decode) happens in llm.worker.ts.

import type { ChatMessage, EngineStatus, GenerateResult, ModelTier, ToolSpec } from '../lib/contract';
import type { EngineMessage, RawFrame, WorkerRequest, WorkerResponse } from './protocol';

export type EngineResult = GenerateResult & { aborted: boolean };

export interface GenerateOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxNewTokens?: number;
  onChunk?: (chunk: string) => void;
}

export interface Engine {
  /** Load a tier and resolve once it reports ready (rejects on load error). */
  load(tier: ModelTier): Promise<void>;
  /** Switch tiers (reloads the model in the worker). */
  setTier(tier: ModelTier): Promise<void>;
  /** Chat/tool turn with streamed visible tokens via opts.onChunk. */
  generate(opts: GenerateOptions): Promise<EngineResult>;
  /** Native Gemma 4 audio-in transcription (16kHz mono Float32). */
  transcribe(audio: Float32Array): Promise<string>;
  /** Native Gemma 4 vision inference over a raw RGBA frame. */
  visionInfer(frame: RawFrame, prompt: string): Promise<EngineResult>;
  /** Interrupt the most recent in-flight generation. */
  abort(): void;
  getStats(): { decodeTps: number; prefillMs: number } | null;
  currentTier(): ModelTier;
  dispose(): void;
}

interface Pending {
  resolve: (r: EngineResult) => void;
  reject: (e: Error) => void;
  onChunk?: (chunk: string) => void;
}

const TRANSCRIBE_SYSTEM = 'Transcribe the following speech segment in English into English text.';

/** Lift raw RGBA pixels off any canvas/bitmap source so they can be transferred to the worker. */
export function frameFromImage(image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): RawFrame {
  const width = image.width;
  const height = image.height;
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2d context unavailable for frame capture');
  g.drawImage(image as CanvasImageSource, 0, 0);
  const img = g.getImageData(0, 0, width, height);
  return { data: img.data.buffer, width, height };
}

export function createEngine(
  modelBaseUrl: string,
  onStatus: (s: EngineStatus) => void,
  prewarm = false,
): Engine {
  const worker = new Worker(new URL('../workers/llm.worker.ts', import.meta.url), { type: 'module' });

  let nextId = 1;
  let activeId = 0;
  let tier: ModelTier = 'E2B';
  let lastStats: { decodeTps: number; prefillMs: number } | null = null;
  const pending = new Map<number, Pending>();
  let loadWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  const send = (msg: WorkerRequest, transfer?: Transferable[]) => worker.postMessage(msg, transfer ?? []);

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'status': {
        onStatus(msg.status);
        if (msg.status.state === 'ready') {
          tier = msg.status.tier;
          const waiters = loadWaiters;
          loadWaiters = [];
          for (const w of waiters) w.resolve();
        } else if (msg.status.state === 'error') {
          const err = new Error(msg.status.message);
          const waiters = loadWaiters;
          loadWaiters = [];
          for (const w of waiters) w.reject(err);
        }
        break;
      }
      case 'token': {
        pending.get(msg.id)?.onChunk?.(msg.chunk);
        break;
      }
      case 'result': {
        const p = pending.get(msg.id);
        if (!p) break;
        pending.delete(msg.id);
        if (activeId === msg.id) activeId = 0; // settled — a later abort() won't send this stale id
        lastStats = { decodeTps: msg.result.decodeTps, prefillMs: msg.result.prefillMs };
        p.resolve({ ...msg.result, aborted: msg.aborted });
        break;
      }
      case 'error': {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (activeId === msg.id) activeId = 0;
          p.reject(new Error(msg.message));
        }
        break;
      }
    }
  };

  worker.onerror = (e: ErrorEvent) => {
    const err = new Error(`worker error: ${e.message}`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    const waiters = loadWaiters;
    loadWaiters = [];
    for (const w of waiters) w.reject(err);
  };

  function loadPromise(): Promise<void> {
    return new Promise((resolve, reject) => loadWaiters.push({ resolve, reject }));
  }

  function runGenerate(
    kind: 'chat' | 'transcribe' | 'vision',
    body: { messages: EngineMessage[]; tools?: ToolSpec[]; maxNewTokens?: number; audio?: Float32Array; image?: RawFrame },
    onChunk?: (chunk: string) => void,
  ): Promise<EngineResult> {
    const id = nextId++;
    activeId = id;
    return new Promise<EngineResult>((resolve, reject) => {
      pending.set(id, { resolve, reject, onChunk });
      const transfer: Transferable[] = [];
      if (body.audio) transfer.push(body.audio.buffer);
      if (body.image) transfer.push(body.image.data);
      send(
        {
          type: 'generate',
          id,
          kind,
          messages: body.messages,
          tools: body.tools,
          maxNewTokens: body.maxNewTokens,
          audio: body.audio,
          image: body.image,
        },
        transfer,
      );
    });
  }

  return {
    load(nextTier: ModelTier): Promise<void> {
      tier = nextTier;
      const p = loadPromise();
      // prewarm is opt-in (default false): pre-warming BOTH q4f16 tiers risks a
      // WebGPU OOM that can kill the tab on ordinary machines. The demo box
      // enables it explicitly (createHelius opts) for the instant hot-swap.
      send({ type: 'load', tier: nextTier, modelBaseUrl, prewarm });
      return p;
    },
    setTier(nextTier: ModelTier): Promise<void> {
      if (nextTier === tier) return Promise.resolve();
      tier = nextTier;
      const p = loadPromise();
      send({ type: 'setTier', tier: nextTier });
      return p;
    },
    generate(opts: GenerateOptions): Promise<EngineResult> {
      return runGenerate(
        'chat',
        { messages: opts.messages, tools: opts.tools, maxNewTokens: opts.maxNewTokens },
        opts.onChunk,
      );
    },
    async transcribe(audio: Float32Array): Promise<string> {
      const messages: ChatMessage[] = [
        { role: 'system', content: TRANSCRIBE_SYSTEM },
        { role: 'user', content: [{ type: 'audio' }] },
      ];
      const r = await runGenerate('transcribe', { messages, maxNewTokens: 96, audio });
      return r.text.trim();
    },
    visionInfer(frame: RawFrame, prompt: string): Promise<EngineResult> {
      const messages: EngineMessage[] = [
        { role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] },
      ];
      return runGenerate('vision', { messages, maxNewTokens: 320, image: frame });
    },
    abort(): void {
      if (activeId) send({ type: 'abort', id: activeId });
    },
    getStats() {
      return lastStats;
    },
    currentTier() {
      return tier;
    },
    dispose(): void {
      worker.terminate();
      pending.clear();
      loadWaiters = [];
    },
  };
}
