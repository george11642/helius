// Helius H0 runtime spike.
// Measures, on THIS machine + THIS Chrome: model load time, prefill latency,
// decode tok/s, and raw native tool-call output format for Gemma 4 E2B via
// transformers.js 4.2.0 on WebGPU. Logs machine-readable `SPIKE:{json}` lines.
import {
  env, AutoProcessor, AutoModelForImageTextToText, TextStreamer,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';

const $ = (s) => document.querySelector(s);
const logEl = $('#log');
const statusEl = $('#status');
const params = new URLSearchParams(location.search);

function log(tag, data, cls = '') {
  const line = `SPIKE:${JSON.stringify({ tag, ...data })}`;
  console.log(line);
  const div = document.createElement('div');
  div.textContent = `[${tag}] ${JSON.stringify(data)}`;
  if (cls) div.className = cls;
  logEl.appendChild(div);
}
function setStatus(s) { statusEl.textContent = s; }

const MODEL_ID = 'gemma-4-e2b-onnx'; // dir name under /models/ on the spike server
const HUB_ID = 'onnx-community/gemma-4-E2B-it-ONNX';

const TOOLS = [
  { type: 'function', function: { name: 'locate', description: 'Get the user\'s current position (lat, lon, accuracy in meters) from GPS or the simulated fix.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'route_back', description: 'Compute a walking route from the current position back to a known safe destination over the offline trail graph. Returns distance, turn-by-turn directions, and ETA at current pace.', parameters: { type: 'object', properties: { destination: { type: 'string', enum: ['trailhead', 'crest', 'tram_station'], description: 'Which safe point to route to.' } }, required: ['destination'] } } },
  { type: 'function', function: { name: 'sun_clock', description: 'Get sunset time and remaining daylight minutes at the current position and date.', parameters: { type: 'object', properties: {}, required: [] } } },
];

const PROBES = [
  { id: 'P1-chain', system: 'You are Helius, an offline navigation and signaling agent. You have no network access. Use the provided tools to help. Always call a tool when one applies; do not invent positions, routes, or times.', user: "I'm off the trail and I'm not sure where I am. Get me back to the trailhead before sunset." },
  { id: 'P2-sun', system: 'You are Helius, an offline navigation and signaling agent. Use the provided tools. Never invent data a tool can compute.', user: 'How much daylight do I have left?' },
  { id: 'P3-refuse', system: 'You are Helius, an offline navigation and signaling agent for navigation, signaling, and procedural field tasks only. You are strictly non-medical: refuse medical questions and instead advise contacting emergency services when reachable.', user: 'My friend got bitten by a snake, what medication should I give him?' },
];

let processor = null, model = null;

async function checkWebGPU() {
  if (!navigator.gpu) { log('webgpu', { ok: false, reason: 'navigator.gpu missing' }, 'bad'); return false; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { log('webgpu', { ok: false, reason: 'no adapter' }, 'bad'); return false; }
  const info = adapter.info || {};
  log('webgpu', { ok: true, vendor: info.vendor, architecture: info.architecture, description: info.description, crossOriginIsolated: self.crossOriginIsolated }, 'ok');
  return true;
}

async function loadModel() {
  const src = params.get('src') || 'local';
  const enc = params.get('enc') || 'q4f16';
  let id;
  if (src === 'local') {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    id = MODEL_ID;
  } else {
    id = HUB_ID;
  }
  const dtype = {
    audio_encoder: enc === 'fp16' ? 'fp16' : 'q4f16',
    vision_encoder: enc === 'fp16' ? 'fp16' : 'q4f16',
    embed_tokens: 'q4f16',
    decoder_model_merged: 'q4f16',
  };
  log('load-start', { id, src, dtype });
  setStatus('loading model…');
  const t0 = performance.now();
  let lastPct = -10;
  try {
    const [proc, mdl] = await Promise.all([
      AutoProcessor.from_pretrained(id),
      AutoModelForImageTextToText.from_pretrained(id, {
        dtype,
        device: 'webgpu',
        progress_callback: (e) => {
          if (e.status === 'progress_total' && e.progress - lastPct >= 10) {
            lastPct = e.progress;
            setStatus(`loading… ${Math.round(e.progress)}%`);
            console.log(`SPIKE-PROGRESS:${Math.round(e.progress)}`);
          }
        },
      }),
    ]);
    processor = proc; model = mdl;
    const ms = Math.round(performance.now() - t0);
    log('load-done', { ms, seconds: +(ms / 1000).toFixed(1) }, 'ok');
    setStatus(`model ready in ${(ms / 1000).toFixed(1)}s`);
    return true;
  } catch (err) {
    log('load-fail', { error: String(err).slice(0, 500) }, 'bad');
    setStatus('LOAD FAILED');
    return false;
  }
}

async function generate(messages, { tools = null, maxNew = 256 } = {}) {
  const text = processor.apply_chat_template(messages, {
    add_generation_prompt: true,
    ...(tools ? { tools } : {}),
  });
  const inputs = await processor(text, null, null, { add_special_tokens: false });
  let nTokens = 0, tFirst = 0, tLast = 0;
  const t0 = performance.now();
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    token_callback_function: () => {
      nTokens++;
      const now = performance.now();
      if (nTokens === 1) tFirst = now;
      tLast = now;
    },
    callback_function: () => {},
  });
  const out = await model.generate({ ...inputs, max_new_tokens: maxNew, do_sample: false, streamer });
  const newTokens = out.slice(null, [inputs.input_ids.dims.at(-1), null]);
  const decoded = processor.batch_decode(newTokens, { skip_special_tokens: false })[0];
  const prefillMs = Math.round(tFirst - t0);
  const decodeTps = nTokens > 1 ? +((nTokens - 1) / ((tLast - tFirst) / 1000)).toFixed(1) : 0;
  return { decoded, nTokens, prefillMs, decodeTps, promptTokens: inputs.input_ids.dims.at(-1) };
}

async function benchText() {
  setStatus('text benchmark…');
  const r = await generate([
    { role: 'system', content: 'You are Helius, a concise offline field assistant.' },
    { role: 'user', content: 'In 4 short bullet points, how do I stay findable if I am lost on a mountain at dusk?' },
  ], { maxNew: 200 });
  log('textgen', { promptTokens: r.promptTokens, newTokens: r.nTokens, prefillMs: r.prefillMs, decodeTps: r.decodeTps, sample: r.decoded.slice(0, 220) }, 'ok');
  return r;
}

async function probeToolLoop() {
  // Multi-turn: user asks -> assistant called locate -> tool responded -> what does the model do next?
  setStatus('tool loop probe…');
  try {
    const messages = [
      { role: 'system', content: 'You are Helius, an offline navigation agent. Use tools; never invent positions, routes, or times.' },
      { role: 'user', content: "I'm off the trail. Get me back to the trailhead before sunset." },
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'locate', arguments: {} } }] },
      { role: 'tool', name: 'locate', content: { lat: 35.1983, lon: -106.4439, accuracy_m: 14, elevation_m: 2926 } },
    ];
    const r = await generate(messages, { tools: TOOLS, maxNew: 256 });
    log('probe-loop', { prefillMs: r.prefillMs, decodeTps: r.decodeTps, raw: r.decoded.slice(0, 600) }, 'ok');
  } catch (err) {
    log('probe-loop-fail', { error: String(err).slice(0, 400) }, 'bad');
  }
}

async function probeAudio() {
  // Native Gemma 4 audio-in: transcribe a local fixture wav (the Space's proven pattern).
  setStatus('audio probe…');
  try {
    const resp = await fetch('/fixture.wav');
    const buf = await resp.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const decoded = await ctx.decodeAudioData(buf);
    // resample to 16k mono
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const srcNode = off.createBufferSource();
    srcNode.buffer = decoded;
    srcNode.connect(off.destination);
    srcNode.start();
    const rendered = await off.startRendering();
    const audio = rendered.getChannelData(0);
    log('audio-fixture', { seconds: +(audio.length / 16000).toFixed(2) });

    const text = processor.apply_chat_template([
      { role: 'system', content: 'Transcribe the following speech segment in English into English text.' },
      { role: 'user', content: [{ type: 'audio' }] },
    ], { add_generation_prompt: true });
    const inputs = await processor(text, null, audio, { add_special_tokens: false });
    const t0 = performance.now();
    const out = await model.generate({ ...inputs, max_new_tokens: 96, do_sample: false });
    const ms = Math.round(performance.now() - t0);
    const decodedText = processor.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true })[0].trim();
    log('probe-audio', { ms, transcript: decodedText }, 'ok');
  } catch (err) {
    log('probe-audio-fail', { error: String(err).slice(0, 400) }, 'bad');
  }
}

async function probeTools() {
  const results = [];
  for (const probe of PROBES) {
    setStatus(`tool probe ${probe.id}…`);
    try {
      const r = await generate([
        { role: 'system', content: probe.system },
        { role: 'user', content: probe.user },
      ], { tools: TOOLS, maxNew: 256 });
      log('probe', { id: probe.id, prefillMs: r.prefillMs, decodeTps: r.decodeTps, raw: r.decoded.slice(0, 600) });
      results.push({ id: probe.id, raw: r.decoded });
    } catch (err) {
      log('probe-fail', { id: probe.id, error: String(err).slice(0, 300) }, 'bad');
    }
  }
  return results;
}

async function runAll() {
  try {
    if (!(await checkWebGPU())) return;
    if (!(await loadModel())) return;
    const t = await benchText();
    await probeTools();
    await probeToolLoop();
    await probeAudio();
    log('SPIKE_DONE', { decodeTps: t.decodeTps, prefillMs: t.prefillMs }, 'ok');
    setStatus('SPIKE COMPLETE');
  } catch (err) {
    log('spike-crash', { error: String(err).slice(0, 500) }, 'bad');
    setStatus('SPIKE CRASHED');
  }
}

window.__spike = { generate, get processor() { return processor; }, get model() { return model; }, TOOLS, loadModel };
$('#btn-run').onclick = runAll;
$('#btn-load').onclick = async () => { await checkWebGPU() && loadModel(); };
if (params.get('auto') === '1') runAll();
