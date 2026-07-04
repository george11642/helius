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
