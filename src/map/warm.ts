// "Pack warm-up": forces one full, Range-header-free GET of each region
// pack asset so the service worker's CacheFirst handler stores a complete
// 200 response. pmtiles.PMTiles never issues a request like this on its
// own — every read it does (even the very first, for the archive header)
// is a byte-range request — so without this step the SW cache would only
// ever hold partial 206 entries. The `rangeRequests: true` workbox option
// on the `map-data` runtime-caching rule (vite.config.ts) then slices this
// cached full body to answer those Range reads once offline.
//
// Invoke manually from the console for now — `import('/src/map/warm.ts').
// then(m => m.warmPack('sandia'))` — until the UI wires a button to it.

const PACK_ASSETS = ['basemap.pmtiles', 'terrain.pmtiles', 'graph.bin', 'pois.json'] as const;

export interface WarmPackResult {
  url: string;
  ok: boolean;
  bytes?: number;
  error?: string;
}

export async function warmPack(pack: string): Promise<WarmPackResult[]> {
  const base = `/data/packs/${pack}`;
  const results: WarmPackResult[] = [];

  for (const asset of PACK_ASSETS) {
    const url = `${base}/${asset}`;
    try {
      // No Range header (a plain fetch never sends one on its own) — this
      // is exactly what makes the response a full, cacheable 200 instead
      // of the 206s every pmtiles.Protocol read otherwise produces.
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer(); // drain fully so the SW's cache.put() sees a complete body
      results.push({ url, ok: true, bytes: buf.byteLength });
    } catch (err) {
      results.push({ url, ok: false, error: String(err) });
    }
  }

  return results;
}

// ---------- offline readiness check (no network — Cache Storage lookups only) ----------

export interface OfflineReadyResult {
  ok: boolean;
  /** Every check that came back missing, including best-effort ones that don't affect `ok`. */
  missing: string[];
}

// Representative, not exhaustive: the basic-Latin glyph range and the one
// sprite flavor this app actually ships (see src/map/style.ts) are enough to
// know glyph/sprite serving works offline without walking every range file.
const GLYPH_CHECK_URL = `/vendor/fonts/${encodeURIComponent('Noto Sans Regular')}/0-255.pbf`;
const SPRITE_JSON_URL = '/vendor/sprites/v4/dark.json';
const SPRITE_PNG_URL = '/vendor/sprites/v4/dark.png';

/** True if `url` is servable from any Cache Storage bucket right now — never touches the network. */
async function isCached(url: string): Promise<boolean> {
  const match = await caches.match(new URL(url, location.origin).toString());
  return !!match && match.ok;
}

async function cacheHasEntries(cacheName: string): Promise<boolean> {
  if (!(await caches.has(cacheName))) return false;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  return keys.length > 0;
}

/**
 * Gates the UI's "OFFLINE-READY" badge. Hard requirements (map/nav/routing
 * assets) drive `ok`; the LLM/TTS model caches are reported in `missing` but
 * marked best-effort and excluded from `ok` — a fresh install can be fully
 * offline-capable for navigation before a voice turn has ever run once to
 * populate transformers-cache/kokoro-voices. Pure Cache Storage reads, no
 * fetch() calls — stays well under the ~200ms budget.
 */
export async function checkOfflineReady(pack: string): Promise<OfflineReadyResult> {
  const base = `/data/packs/${pack}`;

  const hardChecks: Array<[string, Promise<boolean>]> = [
    [
      'service-worker-active',
      (async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg?.active;
      })(),
    ],
    ['basemap.pmtiles', isCached(`${base}/basemap.pmtiles`)],
    ['terrain.pmtiles', isCached(`${base}/terrain.pmtiles`)],
    ['graph.bin', isCached(`${base}/graph.bin`)],
    ['pois.json', isCached(`${base}/pois.json`)],
    ['glyphs', isCached(GLYPH_CHECK_URL)],
    ['sprite.json', isCached(SPRITE_JSON_URL)],
    ['sprite.png', isCached(SPRITE_PNG_URL)],
  ];

  const bestEffortChecks: Array<[string, Promise<boolean>]> = [
    ['transformers-cache (best-effort)', cacheHasEntries('transformers-cache')],
    ['kokoro-voices (best-effort)', cacheHasEntries('kokoro-voices')],
  ];

  const [hardResults, bestEffortResults] = await Promise.all([
    Promise.all(hardChecks.map(async ([name, p]) => [name, await p.catch(() => false)] as const)),
    Promise.all(bestEffortChecks.map(async ([name, p]) => [name, await p.catch(() => false)] as const)),
  ]);

  const missing = [...hardResults, ...bestEffortResults].filter(([, present]) => !present).map(([name]) => name);
  const ok = hardResults.every(([, present]) => present);

  return { ok, missing };
}
