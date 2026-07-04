// Spike static server: serves spike/ at / and the local model mirror at /models/.
// Range requests + COOP/COEP so the page is crossOriginIsolated (wasm threads),
// permissive CORP/CORS so cross-origin CDN deps still load under COEP.
import { createServer } from 'node:http';
import { stat, open } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const PORT = Number(process.env.PORT || 8737);
// Optional bandwidth cap (megabytes/second) for testing the app's resumable
// model downloads against a realistically slow "network" on loopback, e.g.:
//   THROTTLE_MBPS=8 node spike/serve.mjs
const THROTTLE_MBPS = Number(process.env.THROTTLE_MBPS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pipeThrottled(stream, res) {
  const bytesPerTick = THROTTLE_MBPS * 1e6 * 0.05; // 50ms ticks
  let sent = 0;
  try {
    for await (const chunk of stream) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      sent += chunk.length;
      if (sent >= bytesPerTick) { sent = 0; await sleep(50); }
    }
    res.end();
  } catch { /* client went away mid-stream — normal for aborted downloads */ }
}
const SPIKE_DIR = new URL('.', import.meta.url).pathname;
const MODELS_DIR = process.env.MODELS_DIR || `${process.env.HOME}/dev/helius-assets/models`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jinja': 'text/plain; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.onnx_data': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

createServer(async (req, res) => {
  try {
    // CORS preflight: the app's resumable model downloader sends Range +
    // If-Range headers cross-origin (5173 → 8737), which triggers an OPTIONS
    // preflight. Mirror what prod R2 answers (verified live: 204 + ACAO * +
    // Allow-Headers: range, if-range).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD',
        'Access-Control-Allow-Headers': 'range, if-range',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    let filePath;
    if (pathname.startsWith('/models/')) {
      filePath = join(MODELS_DIR, normalize(pathname.slice('/models/'.length)));
      if (!filePath.startsWith(MODELS_DIR)) { res.writeHead(403); return res.end(); }
    } else {
      if (pathname === '/') pathname = '/index.html';
      filePath = join(SPIKE_DIR, normalize(pathname));
      if (!filePath.startsWith(SPIKE_DIR)) { res.writeHead(403); return res.end(); }
    }

    let st;
    try { st = await stat(filePath); } catch { res.writeHead(404); return res.end('not found: ' + pathname); }
    if (st.isDirectory()) { res.writeHead(404); return res.end(); }

    // .onnx_data has no extname match via extname() (it returns '.onnx_data'? no: '.onnx_data' → extname is '.onnx_data'? extname('/a/x.onnx_data') === '.onnx_data')
    const ext = filePath.endsWith('.onnx_data') || /\.onnx_data_\d+$/.test(filePath) ? '.onnx_data' : extname(filePath);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'content-range, etag, last-modified, accept-ranges',
      'Cache-Control': 'no-transform',
      // Weak validator (mtime-size) so the resumable downloader can safely
      // resume partial files across server restarts, like prod R2's ETag.
      'ETag': `"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    };

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (m[1] === '' && m[2]) { start = st.size - Number(m[2]); end = st.size - 1; }
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      const fh = await open(filePath, 'r');
      const stream = fh.createReadStream({ start, end });
      if (THROTTLE_MBPS > 0) { void pipeThrottled(stream, res).finally(() => fh.close()); }
      else { stream.pipe(res); stream.on('close', () => fh.close()); }
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      const fh = await open(filePath, 'r');
      const stream = fh.createReadStream();
      if (THROTTLE_MBPS > 0) { void pipeThrottled(stream, res).finally(() => fh.close()); }
      else { stream.pipe(res); stream.on('close', () => fh.close()); }
    }
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
}).listen(PORT, () => console.log(`spike server on http://localhost:${PORT}  models=${MODELS_DIR}`));
