// Worker-hosted inference engine. transformers.js + Gemma 4 run entirely
// inside this module Worker (WebGPU works in workers on Chrome), so the main
// thread never blocks on prefill/decode. The main-thread client is
// src/llm/engine.ts; the wire protocol is src/llm/protocol.ts.
//
// Both tiers (E2B, E4B) are full multimodal q4f16 checkpoints and load the same
// way (AutoModelForImageTextToText, all four components). E4B is ~2x slower to
// decode (16 vs 32 tok/s) — that contrast is the MatFormer "elasticity" demo
// beat. To make the tier switch feel instant, we PRE-WARM both model instances
// at startup (when the device has the memory) and hot-swap the active refs;
// if pre-warm fails (e.g. GPU OOM) we fall back to load-on-demand.
//
// Kept DOM-lib-clean (no `webworker` lib reference): `self` is cast to a tiny
// WorkerScope interface, which avoids the DOM/WebWorker `self` type clash while
// the project tsconfig keeps lib = ES2022 + DOM.

import {
  env,
  AutoProcessor,
  AutoModelForImageTextToText,
  TextStreamer,
  RawImage,
  InterruptableStoppingCriteria,
} from '@huggingface/transformers';
import { stripMarkers } from '../lib/parse';
import type { ModelTier } from '../lib/contract';
import type { GenerateKind, RawFrame, WorkerRequest, WorkerResponse } from '../llm/protocol';

// ---- worker global (typed minimally to avoid DOM/WebWorker lib clashes) ----
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<WorkerRequest>) => void): void;
}
const ctx = self as unknown as WorkerScope;
const post = (msg: WorkerResponse, transfer?: Transferable[]) => ctx.postMessage(msg, transfer);

// ---- loosely-typed views over transformers.js (its own d.ts is mostly any) ----
type LoadedProcessor = {
  (text: string, images: unknown, audio: unknown, opts: Record<string, unknown>): Promise<Record<string, unknown>>;
  apply_chat_template(messages: unknown, opts: Record<string, unknown>): string;
  batch_decode(tokens: unknown, opts: Record<string, unknown>): string[];
  tokenizer: unknown;
};
type LoadedModel = { generate(args: Record<string, unknown>): Promise<{ slice(a: null, b: Array<number | null>): unknown }> };
interface Instance {
  processor: LoadedProcessor;
  model: LoadedModel;
}

const MODEL_DIR: Record<ModelTier, string> = {
  E2B: 'gemma-4-e2b-onnx',
  E4B: 'gemma-4-e4b-onnx',
};
const OTHER: Record<ModelTier, ModelTier> = { E2B: 'E4B', E4B: 'E2B' };
// Same per-component dtype for both tiers (both are full multimodal q4f16).
const DTYPE = { audio_encoder: 'q4f16', vision_encoder: 'q4f16', embed_tokens: 'q4f16', decoder_model_merged: 'q4f16' };

const instances: Partial<Record<ModelTier, Instance>> = {};
const tierLoads = new Map<ModelTier, Promise<Instance>>();
let activeTier: ModelTier = 'E2B';
const activeStops = new Map<number, InterruptableStoppingCriteria>();
// Requests aborted before generation actually started (InterruptableStoppingCriteria
// only bites once decoding is underway; a request can sit behind a model load).
const abortedIds = new Set<number>();
// Generation ids currently accepted + running, so aborts for settled/unknown ids
// are ignored rather than leaking abortedIds entries.
const inFlight = new Set<number>();

// Deferred pre-warm: the other tier loads only AFTER the first completed turn
// (main thread posts 'prewarm') or PREWARM_IDLE_MS of idle — whichever first.
// Pre-warming during the first turn spikes its prefill (seen live: 37s); a fast
// first impression beats instant swap-readiness.
const PREWARM_IDLE_MS = 45000;
let prewarmTier: ModelTier | null = null;
let prewarmStarted = false;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;

const active = (): Instance | undefined => instances[activeTier];

// ---------------------------------------------------------------- loading ----

/** Load one tier's processor+model (deduped). Emits download/compile status only when asked. */
function loadTier(tier: ModelTier, emitStatus: boolean): Promise<Instance> {
  const cached = instances[tier];
  if (cached) return Promise.resolve(cached);
  const inFlight = tierLoads.get(tier);
  if (inFlight) return inFlight;

  const id = MODEL_DIR[tier];
  let sawFull = false;
  let lastPostAt = 0;
  let lastPct = -1;
  const progress_callback = (e: { status?: string; progress?: number; loaded?: number; total?: number }) => {
    if (!emitStatus || e.status !== 'progress_total') return;
    const pct = Math.max(0, Math.min(100, e.progress ?? 0));
    if (pct >= 99.5 && !sawFull) {
      sawFull = true;
      post({ type: 'status', status: { state: 'compiling' } });
    } else if (pct < 99.5) {
      // Throttle: raw callbacks fire per network chunk (thousands of
      // postMessages for a 3.4GB load). One update per 250ms or ≥1% step.
      const now = performance.now();
      if (now - lastPostAt < 250 && pct - lastPct < 1) return;
      lastPostAt = now;
      lastPct = pct;
      post({
        type: 'status',
        status: {
          state: 'downloading',
          pct,
          mbDone: e.loaded ? +(e.loaded / 1e6).toFixed(1) : undefined,
          mbTotal: e.total ? +(e.total / 1e6).toFixed(1) : undefined,
        },
      });
    }
  };

  const loadOpts = { dtype: DTYPE, device: 'webgpu', progress_callback } as unknown as Parameters<
    typeof AutoModelForImageTextToText.from_pretrained
  >[1];

  const promise = (async (): Promise<Instance> => {
    // SEQUENTIAL on purpose: processor and model both read the same config
    // JSONs through transformers.js's Cache API layer; loading them
    // concurrently on a cold cache races cache.put/match and one side can get
    // `undefined` back (seen live: "reading 'tokenizer_class'"). The processor
    // is a few KB of JSON — sequencing costs nothing next to the weights.
    const proc = await AutoProcessor.from_pretrained(id);
    const mdl = await AutoModelForImageTextToText.from_pretrained(id, loadOpts);
    const inst: Instance = { processor: proc as unknown as LoadedProcessor, model: mdl as unknown as LoadedModel };
    instances[tier] = inst;
    return inst;
  })();

  tierLoads.set(tier, promise);
  void promise.catch(() => undefined).finally(() => tierLoads.delete(tier));
  return promise;
}

/**
 * Purge just the small config/template entries (JSON + jinja) under the current
 * remoteHost from transformers.js's Cache Storage. A poisoned entry there — e.g.
 * a truncated config.json written during a flaky first load — otherwise bricks
 * loading permanently ("reading 'tokenizer_class'" on every reload). The big
 * weights (.onnx / .onnx_data) are left intact, so the retry only re-fetches a
 * few KB. Returns how many entries were deleted.
 */
async function purgeConfigCache(): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  const host = env.remoteHost ?? '';
  const cacheKey = (env as { cacheKey?: string }).cacheKey ?? 'transformers-cache';
  try {
    const cache = await caches.open(cacheKey);
    const keys = await cache.keys();
    let deleted = 0;
    for (const req of keys) {
      if (host && !req.url.startsWith(host)) continue;
      let path = req.url;
      try {
        path = new URL(req.url).pathname;
      } catch {
        // non-URL cache key — match against the raw string instead
      }
      if (/\.(json|jinja)$/.test(path) && (await cache.delete(req))) deleted++;
    }
    return deleted;
  } catch {
    return 0;
  }
}

/** Primary load: bring up `tier`, report ready, then silently pre-warm the other tier. */
async function primaryLoad(tier: ModelTier, prewarm: boolean): Promise<void> {
  activeTier = tier;
  post({ type: 'status', status: { state: 'downloading', pct: 0 } });
  const t0 = performance.now();
  try {
    await loadTier(tier, true);
  } catch {
    // A poisoned config/template cache entry bricks loading permanently. Purge
    // just those small JSON/jinja entries (weights stay cached) and retry ONCE
    // before giving up.
    const purged = await purgeConfigCache();
    tierLoads.delete(tier); // ensure the retry starts fresh, not the rejected promise
    try {
      await loadTier(tier, true);
    } catch (err2) {
      post({
        type: 'status',
        status: {
          state: 'error',
          message: `${String(err2).slice(0, 220)} (retried after purging ${purged} cached config files)`,
        },
      });
      return;
    }
  }
  post({ type: 'status', status: { state: 'ready', tier, loadMs: Math.round(performance.now() - t0) } });

  if (prewarm) {
    // DEFER — don't start now. Arm it for the first completed turn (main thread
    // posts 'prewarm') or a PREWARM_IDLE_MS fallback, whichever comes first.
    prewarmTier = OTHER[tier];
    prewarmStarted = false;
    prewarmTimer = setTimeout(maybeStartPrewarm, PREWARM_IDLE_MS);
  }
}

/** Start the deferred other-tier pre-warm exactly once (background, silent). */
function maybeStartPrewarm(): void {
  if (!prewarmTier || prewarmStarted) return;
  prewarmStarted = true;
  if (prewarmTimer !== null) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
  }
  // On failure (e.g. GPU OOM) leave it uncached so switchTier falls back to an
  // on-demand load with a 'compiling' status.
  void loadTier(prewarmTier, false).catch(() => undefined);
}

/** Tier switch: instant hot-swap if warm, else load-on-demand with status. */
async function switchTier(tier: ModelTier): Promise<void> {
  if (instances[tier]) {
    activeTier = tier;
    post({ type: 'status', status: { state: 'ready', tier, loadMs: 0 } });
    return;
  }
  // Not warm yet (pre-warm disabled or still in flight): show compiling and wait.
  post({ type: 'status', status: { state: 'compiling' } });
  const t0 = performance.now();
  try {
    await loadTier(tier, true);
  } catch (err) {
    post({ type: 'status', status: { state: 'error', message: String(err).slice(0, 300) } });
    return;
  }
  activeTier = tier;
  post({ type: 'status', status: { state: 'ready', tier, loadMs: Math.round(performance.now() - t0) } });
}

async function ensureActive(): Promise<Instance> {
  return active() ?? loadTier(activeTier, true);
}

// ------------------------------------------------------------- generation ----

interface GenSpec {
  id: number;
  kind: GenerateKind;
  messages: unknown;
  tools?: unknown;
  maxNewTokens?: number;
  audio?: Float32Array;
  image?: RawFrame;
}

async function generate(spec: GenSpec): Promise<void> {
  // Abort can land while this request is still queued behind a model load or
  // input preprocessing — before the stopping-criteria can bite. Bail at each
  // pre-generation await point and resolve the request cleanly as aborted.
  const bailIfAborted = (): boolean => {
    if (!abortedIds.has(spec.id)) return false;
    abortedIds.delete(spec.id);
    post({ type: 'result', id: spec.id, aborted: true, result: { text: '', rawText: '', nTokens: 0, prefillMs: 0, decodeTps: 0 } });
    return true;
  };

  const { processor, model } = await ensureActive();
  if (bailIfAborted()) return;

  const chatText = processor.apply_chat_template(spec.messages, {
    add_generation_prompt: true,
    ...(spec.tools ? { tools: spec.tools } : {}),
  });

  const image = spec.image
    ? new RawImage(new Uint8ClampedArray(spec.image.data), spec.image.width, spec.image.height, 4)
    : null;
  const audio = spec.audio ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs = (await processor(chatText, image, audio, { add_special_tokens: false })) as any;
  if (bailIfAborted()) return;
  const promptLen: number = inputs.input_ids.dims.at(-1);

  let nTokens = 0;
  let tFirst = 0;
  let tLast = 0;
  const streamer = new TextStreamer(processor.tokenizer as never, {
    skip_prompt: true,
    skip_special_tokens: false, // markers are plain text; strip on display, keep for parsing
    token_callback_function: () => {
      nTokens++;
      const now = performance.now();
      if (nTokens === 1) tFirst = now;
      tLast = now;
    },
    callback_function: (chunk: string) => {
      if (spec.kind === 'chat' && chunk) post({ type: 'token', id: spec.id, chunk });
    },
  });

  const stop = new InterruptableStoppingCriteria();
  activeStops.set(spec.id, stop);

  const t0 = performance.now();
  let aborted = false;
  let out: { slice(a: null, b: Array<number | null>): unknown };
  try {
    out = await model.generate({
      ...inputs,
      max_new_tokens: spec.maxNewTokens ?? 512,
      do_sample: false,
      streamer,
      stopping_criteria: stop,
    });
  } finally {
    aborted = stop.interrupted === true;
    activeStops.delete(spec.id);
  }

  const newTokens = out.slice(null, [promptLen, null]);
  const rawText = processor.batch_decode(newTokens, { skip_special_tokens: false })[0] ?? '';
  const prefillMs = tFirst ? Math.round(tFirst - t0) : 0;
  const decodeTps = nTokens > 1 ? +((nTokens - 1) / ((tLast - tFirst) / 1000)).toFixed(1) : 0;

  abortedIds.delete(spec.id);
  post({
    type: 'result',
    id: spec.id,
    aborted,
    result: { text: stripMarkers(rawText).trim(), rawText, nTokens, prefillMs, decodeTps },
  });
}

// ---------------------------------------------------------------- routing ----

ctx.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'load':
      // Use the REMOTE pathway, not localModelPath: transformers.js 4.2.0's
      // get_file_metadata treats an absolute-URL localModelPath as a remote
      // source and, with allowRemoteModels=false, short-circuits to
      // exists:false — get_tokenizer_files then returns [] and the tokenizer
      // config destructures to undefined ("reading 'tokenizer_class'").
      // remoteHost/remotePathTemplate is the library's native cross-origin
      // mechanism (same one the HF CDN uses) and works for both the dev
      // mirror (localhost:8737) and prod R2.
      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      env.remoteHost = msg.modelBaseUrl;
      env.remotePathTemplate = '{model}';
      void primaryLoad(msg.tier, msg.prewarm);
      break;
    case 'setTier':
      void switchTier(msg.tier);
      break;
    case 'prewarm':
      maybeStartPrewarm();
      break;
    case 'generate':
      inFlight.add(msg.id);
      generate({
        id: msg.id,
        kind: msg.kind,
        messages: msg.messages,
        tools: msg.tools,
        maxNewTokens: msg.maxNewTokens,
        audio: msg.audio,
        image: msg.image,
      })
        .catch((err) => post({ type: 'error', id: msg.id, message: String(err).slice(0, 300) }))
        .finally(() => {
          inFlight.delete(msg.id);
          abortedIds.delete(msg.id);
        });
      break;
    case 'abort': {
      // Ignore aborts for ids with no active/pending generation (already settled,
      // or never issued) — otherwise abortedIds would leak stale entries.
      if (!inFlight.has(msg.id)) break;
      // Mark it aborted (caught at the pre-generation bail points) AND interrupt
      // it if decoding has already started — covers both windows.
      abortedIds.add(msg.id);
      const stop = activeStops.get(msg.id);
      if (stop) stop.interrupt();
      break;
    }
  }
});
