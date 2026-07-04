// Resolved root for region-pack assets (basemap.pmtiles, terrain.pmtiles,
// graph.bin, pois.json, manifest.json). Dev reads them locally (Vite serves
// public/data/packs/<pack>/...); production streams them from R2 — the same
// architecture already used for model weights (see MODEL_BASE_URL in
// main.ts). VITE_PACK_BASE_URL overrides both for one-off testing.
//
// Why this exists: Cloudflare Pages caps individual uploaded files at 25MiB.
// sandia's basemap.pmtiles (~29MB) and terrain.pmtiles (~80MB) both exceed
// that, so pmtiles specifically MUST be served from R2 in production
// regardless of pack size (chamonix/fontainebleau are smaller today, but the
// same rule applies to any future pack). graph.bin/pois.json/manifest.json
// are small enough to ship in the Pages build too, but are routed through
// here as well for one consistent source of truth — see also
// public/.assetsignore, which excludes the *.pmtiles specifically from the
// actual Pages upload (they still exist in dist/ for dev/preview parity;
// only the deploy step skips them).
//
// A single shared module (not duplicated per-file) so render.ts, graph.ts,
// and warm.ts can never drift out of sync on where a pack's assets live.
export const PACK_BASE_URL: string =
  import.meta.env.VITE_PACK_BASE_URL ??
  (import.meta.env.DEV ? '/data/packs' : 'https://pub-186c78c24ee54dda820fe564c0ac4608.r2.dev/packs');
