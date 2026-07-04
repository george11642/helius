// Text-to-speech: local voice output via kokoro-js, queued and played through
// a persistent AudioContext + GainNode (so the header mute toggle can silence
// in-flight speech instantly, not just future lines). Lazily initializes on
// the first 'speak' event — no reason to pay kokoro's ~86MB load before it's
// actually needed. If it fails to load (WebGPU unsupported, offline before
// weights are cached, etc.) this degrades to a console.warn and stays
// silent; speech is a nice-to-have and must never block the agent.

import { KokoroTTS } from 'kokoro-js';
import type { RawAudio } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';

// The installed kokoro-js .d.ts types `dtype` as "fp32"|"fp16"|"q8"|"q4"|"q4f16" —
// narrower than the runtime-accepted dtype strings. 'q8f16' is a real
// onnx-community quant variant (~86MB) confirmed during project research; cast
// through unknown to keep the researched value instead of silently widening it.
const PRIMARY_OPTIONS = { dtype: 'q8f16', device: 'webgpu' } as unknown as Parameters<typeof KokoroTTS.from_pretrained>[1];
const FALLBACK_OPTIONS: Parameters<typeof KokoroTTS.from_pretrained>[1] = { dtype: 'q8', device: 'wasm' };

let ttsPromise: Promise<KokoroTTS | null> | null = null;
let muted = false;

// Test-only instrumentation hook: no-op unless spike/kokoro-webgpu-verify.mjs
// (or similar) sets window.__ttsTestHook before this module loads. Never set
// in normal use — lets verification scripts observe real load/generate
// timing and the actual synthesized audio without adding a production UI.
declare global {
  interface Window {
    __ttsTestHook?: (event: { phase: string; ms: number; data?: Float32Array; sampleRate?: number }) => void;
  }
}
function reportHook(phase: string, extra?: { data: Float32Array; sampleRate: number }): void {
  window.__ttsTestHook?.({ phase, ms: performance.now(), ...extra });
}

const audioCtx = new AudioContext();
const gain = audioCtx.createGain();
gain.connect(audioCtx.destination);

// Audio can't play until a user gesture unlocks the context on most browsers;
// opportunistically resume on the first interaction anywhere on the page.
function resumeOnce(): void {
  void audioCtx.resume();
  document.removeEventListener('pointerdown', resumeOnce);
  document.removeEventListener('keydown', resumeOnce);
}
document.addEventListener('pointerdown', resumeOnce);
document.addEventListener('keydown', resumeOnce);

const queue: string[] = [];
let draining = false;

// Verified (spike/kokoro-webgpu-verify.mjs): calling KokoroTTS.from_pretrained
// a second time for the SAME model with a different `device` after the first
// attempt failed does NOT retry cleanly under transformers.js 4.2.0 — the
// second call inherits the first's error verbatim (a session/model caching
// bug keyed by model id, not by device/dtype). Wasm-only and webgpu-only each
// work fine in isolation; it's specifically the retry-after-failure pattern
// that's broken. Fix: detect WebGPU availability *before* ever calling
// from_pretrained, and call it exactly once with the right options — no
// retry needed, and no kokoro/transformers internals touched.
async function hasWebGpuAdapter(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function loadTts(): Promise<KokoroTTS | null> {
  if (!ttsPromise) {
    reportHook('load-start');
    ttsPromise = hasWebGpuAdapter()
      .then((webgpu) => KokoroTTS.from_pretrained(MODEL_ID, webgpu ? PRIMARY_OPTIONS : FALLBACK_OPTIONS))
      .then((tts) => {
        reportHook('load-done');
        return tts;
      })
      .catch((err: unknown) => {
        console.warn('[helius] kokoro-js failed to load; TTS disabled', err);
        reportHook('load-error');
        return null;
      });
  }
  return ttsPromise;
}

function playRawAudio(raw: RawAudio): Promise<void> {
  return new Promise((resolve) => {
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const buffer = audioCtx.createBuffer(1, raw.data.length, raw.sampling_rate);
    // raw.data is typed Float32Array<ArrayBufferLike> (could in principle be
    // SharedArrayBuffer-backed); copyToChannel wants the concrete ArrayBuffer
    // variant, so copy into a fresh plain Float32Array rather than asserting.
    buffer.copyToChannel(Float32Array.from(raw.data), 0);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => resolve();
    source.start();
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  const tts = await loadTts();
  while (queue.length > 0) {
    const text = queue.shift()!;
    if (!tts) continue; // model unavailable — drop queued lines silently
    try {
      reportHook('generate-start');
      const raw = await tts.generate(text, { voice: VOICE });
      reportHook('generate-done', { data: raw.data, sampleRate: raw.sampling_rate });
      await playRawAudio(raw);
    } catch (err) {
      console.warn('[helius] kokoro-js generate/play failed', err);
      reportHook('generate-error');
    }
  }
  draining = false;
}

export function speak(text: string): void {
  if (!text.trim()) return;
  queue.push(text);
  void drain();
}

// Test-only: lets verification scripts call the real speak() with an
// arbitrary phrase (e.g. to check duration bounds) without going through the
// whole agent/mock event pipeline. Harmless — just exposes the function
// already exported above.
window.__heliusSpeakForTest = speak;
declare global {
  interface Window {
    __heliusSpeakForTest?: (text: string) => void;
  }
}

export function setMuted(next: boolean): void {
  muted = next;
  gain.gain.value = muted ? 0 : 1;
}

export function isMuted(): boolean {
  return muted;
}
