#!/usr/bin/env node
// video/music.mjs — 60s cinematic-tech music bed.
//
// Source order (first success wins):
//   default : ElevenLabs Music v2  →  synthesized placeholder
//   --fal   : fal CassetteAI       →  ElevenLabs Music v2  →  synthesized placeholder
//
// fal is behind --fal because its balance is currently locked (403); ElevenLabs
// Music needs a paid plan (free tier → 402) even though the SAME key's TTS works.
// The synthesized placeholder keeps the video pipeline unblocked until either is
// topped up. Everything is written to music.mp3.tmp, verified (~60s, non-silent),
// then atomic-renamed — a partial/failed source can never leave a stale music.mp3
// that blocks the placeholder fallback.
//
//   set -a; source ~/.config/global.env; set +a
//   node music.mjs           # ElevenLabs Music primary
//   node music.mjs --fal     # fal primary (once its balance is topped up)

import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'music.mp3');
const TMP = `${OUT}.tmp`;
const PROMPT = 'minimal cinematic tech pulse, warm analog synth, steady build, no drums first 8 seconds';
const USE_FAL = process.argv.includes('--fal');

function findAudioUrl(o, d = 0) {
  if (!o || typeof o !== 'object' || d > 4) return null;
  if (o.audio_file?.url) return o.audio_file.url;
  if (o.audio?.url) return o.audio.url;
  if (typeof o.audio_url === 'string') return o.audio_url;
  if (typeof o.url === 'string' && /\.(mp3|wav|m4a|aac)(\?|$)/i.test(o.url)) return o.url;
  for (const k of Object.keys(o)) {
    const f = findAudioUrl(o[k], d + 1);
    if (f) return f;
  }
  return null;
}
const download = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  await writeFile(TMP, Buffer.from(await r.arrayBuffer()));
};

// --- ElevenLabs Music v2 (confirmed via Context7: POST /v1/music → binary audio) ---
async function tryElevenMusic() {
  const KEY = process.env.ELEVENLABS_API_KEY;
  if (!KEY) throw new Error('ELEVENLABS_API_KEY unset');
  const res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192', {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, music_length_ms: 60000, model_id: 'music_v2' }),
  });
  if (!res.ok) throw new Error(`eleven-music ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    const j = await res.json();
    if (typeof j.audio === 'string') {
      await writeFile(TMP, Buffer.from(j.audio, 'base64'));
      return;
    }
    const url = findAudioUrl(j);
    if (!url) throw new Error('eleven-music: no audio in json');
    await download(url);
  } else {
    await writeFile(TMP, Buffer.from(await res.arrayBuffer()));
  }
}

// --- fal CassetteAI (sync or async queue) ---
async function tryFal() {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error('FAL_KEY unset');
  const res = await fetch('https://fal.run/cassetteai/music-generator', {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: `${PROMPT}, 60 seconds`, duration: 60 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`fal ${res.status}: ${text.slice(0, 180)}`);
  let json = JSON.parse(text);
  if (typeof json.status === 'string' && (json.status_url || json.response_url) && !findAudioUrl(json)) {
    let status = json.status;
    for (let i = 0; i < 60 && status !== 'COMPLETED'; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await (await fetch(json.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } })).json();
      status = s.status;
      if (status === 'FAILED' || status === 'ERROR') throw new Error(`fal job ${status}`);
    }
    if (status !== 'COMPLETED') throw new Error('fal queue timeout');
    json = await (await fetch(json.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } })).json();
  }
  const url = findAudioUrl(json);
  if (!url) throw new Error('fal: no audio url');
  await download(url);
}

// --- synthesized placeholder (ffmpeg, always available) ---
async function synthPlaceholder() {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=110:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=164.81:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60',
    '-filter_complex',
    '[0][1][2]amix=inputs=3:normalize=0,volume=0.33,tremolo=f=0.15:d=0.4,lowpass=f=900,afade=t=in:st=0:d=8,afade=t=out:st=56:d=4',
    '-ar', '44100', '-f', 'mp3', TMP, // -f mp3: the .tmp extension can't infer the muxer
  ]);
}

async function verify(pathArg) {
  const { stdout: dur } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', pathArg]);
  const seconds = parseFloat(dur);
  const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-i', pathArg, '-af', 'volumedetect', '-f', 'null', '-']).catch((e) => ({ stderr: e.stderr || '' }));
  const m = /mean_volume:\s*(-?[0-9.]+) dB/.exec(stderr);
  const meanDb = m ? parseFloat(m[1]) : NaN;
  const silent = !Number.isFinite(meanDb) || meanDb < -60;
  console.log(`  verify: ${seconds.toFixed(1)}s, mean_volume ${Number.isFinite(meanDb) ? meanDb + 'dB' : '?'} → ${silent ? 'SILENT ⚠' : 'audible ✓'}`);
  if (!Number.isFinite(seconds) || seconds < 3) throw new Error(`bad duration ${dur.trim()}`);
  if (silent) throw new Error('audio is silent');
}

async function main() {
  const chain = USE_FAL
    ? [['fal CassetteAI', tryFal], ['ElevenLabs Music v2', tryElevenMusic]]
    : [['ElevenLabs Music v2', tryElevenMusic]];

  let produced = null;
  for (const [name, fn] of chain) {
    try {
      console.log(`trying ${name}…`);
      await fn();
      await verify(TMP);
      produced = name;
      break;
    } catch (err) {
      console.warn(`  ${name} unavailable: ${err.message}`);
    }
  }

  if (!produced) {
    console.warn('!! No AI music source available (fal balance-locked / ElevenLabs Music needs a paid plan).');
    console.warn('!! Writing a SYNTHESIZED PLACEHOLDER bed. Re-run once billing is sorted:');
    console.warn('!!   node music.mjs        (ElevenLabs Music, after a paid upgrade)');
    console.warn('!!   node music.mjs --fal  (fal CassetteAI, after a balance top-up)');
    await synthPlaceholder();
    await verify(TMP);
    produced = 'synthesized placeholder';
  }

  await rename(TMP, OUT); // atomic — OUT is only ever a fully-verified asset
  console.log(`✓ music.mp3 from ${produced}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
