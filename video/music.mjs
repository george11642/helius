#!/usr/bin/env node
// video/music.mjs — 60s cinematic-tech music bed.
// Source chain (first that succeeds wins): fal CassetteAI (primary, ~$0.02) →
// ElevenLabs Music → a locally-synthesized placeholder bed (ffmpeg, always
// works). The two AI sources both need paid credits; the placeholder keeps the
// video pipeline unblocked when they 402/403, and logs LOUDLY that it's a
// stand-in to replace once billing is topped up.
//
//   set -a; source ~/.config/global.env; set +a
//   node music.mjs

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'music.mp3');
const PROMPT = 'minimal cinematic tech pulse, warm analog synth, steady build, no drums first 8s, 60 seconds';

function findAudioUrl(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (obj.audio_file?.url) return obj.audio_file.url;
  if (obj.audio?.url) return obj.audio.url;
  if (typeof obj.audio_url === 'string') return obj.audio_url;
  if (typeof obj.url === 'string' && /\.(mp3|wav|m4a|aac)(\?|$)/i.test(obj.url)) return obj.url;
  for (const k of Object.keys(obj)) {
    const f = findAudioUrl(obj[k], depth + 1);
    if (f) return f;
  }
  return null;
}
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
  await writeFile(OUT, Buffer.from(await r.arrayBuffer()));
}

// --- 1. fal CassetteAI (sync or async queue) ---
async function tryFal() {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error('FAL_KEY unset');
  const res = await fetch('https://fal.run/cassetteai/music-generator', {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, duration: 60 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`fal ${res.status}: ${text.slice(0, 200)}`);
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

// --- 2. ElevenLabs Music (returns audio/mpeg on success) ---
async function tryElevenMusic() {
  const KEY = process.env.ELEVENLABS_API_KEY;
  if (!KEY) throw new Error('ELEVENLABS_API_KEY unset');
  const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, music_length_ms: 60000 }),
  });
  if (!res.ok) throw new Error(`eleven-music ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    const url = findAudioUrl(await res.json());
    if (!url) throw new Error('eleven-music: no audio url in json');
    await download(url);
  } else {
    await writeFile(OUT, Buffer.from(await res.arrayBuffer()));
  }
}

// --- 3. synthesized placeholder (ffmpeg, always available) ---
async function synthPlaceholder() {
  // Warm A-minor drone (root/fifth/octave) + slow tremolo, 8s build, 4s fade-out.
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=110:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=164.81:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60',
    '-filter_complex',
    '[0][1][2]amix=inputs=3:normalize=0,volume=0.33,tremolo=f=0.15:d=0.4,lowpass=f=900,afade=t=in:st=0:d=8,afade=t=out:st=56:d=4',
    '-ar', '44100', OUT,
  ]);
}

async function main() {
  const sources = [
    ['fal CassetteAI', tryFal],
    ['ElevenLabs Music', tryElevenMusic],
  ];
  for (const [name, fn] of sources) {
    try {
      console.log(`trying ${name}…`);
      await fn();
      console.log(`✓ music from ${name}`);
      break;
    } catch (err) {
      console.warn(`  ${name} unavailable: ${err.message}`);
    }
  }
  const { existsSync } = await import('node:fs');
  if (!existsSync(OUT)) {
    console.warn('!! Both AI music sources are billing-blocked — writing a SYNTHESIZED PLACEHOLDER bed.');
    console.warn('!! Replace it: top up fal.ai credits, then re-run `node music.mjs`.');
    await synthPlaceholder();
    console.log('✓ placeholder music written');
  }
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', OUT]);
  console.log(`wrote ${OUT} — ${stdout.trim()}s`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
