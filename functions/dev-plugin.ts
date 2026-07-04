// Vite plugin: serves /api/brief in `vite dev` and `vite preview` with the
// SAME handler the Cloudflare Pages Function uses (src/brief/protocol.ts),
// so the online-planning feature is fully testable locally without wrangler.
// The key comes from the shell env: `set -a && source ~/.config/global.env
// && set +a && pnpm dev` — or run key-less and use ?brief=mock.

import type { Connect, Plugin } from 'vite';
import { handleBriefRequest } from '../src/brief/protocol';

// process.env without depending on @types/node (tsconfig's `types` list is
// browser-only; this file is typechecked because vite.config.ts imports it).
const shellEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

function middleware(): Connect.NextHandleFunction {
  return (req, res) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req as AsyncIterable<Uint8Array>) chunks.push(chunk);
      const bodyText = new TextDecoder().decode(concat(chunks));
      const request = new Request('http://localhost/api/brief', {
        method: req.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        body: req.method === 'POST' ? bodyText : undefined,
      });
      const response = await handleBriefRequest(request, { NVIDIA_API_KEY: shellEnv().NVIDIA_API_KEY });
      res.statusCode = response.status;
      res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
      res.end(await response.text());
    })().catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ reason: 'dev_middleware_failed', detail: String(err).slice(0, 200) }));
    });
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function briefDevApi(): Plugin {
  return {
    name: 'helius-brief-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/brief', middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/brief', middleware());
    },
  };
}
