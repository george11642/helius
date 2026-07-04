#!/usr/bin/env node
// video/broll.mjs
// Pexels bookend b-roll: downloads the two highest-quality landscape clips
// matching each query into video/broll/<slug>.mp4.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('ERROR: PEXELS_API_KEY is not set. Run: set -a; source ~/.config/global.env; set +a');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'broll');

const TARGETS = [
  { query: 'mountain dusk aerial', slug: 'mountain-dusk.mp4' },
  { query: 'night sky stars timelapse', slug: 'night-sky-stars.mp4' },
];

function pickBestFile(videos) {
  const allFiles = videos.flatMap((v) =>
    (v.video_files || []).map((f) => ({ ...f, _videoId: v.id }))
  );
  let pool = allFiles.filter((f) => f.quality === 'hd' && f.width >= 1920);
  let tier = 'hd && width>=1920';
  if (pool.length === 0) {
    pool = allFiles.filter((f) => f.quality === 'hd');
    tier = 'hd (any width)';
  }
  if (pool.length === 0) {
    pool = allFiles;
    tier = 'any quality (highest width)';
  }
  if (pool.length === 0) return { file: null, tier: 'none available' };
  pool.sort((a, b) => (b.width || 0) - (a.width || 0));
  return { file: pool[0], tier };
}

async function ffprobeInfo(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=width,height',
      '-of', 'json',
      file,
    ]);
    const json = JSON.parse(stdout);
    const stream = (json.streams || [])[0] || {};
    return {
      width: stream.width,
      height: stream.height,
      duration: json.format && json.format.duration,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const results = [];

  for (const { query, slug } of TARGETS) {
    console.log(`\n=== Query: "${query}" ===`);
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(
      query
    )}&orientation=landscape&size=large&per_page=8`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Search failed for "${query}": ${res.status} ${res.statusText}\n${body}`);
      results.push({ query, slug, error: `search ${res.status}` });
      continue;
    }
    const json = await res.json();
    const videos = json.videos || [];
    console.log(`Found ${videos.length} candidate videos (total_results=${json.total_results ?? 'n/a'}).`);

    const { file, tier } = pickBestFile(videos);
    if (!file) {
      console.error(`No usable video_files found for "${query}".`);
      results.push({ query, slug, error: 'no usable video_files' });
      continue;
    }
    console.log(
      `Selected file: width=${file.width} height=${file.height} quality=${file.quality} file_type=${file.file_type} [selection tier: ${tier}]`
    );
    console.log(`Downloading: ${file.link}`);
    const fileRes = await fetch(file.link);
    if (!fileRes.ok) {
      console.error(`Download failed for "${query}": ${fileRes.status} ${fileRes.statusText}`);
      results.push({ query, slug, error: `download ${fileRes.status}` });
      continue;
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const outPath = path.join(OUT_DIR, slug);
    await writeFile(outPath, buf);
    console.log(`Wrote ${outPath} (${buf.length} bytes)`);

    const info = await ffprobeInfo(outPath);
    console.log(`ffprobe: ${JSON.stringify(info)}`);
    results.push({ query, slug, path: outPath, bytes: buf.length, ffprobe: info });
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
