#!/usr/bin/env node
// video/vo.mjs
// ElevenLabs voiceover WITH character-level timestamps.
// Reads narration from video/script.txt, resolves a voice by name at runtime,
// generates TTS + alignment, writes video/vo.mp3 and video/alignment.json.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error(
    'ERROR: ELEVENLABS_API_KEY is not set. Run: set -a; source ~/.config/global.env; set +a'
  );
  process.exit(1);
}

const SCRIPT_PATH = path.join(__dirname, 'script.txt');
const OUT_MP3 = path.join(__dirname, 'vo.mp3');
const OUT_ALIGNMENT = path.join(__dirname, 'alignment.json');

const PREFERRED_NAMES = ['brian', 'adam', 'rachel'];
const FALLBACK_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const FALLBACK_VOICE_NAME = 'Rachel (hard fallback)';

function resolveVoice(voices) {
  // Pass 1: exact case-insensitive name match, in priority order.
  for (const name of PREFERRED_NAMES) {
    const hit = voices.find(
      (v) => typeof v.name === 'string' && v.name.toLowerCase() === name
    );
    if (hit) return { voiceId: hit.voice_id, voiceName: hit.name, tier: 'exact' };
  }
  // Pass 2: looser substring match, same priority order (handles suffixes like "Brian - Deep").
  for (const name of PREFERRED_NAMES) {
    const hit = voices.find(
      (v) => typeof v.name === 'string' && v.name.toLowerCase().includes(name)
    );
    if (hit) return { voiceId: hit.voice_id, voiceName: hit.name, tier: 'substring' };
  }
  // Hard fallback.
  return { voiceId: FALLBACK_VOICE_ID, voiceName: FALLBACK_VOICE_NAME, tier: 'hard-fallback' };
}

async function main() {
  const narration = (await readFile(SCRIPT_PATH, 'utf8')).trim();
  if (!narration) throw new Error(`No narration text found in ${SCRIPT_PATH}`);
  console.log(`Loaded narration (${narration.length} chars) from ${SCRIPT_PATH}`);

  console.log('Fetching voices from GET /v1/voices ...');
  const voicesRes = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': API_KEY },
  });
  if (!voicesRes.ok) {
    const body = await voicesRes.text();
    throw new Error(
      `GET /v1/voices failed: ${voicesRes.status} ${voicesRes.statusText}\n${body}`
    );
  }
  const voicesJson = await voicesRes.json();
  const voices = voicesJson.voices || [];
  console.log(`Fetched ${voices.length} voices.`);

  const { voiceId, voiceName, tier } = resolveVoice(voices);
  console.log(`Resolved voice: "${voiceName}" (${voiceId}) [match tier: ${tier}]`);

  console.log(`Requesting POST /v1/text-to-speech/${voiceId}/with-timestamps ...`);
  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: narration,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.25,
          use_speaker_boost: true,
        },
        output_format: 'mp3_44100_192',
      }),
    }
  );
  if (!ttsRes.ok) {
    const body = await ttsRes.text();
    throw new Error(
      `POST /v1/text-to-speech/${voiceId}/with-timestamps failed: ${ttsRes.status} ${ttsRes.statusText}\n${body}`
    );
  }
  const ttsJson = await ttsRes.json();
  if (!ttsJson.audio_base64) {
    throw new Error(
      `Response missing audio_base64. Top-level keys: ${Object.keys(ttsJson).join(', ')}`
    );
  }

  const audioBuffer = Buffer.from(ttsJson.audio_base64, 'base64');
  await writeFile(OUT_MP3, audioBuffer);
  console.log(`Wrote ${OUT_MP3} (${audioBuffer.length} bytes)`);

  await writeFile(
    OUT_ALIGNMENT,
    JSON.stringify(
      {
        voiceId,
        voiceName,
        alignment: ttsJson.alignment ?? null,
        normalized_alignment: ttsJson.normalized_alignment ?? null,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${OUT_ALIGNMENT}`);

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      OUT_MP3,
    ]);
    console.log(`ffprobe duration: ${stdout.trim()}s`);
  } catch (e) {
    console.error(`ffprobe failed: ${e.message}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
