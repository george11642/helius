// Cloudflare Pages Function: /api/brief — the ONLY server code in Helius,
// and it is optional. It powers the online, pre-trip planning pass (NVIDIA
// Nemotron via NIM); the offline product never calls it and never depends on
// it. All real logic lives in src/brief/protocol.ts, shared with the vite
// dev middleware (functions/dev-plugin.ts) and the node unit tests
// (tests/brief.test.ts), so dev, prod, and tests exercise the same handler.
//
// Prod secret (do NOT commit a key):
//   npx wrangler pages secret put NVIDIA_API_KEY --project-name=helius
// Without the secret the endpoint answers 501 {reason:'not_configured'} and
// the client hides the feature.

import { handleBriefRequest } from '../../src/brief/protocol';
import type { BriefEnv } from '../../src/brief/protocol';

interface PagesContext {
  request: Request;
  env: BriefEnv;
}

export const onRequestGet = (ctx: PagesContext): Promise<Response> => handleBriefRequest(ctx.request, ctx.env);
export const onRequestPost = (ctx: PagesContext): Promise<Response> => handleBriefRequest(ctx.request, ctx.env);
