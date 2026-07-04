// Public façade for the whole LLM/agent/tool layer. The UI imports ONLY this
// (plus types from ../lib/contract). createHelius wires the worker engine, the
// tool registry, and the agent loop together and hands back a small surface.

import type { AgentEventHandler, ModelTier, PackInfo } from '../lib/contract';
import { createEngine, frameFromImage } from '../llm/engine';
import { runPreflight } from '../llm/preflight';
import { createTools } from '../tools/registry';
import { setPack, listPacks, defaultFixFor } from '../tools/pack';
import { clearPackCache } from '../tools/route';
import { getFix, isDemoMode, setSimulatedFix } from '../tools/location';
import { createAgentLoop } from './loop';
import { SYSTEM_PROMPT } from './prompt';

export interface Helius {
  sendText(text: string): Promise<void>;
  sendVoice(audio: Float32Array): Promise<void>; // 16kHz mono
  readSign(image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Promise<void>;
  setTier(tier: ModelTier): Promise<void>;
  /** Available region packs (id/name/bbox/center/size), for a picker. */
  listPacks(): Promise<PackInfo[]>;
  /** Switch region: swaps the active pack, invalidates the route cache, moves
   *  the demo fix to the pack's default, and emits a 'pack-changed' event. */
  switchPack(packId: string): Promise<void>;
  /** Start the model load explicitly (map-only boots, or overriding a
   *  pre-flight veto). The worker dedupes repeat loads of the same tier. */
  loadModel(): Promise<void>;
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
  /**
   * Kick off the model load automatically after the capability pre-flight
   * (default true — the judge/video flow is unchanged). The pre-flight still
   * vetoes an autoload on an 'unsupported' verdict (phone / no WebGPU / not
   * enough storage): those devices boot into map-only mode (engine-status
   * 'idle') instead of starting a ~3.2GB download that cannot end well; the
   * UI can still call helius.loadModel() to override. Set false to gate the
   * load behind onboarding entirely.
   */
  autoload?: boolean;
}

export async function createHelius(opts: CreateHeliusOptions): Promise<Helius> {
  setPack(opts.pack ?? 'sandia');

  const engine = createEngine(
    opts.modelBaseUrl,
    (status) => opts.onEvent({ type: 'engine-status', status }),
    opts.prewarm ?? false,
  );

  // Wrap the event sink so we can kick off the deferred other-tier pre-warm
  // after the FIRST completed turn — a fast first impression beats instant
  // swap-readiness (the worker also has a 45s idle fallback). No-op when
  // prewarm is disabled (the worker just ignores the trigger).
  let firstTurnDone = false;
  const emit: AgentEventHandler = (e) => {
    opts.onEvent(e);
    if (e.type === 'agent-turn-done' && !firstTurnDone) {
      firstTurnDone = true;
      engine.triggerPrewarm();
    }
  };

  const registry = createTools({
    emit,
    engine: {
      visionInfer: async (frame, prompt) => {
        const r = await engine.visionInfer(frame, prompt);
        return { text: r.text, rawText: r.rawText };
      },
    },
  });

  const loop = createAgentLoop({ engine, registry, emit, systemPrompt: SYSTEM_PROMPT });

  const startLoad = (): Promise<void> =>
    engine.load('E2B').catch(() => {
      /* surfaced via engine-status 'error' */
    });

  // Capability pre-flight, then (by default) the default-tier load; progress +
  // ready/error surface through onEvent (engine-status). Façade creation is
  // not blocked on any of it so the UI can render its loading state
  // immediately — the worker queues any early sendText behind the in-flight
  // load. An 'unsupported' verdict (phone / no WebGPU / not enough storage)
  // vetoes the autoload and boots map-only (engine-status 'idle'); the UI can
  // still call loadModel() to override.
  void (async () => {
    let vetoed = false;
    try {
      const pf = await runPreflight();
      opts.onEvent({ type: 'engine-status', status: { state: 'preflight', verdict: pf.verdict, caps: pf.caps } });
      vetoed = pf.verdict === 'unsupported';
    } catch {
      // The probe itself failing must never block the load path.
    }
    if ((opts.autoload ?? true) && !vetoed) void startLoad();
    else opts.onEvent({ type: 'engine-status', status: { state: 'idle' } });
  })();

  return {
    sendText: (text) => loop.runText(text),
    sendVoice: (audio) => loop.runVoice(audio),
    readSign: (image) => loop.readSign(frameFromImage(image)),
    setTier: (tier) => engine.setTier(tier),
    listPacks: () => listPacks(),
    switchPack: async (packId: string): Promise<void> => {
      setPack(packId);
      clearPackCache(); // next route_back lazy-loads the new pack's graph + POIs
      // Only DEMO GPS follows the pack around: hopping the simulated fix to the
      // new region is the demo affordance. A real GPS fix is the truth — it
      // stays put, and locate/route_back report coverage against the new pack
      // honestly instead of teleporting the user.
      const fix = isDemoMode() ? defaultFixFor(packId) : getFix();
      if (isDemoMode() && fix) setSimulatedFix(fix);
      const info = (await listPacks()).find((p) => p.id === packId);
      if (!info) throw new Error(`unknown pack: ${packId}`);
      opts.onEvent({
        type: 'pack-changed',
        pack: info,
        fix: { lat: fix?.lat ?? info.center[1], lon: fix?.lon ?? info.center[0] },
      });
    },
    loadModel: () => startLoad(),
    abort: () => loop.abort(),
    getStats: () => engine.getStats(),
  };
}

export type { AgentLoop } from './loop';
