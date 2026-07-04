// Mock implementation of the src/agent/index.ts façade, driven by scripted
// setTimeout event sequences instead of a real model. Lets the whole UI be
// built and visually verified (see spike/ui-selfcheck.mjs) before — or
// independent of — the real agent/llm/tools layer landing. main.ts picks
// this over the real one via ?mock=1, or automatically if the real one
// isn't there yet.

import type { AgentEvent, AgentEventHandler, ModelTier, PackInfo } from '../lib/contract';

export interface HeliusHandle {
  sendText(text: string): Promise<void>;
  sendVoice(audio: Float32Array): Promise<void>;
  readSign(image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Promise<void>;
  setTier(tier: ModelTier): Promise<void>;
  listPacks(): Promise<PackInfo[]>;
  switchPack(packId: string): Promise<void>;
  abort(): void;
  getStats(): { decodeTps: number; prefillMs: number } | null;
}

export interface CreateHeliusOptions {
  modelBaseUrl: string;
  onEvent: AgentEventHandler;
}

const RESPONSE_TEXT =
  "You have 2 hours 14 minutes of light left. Head west 0.6 miles down the ridge trail — you'll reach the trailhead by 7:41 PM with time to spare.";

const MOCK_PACKS: PackInfo[] = [
  { id: 'sandia', name: 'Sandia', bbox: [-106.7, 34.9, -106.2, 35.4], center: [-106.4439, 35.1983], totalBytes: 42_000_000 },
  { id: 'chamonix', name: 'Chamonix', bbox: [6.7, 45.8, 7.1, 46.0], center: [6.885, 45.97], totalBytes: 38_000_000 },
];

function createTimerBag() {
  const ids: number[] = [];
  return {
    schedule(delay: number, fn: () => void): void {
      ids.push(window.setTimeout(fn, delay));
    },
    clearAll(): void {
      ids.forEach((id) => window.clearTimeout(id));
      ids.length = 0;
    },
  };
}

export async function createHelius(opts: CreateHeliusOptions): Promise<HeliusHandle> {
  const { onEvent } = opts;
  const timers = createTimerBag();
  let currentTier: ModelTier = 'E2B';
  let lastStats: { decodeTps: number; prefillMs: number } | null = null;

  function emit(e: AgentEvent): void {
    onEvent(e);
  }

  function runBootSequence(onReady: () => void): void {
    timers.schedule(0, () =>
      emit({ type: 'engine-status', status: { state: 'downloading', pct: 0, file: 'decoder.onnx', mbDone: 0, mbTotal: 1450 } })
    );
    timers.schedule(300, () =>
      emit({ type: 'engine-status', status: { state: 'downloading', pct: 22, file: 'decoder.onnx', mbDone: 320, mbTotal: 1450 } })
    );
    timers.schedule(700, () =>
      emit({ type: 'engine-status', status: { state: 'downloading', pct: 54, file: 'decoder.onnx', mbDone: 780, mbTotal: 1450 } })
    );
    timers.schedule(1100, () =>
      emit({ type: 'engine-status', status: { state: 'downloading', pct: 88, file: 'embed.onnx', mbDone: 1280, mbTotal: 1450 } })
    );
    timers.schedule(1400, () =>
      emit({ type: 'engine-status', status: { state: 'downloading', pct: 100, file: 'embed.onnx', mbDone: 1450, mbTotal: 1450 } })
    );
    timers.schedule(1550, () => emit({ type: 'engine-status', status: { state: 'compiling' } }));
    timers.schedule(2100, () => {
      emit({ type: 'engine-status', status: { state: 'ready', tier: currentTier, loadMs: 2100 } });
      onReady();
    });
  }

  // Runs one full scripted turn: user msg -> locate -> sun_clock -> route_back
  // (+ a 'route' event) -> streaming tokens -> assistant-done -> speak, then
  // arms the beacon as a bonus beat so beacon.ts gets exercised too. `userText`
  // is echoed verbatim (real if typed, a canned placeholder for voice/sign)
  // but the tool chain + response are always the same deterministic script.
  function runDemoTurn(userText: string): void {
    timers.clearAll();
    let step = 0;

    timers.schedule(0, () => emit({ type: 'agent-turn-start' }));
    timers.schedule(100, () => emit({ type: 'user-message', text: userText }));

    const locateStep = step++;
    timers.schedule(400, () => emit({ type: 'tool-start', call: { name: 'locate', args: {} }, step: locateStep }));
    timers.schedule(850, () =>
      emit({ type: 'tool-done', name: 'locate', summary: 'fix 35.1983,-106.4439 ±14m', ms: 450, step: locateStep })
    );

    const sunStep = step++;
    timers.schedule(1000, () =>
      emit({ type: 'tool-start', call: { name: 'sun_clock', args: { lat: 35.1983, lon: -106.4439 } }, step: sunStep })
    );
    timers.schedule(1250, () =>
      emit({ type: 'tool-done', name: 'sun_clock', summary: 'sunset 19:41 · 2h14m of light left', ms: 250, step: sunStep })
    );

    const routeStep = step++;
    timers.schedule(1400, () =>
      emit({ type: 'tool-start', call: { name: 'route_back', args: { to: 'trailhead' } }, step: routeStep })
    );
    timers.schedule(2100, () => {
      emit({ type: 'tool-done', name: 'route_back', summary: '3.9km · 62min via ridge trail west', ms: 700, step: routeStep });
      emit({
        type: 'route',
        geojson: {
          type: 'LineString',
          coordinates: [
            [-106.4439, 35.1983],
            [-106.4496, 35.21],
          ],
        },
        distanceM: 3900,
        etaMin: 62,
      });
    });

    const words = RESPONSE_TEXT.split(/(?<=\s)/);
    let cursor = 2400;
    for (const word of words) {
      const at = cursor;
      timers.schedule(at, () => emit({ type: 'assistant-token', text: word }));
      cursor += 70;
    }
    timers.schedule(cursor + 100, () => {
      const stats = { decodeTps: 34.2, prefillMs: 180 };
      lastStats = stats;
      emit({ type: 'assistant-done', text: RESPONSE_TEXT, stats });
    });
    timers.schedule(cursor + 250, () => emit({ type: 'speak', text: RESPONSE_TEXT }));
    timers.schedule(cursor + 350, () => emit({ type: 'agent-turn-done' }));
    timers.schedule(cursor + 850, () => emit({ type: 'beacon', action: 'arm' }));
  }

  await new Promise<void>((resolve) => {
    runBootSequence(() => {
      timers.schedule(500, () => {
        runDemoTurn('Get me back to the trailhead before dark');
        resolve();
      });
    });
  });

  return {
    async sendText(text: string) {
      runDemoTurn(text);
    },
    async sendVoice(_audio: Float32Array) {
      runDemoTurn('Get me back to the trailhead before dark');
    },
    async readSign(_image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas) {
      runDemoTurn('What does this trail sign say?');
    },
    async setTier(tier: ModelTier) {
      await new Promise<void>((resolve) => timers.schedule(400, resolve));
      currentTier = tier;
      emit({ type: 'engine-status', status: { state: 'ready', tier, loadMs: 400 } });
    },
    async listPacks() {
      return MOCK_PACKS;
    },
    async switchPack(packId: string) {
      const info = MOCK_PACKS.find((p) => p.id === packId);
      if (!info) throw new Error(`unknown pack: ${packId}`);
      await new Promise<void>((resolve) => timers.schedule(300, resolve));
      emit({ type: 'pack-changed', pack: info, fix: { lat: info.center[1], lon: info.center[0] } });
    },
    abort() {
      timers.clearAll();
      emit({ type: 'agent-turn-done' });
    },
    getStats() {
      return lastStats;
    },
  };
}
