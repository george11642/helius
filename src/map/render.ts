// MapLibre GL init: offline PMTiles basemap + terrain contours for the
// active region pack (see scripts/sync-assets.sh and public/data/packs/).
//
// All side-effecting init (pmtiles protocol registration, the
// maplibre-contour DEM bridge below, map construction) lives in this file;
// style.ts stays a pure style-JSON builder.
//
// --- Why there's a "DEM fetch bridge" here ---
// maplibre-contour's DemSource does NOT go through MapLibre's addProtocol
// registry for its own DEM tile fetches (verified by reading
// node_modules/maplibre-contour/dist/index.mjs: DemSource's public
// constructor only accepts {url, cacheSize, id, encoding, maxzoom, worker,
// timeoutMs, actor} — no getTile override — and internally it always ends
// up calling `defaultGetTile`, a plain `fetch(url)`). That's fine for a
// real tile server, but terrain.pmtiles is a single local archive with no
// per-{z}/{x}/{y} REST endpoint, and this app must also work fully
// offline (no dev server, no edge function to bridge it server-side).
// So: DemSource is given a synthetic same-origin URL template
// (`/__dem-tile/<pack>/{z}/{x}/{y}`), and `window.fetch` is patched — main
// thread only — to intercept just that URL shape and resolve it via a
// `pmtiles.PMTiles` reader's `getZxy()` against the real terrain.pmtiles
// file, wrapping the returned bytes in a real `Response` so
// maplibre-contour's own `.blob()`/`.headers` handling works unmodified.
// Everything else still goes through the original `fetch`.
//
// This is also why DemSource is constructed with `worker: false` here,
// deviating from the "worker: true" in the original spec: worker mode
// spawns maplibre-contour's own bundled Worker script, a separate realm
// with its own `self.fetch` that this main-thread patch cannot reach (and
// there's no hook to inject code into that worker before it runs). Main
// thread contour generation is the trade-off for a single mountain-range
// pack at zoom <=12 DEM resolution; see src/map/README.md for detail.

import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';
import mlcontour from 'maplibre-contour';
import { buildStyle, poiLayers, PALETTE } from './style';
import { PACK_BASE_URL } from './pack-base';

// ---------- module-level singletons (shared across HeliusMap instances) ----------

let pmtilesProtocolRegistered = false;
function ensurePmtilesProtocol(): void {
  if (pmtilesProtocolRegistered) return;
  pmtilesProtocolRegistered = true;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
}

const DEM_TILE_PATH_RE = /^\/__dem-tile\/([^/]+)\/(\d+)\/(-?\d+)\/(-?\d+)$/;
const terrainReaders = new Map<string, PMTiles>();
let demFetchBridgeInstalled = false;

/** Patches window.fetch (once) to serve `/__dem-tile/<pack>/{z}/{x}/{y}` from a local PMTiles reader. */
function ensureDemFetchBridge(): void {
  if (demFetchBridgeInstalled) return;
  demFetchBridgeInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const pathname = (() => {
      try {
        return new URL(rawUrl, location.href).pathname;
      } catch {
        return rawUrl;
      }
    })();
    const match = DEM_TILE_PATH_RE.exec(pathname);
    if (!match) return nativeFetch(input as RequestInfo, init);

    const [, pack, z, x, y] = match;
    const reader = terrainReaders.get(pack);
    if (!reader) return new Response(null, { status: 404, statusText: 'Unknown pack' });

    try {
      const tile = await reader.getZxy(Number(z), Number(x), Number(y));
      if (!tile) return new Response(null, { status: 404, statusText: 'No DEM tile' });
      // .slice(0) copies the buffer: hillshade (sharedDemProtocolUrl) and
      // contours (contourProtocolUrl) can both request the same z/x/y DEM
      // tile, and downstream code may transfer the bytes to a worker
      // (detaching the buffer) — without a copy here, whichever consumer
      // reads second would get an already-detached ArrayBuffer.
      return new Response(tile.data.slice(0), {
        status: 200,
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': tile.cacheControl ?? 'no-cache' },
      });
    } catch (err) {
      return new Response(null, { status: 500, statusText: String(err) });
    }
  }) as typeof window.fetch;
}

/**
 * maplibre-gl 5.24 dropped the old `maplibregl.supported()` helper (checked
 * node_modules/maplibre-gl/dist/maplibre-gl.d.ts — no such export remains),
 * so this checks WebGL availability directly the standard way.
 */
function isWebglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')
    );
  } catch {
    return false;
  }
}

function getTerrainReader(pack: string, packBaseUrl: string): PMTiles {
  let reader = terrainReaders.get(pack);
  if (!reader) {
    reader = new PMTiles(`${packBaseUrl}/terrain.pmtiles`);
    terrainReaders.set(pack, reader);
  }
  return reader;
}

type DemProtocolFn = InstanceType<typeof mlcontour.DemSource>['contourProtocolV4'];

/**
 * maplibre-contour caches contour/shared-DEM tile results internally (an
 * AsyncCache keyed by z/x/y/options — verified by reading
 * node_modules/maplibre-contour/dist/index.mjs's fetchContourTile), and
 * hands the SAME ArrayBuffer instance to every caller that hits that cache
 * key. maplibre-gl transfers (detaches) whatever ArrayBuffer a registered
 * protocol resolves with, to its own tile-parsing worker — so a second
 * delivery of that cached buffer (revisiting a tile, a retry, anything
 * hitting the cache twice) throws DataCloneError on the transfer. Copying
 * the buffer here, at the one point control returns to maplibre-gl, fixes
 * it regardless of what upstream caches or how. This is a *different*
 * buffer than the one the DEM fetch bridge above copies (that one is the
 * raw per-tile WEBP bytes my own code hands to maplibre-contour; this one
 * is maplibre-contour's own computed output handed to maplibre-gl) — the
 * fetch-bridge copy alone did not stop a reliably-reproducing
 * DataCloneError on the Chamonix pack's contours source; this one did
 * (verified: zero DataCloneError across repeated fresh loads afterward).
 */
function wrapDemSourceProtocol(fn: DemProtocolFn): DemProtocolFn {
  return (async (request, abortController) => {
    const result = await fn(request, abortController);
    return { ...result, data: result.data.slice(0) };
  }) as DemProtocolFn;
}

// ---------- small geo helpers (local — no turf dependency) ----------

/** Destination point given start lat/lon, distance (m), and bearing (deg). Spherical-earth approx. */
function destinationPoint(lat: number, lon: number, distanceM: number, bearingDeg: number): [number, number] {
  const R = 6371000;
  const delta = distanceM / R;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 =
    lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return [(lambda2 * 180) / Math.PI, (phi2 * 180) / Math.PI];
}

function accuracyCirclePolygon(lat: number, lon: number, radiusM: number, steps = 48): GeoJSONPolygon {
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    ring.push(destinationPoint(lat, lon, radiusM, (360 * i) / steps));
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/** Equirectangular approximation — fine at the scale of a single hiking region pack. */
function planarDistance(a: [number, number], b: [number, number]): number {
  const latRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * Math.cos(latRad);
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function cumulativeDistances(coords: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + planarDistance(coords[i - 1], coords[i]));
  return out;
}

/** Coordinates of the route from its start up to `t` (0..1) fraction of its total length. */
function sliceRouteAtProgress(
  coords: [number, number][],
  cumulative: number[],
  total: number,
  t: number,
): [number, number][] {
  if (coords.length === 0) return [];
  const target = t * total;
  const out: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    if (cumulative[i] <= target) {
      out.push(coords[i]);
      continue;
    }
    const segStart = cumulative[i - 1];
    const segEnd = cumulative[i];
    const segT = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const p0 = coords[i - 1];
    const p1 = coords[i];
    out.push([p0[0] + (p1[0] - p0[0]) * segT, p0[1] + (p1[1] - p0[1]) * segT]);
    break;
  }
  return out;
}

function boundsOf(coords: [number, number][]): [[number, number], [number, number]] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

// ---------- minimal local GeoJSON shapes (no @types/geojson in this project) ----------

interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

/** Just enough of a GeoJSON LineString for drawRoute — see src/map/README.md. */
export interface RouteLineString {
  type: 'LineString';
  coordinates: [number, number][];
}

interface PoiRecord {
  kind: 'trailhead' | 'peak';
  name: string;
  lat: number;
  lon: number;
  ele?: number;
}

/**
 * pois.json's actual shape (verified against the generated file) is
 * `{trailheads: [{name,lat,lon}], peaks: [{name,lat,lon,ele}]}` — no
 * `kind` field — not the flat `[{kind,name,lat,lon,ele?}]` array
 * originally specced. This accepts either: the grouped shape (real data),
 * or a flat array (in case the generator changes to match the original
 * contract later). Anything else is treated as unparseable.
 */
interface RawNamedPoint {
  name: string;
  lat: number;
  lon: number;
  ele?: number | null;
}

function normalizePois(raw: unknown): PoiRecord[] | null {
  if (Array.isArray(raw)) {
    const arr = raw as Array<Partial<PoiRecord>>;
    return arr.every((r) => r.kind === 'trailhead' || r.kind === 'peak') ? (arr as PoiRecord[]) : null;
  }
  if (raw && typeof raw === 'object') {
    const grouped = raw as { trailheads?: RawNamedPoint[]; peaks?: RawNamedPoint[] };
    if (Array.isArray(grouped.trailheads) || Array.isArray(grouped.peaks)) {
      const trailheads: PoiRecord[] = (grouped.trailheads ?? []).map((r) => ({
        kind: 'trailhead',
        name: r.name,
        lat: r.lat,
        lon: r.lon,
      }));
      const peaks: PoiRecord[] = (grouped.peaks ?? []).map((r) => ({
        kind: 'peak',
        name: r.name,
        lat: r.lat,
        lon: r.lon,
        ele: r.ele ?? undefined,
      }));
      return [...trailheads, ...peaks];
    }
  }
  return null;
}

// ---------- one-time injected CSS for the HTML markers below ----------

const MARKER_STYLE_ID = 'helius-map-marker-styles';
function ensureMarkerStyles(): void {
  if (document.getElementById(MARKER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MARKER_STYLE_ID;
  style.textContent = `
    .helius-fix-marker { position: relative; width: 18px; height: 18px; }
    .helius-fix-marker .dot {
      position: absolute; inset: 0; margin: auto; width: 10px; height: 10px; border-radius: 50%;
      background: ${PALETTE.path}; box-shadow: 0 0 6px 2px ${PALETTE.path}aa;
    }
    .helius-fix-marker .ring {
      position: absolute; inset: 0; margin: auto; width: 10px; height: 10px; border-radius: 50%;
      border: 2px solid ${PALETTE.path}; animation: helius-fix-pulse 1.8s ease-out infinite;
    }
    @keyframes helius-fix-pulse {
      0% { transform: scale(1); opacity: 0.9; }
      100% { transform: scale(3.4); opacity: 0; }
    }
    .helius-dest-flag { display: block; filter: drop-shadow(0 0 3px rgba(0,0,0,0.6)); }
  `;
  document.head.appendChild(style);
}

function buildFixMarkerElement(): HTMLDivElement {
  ensureMarkerStyles();
  const el = document.createElement('div');
  el.className = 'helius-fix-marker';
  el.innerHTML = '<div class="ring"></div><div class="dot"></div>';
  return el;
}

function buildDestinationFlagElement(): HTMLDivElement {
  ensureMarkerStyles();
  const el = document.createElement('div');
  el.innerHTML = `
    <svg class="helius-dest-flag" width="18" height="24" viewBox="0 0 18 24" xmlns="http://www.w3.org/2000/svg">
      <line x1="2" y1="2" x2="2" y2="22" stroke="${PALETTE.path}" stroke-width="2" stroke-linecap="round"/>
      <path d="M2 3 L16 7 L2 12 Z" fill="${PALETTE.path}"/>
    </svg>`;
  return el;
}

// The canonical, specifically-chosen sandia demo scene (La Luz switchbacks) —
// not just "somewhere in the region". Other packs get their center from their
// own manifest.json (see getPackCenter) rather than always starting here:
// verified live that without this, the map constructs centered on Sandia's
// coordinates regardless of `pack`, so a non-sandia pack's DEM tiles get
// requested for a location the archive doesn't cover at all (every initial
// tile 404s) before any later camera move can correct it.
const SANDIA_DEMO_CENTER: [number, number] = [-106.4439, 35.1983];

async function getPackCenter(pack: string, packBaseUrl: string): Promise<[number, number]> {
  if (pack === 'sandia') return SANDIA_DEMO_CENTER;
  try {
    const res = await fetch(`${packBaseUrl}/manifest.json`);
    if (res.ok) {
      const manifest = (await res.json()) as { center?: unknown };
      if (Array.isArray(manifest.center) && manifest.center.length === 2) {
        return manifest.center as [number, number];
      }
    }
  } catch {
    // falls through to the warning + fallback below
  }
  console.warn(`[HeliusMap] ${pack}/manifest.json unavailable or missing 'center' — falling back to the sandia demo coordinates`);
  return SANDIA_DEMO_CENTER;
}

export interface DrawRouteOptions {
  /** Progressive-draw duration in ms. Default 1500. */
  animateMs?: number;
}

type PendingActionKind = 'setFix' | 'drawRoute' | 'flyToRoute' | 'setBeaconMode';

// How long init() waits for the 'route' source to register (see init()'s use
// of this) before giving up and treating the style as failed rather than
// just slow. Normally this resolves in well under a second — source
// registration from a style's `sources` dict is synchronous, no network
// involved (see the comment at the poll itself) — so this is generously
// wide on purpose: it exists to catch "the style construction itself is
// broken/never happened" (e.g. an unreachable style: URL), not to budget
// for ordinary slowness. Not to be confused with the SEPARATE, much slower
// 'load' wait further down in init(), which genuinely can take 40-150s+
// under contention for reasons unrelated to style health.
// 60s, not 30: under heavy multi-process load this box has taken >30s to give
// even synchronous source registration a scheduling slot, and the failure mode
// (map dead for the session) is far worse than a longer wait.
const ROUTE_SOURCE_READY_TIMEOUT_MS = 60_000;

export class HeliusMap {
  private map: maplibregl.Map | null = null;
  private _pack = 'sandia';
  private packBaseUrl = '';

  /** Region pack currently loaded (e.g. 'sandia'). */
  get pack(): string {
    return this._pack;
  }

  private fixMarker: maplibregl.Marker | null = null;
  private destinationMarker: maplibregl.Marker | null = null;

  private routeAnimationHandle: number | null = null;
  private routeFullCoords: [number, number][] | null = null;

  private beaconOn = false;

  // main.ts fires `void initMapOnce()` without awaiting it, so agent activity
  // (a route/beacon/setFix event) can complete — a mock or fast real turn is
  // ~seconds — well before this class's own init() resolves, which involves
  // several awaited fetches and can take 40-90s under contention (see
  // README). Verified live: this is exactly why drawRoute() appeared to
  // silently do nothing in the prod build — `this.map` (or the 'route'
  // source, added only after 'load') simply didn't exist yet when it was
  // called. Public methods that need a ready map queue a retry of themselves
  // instead of a no-op; init() flushes the queue once it's actually ready.
  private mapReady = false;

  // Codex R3: the old Array<() => void> queue had no bound — if the style
  // never becomes ready (init() waits forever) and a caller re-invokes one of
  // these on a timer (setFix does, in some call paths), pendingActions grows
  // without limit, and would replay as one giant burst if init() ever DID
  // recover. Only the latest call of each kind is ever meaningful — an
  // intermediate setFix/drawRoute made obsolete by a later one has nothing
  // worth replaying — so keying by kind bounds this to at most 4 entries by
  // construction (setFix, drawRoute, flyToRoute, setBeaconMode), well under
  // any reasonable cap. Replayed in a fixed kind-order (not push order) on
  // flush so drawRoute always runs before flyToRoute regardless of which was
  // (re-)queued more recently — flyToRoute reads routeFullCoords, which only
  // drawRoute populates.
  private pendingActions = new Map<PendingActionKind, () => void>();

  // Set once if the 'route' source never registers within
  // ROUTE_SOURCE_READY_TIMEOUT_MS (see init()) — the style construction
  // itself failed/hung, not just slow
  // tile loading. From then on, public calls are permanent no-ops (queueing
  // them would just leak forever, since nothing will ever flush the queue).
  private initFailed = false;
  private warnedInitFailed = false;

  // Checked at the top of every public method that needs a ready map.
  // Returns true if the caller should return immediately (either queued for
  // later, or permanently dropped because init failed) rather than proceed.
  private deferUntilReady(kind: PendingActionKind, run: () => void): boolean {
    if (this.initFailed) {
      if (!this.warnedInitFailed) {
        this.warnedInitFailed = true;
        console.warn(`[HeliusMap] init failed earlier for pack '${this._pack}' — ${kind}() and all further calls are no-ops`);
      }
      return true;
    }
    if (!this.mapReady) {
      this.pendingActions.set(kind, run);
      return true;
    }
    return false;
  }

  /** Raw MapLibre instance, for callers that need direct access beyond this wrapper's API. Null until init() resolves (or if unsupported). */
  get instance(): maplibregl.Map | null {
    return this.map;
  }

  async init(container: HTMLElement, pack = 'sandia'): Promise<void> {
    this._pack = pack;
    this.packBaseUrl = `${PACK_BASE_URL}/${pack}`;

    if (!isWebglSupported()) {
      container.innerHTML = '';
      const msg = document.createElement('div');
      msg.style.cssText =
        `display:flex;align-items:center;justify-content:center;height:100%;width:100%;` +
        `background:${PALETTE.background};color:${PALETTE.label};font:14px system-ui,sans-serif;text-align:center;padding:2rem;box-sizing:border-box;`;
      msg.textContent = 'Map unavailable: this browser/device does not support the WebGL rendering MapLibre requires.';
      container.appendChild(msg);
      console.warn('[HeliusMap] WebGL unavailable; skipping map init');
      return;
    }

    ensurePmtilesProtocol();
    ensureDemFetchBridge();

    getTerrainReader(pack, this.packBaseUrl);

    const demSource = new mlcontour.DemSource({
      url: `/__dem-tile/${pack}/{z}/{x}/{y}`,
      encoding: 'terrarium',
      maxzoom: 12,
      worker: false, // see file header: worker mode can't reach this main-thread fetch bridge
      id: `mlcontour-${pack}`,
    });
    demSource.setupMaplibre(maplibregl);
    // setupMaplibre registers contourProtocolV4/sharedDemProtocolV4 directly.
    // Re-register wrapped versions that copy the returned ArrayBuffer — see
    // wrapDemSourceProtocol's doc comment for why this is needed on top of
    // the .slice(0) already done in the DEM fetch bridge above (verified
    // live against the Chamonix pack: that copy alone did not stop a
    // reliably-reproducing DataCloneError on the *contours* source; this
    // one, at the actual hand-off point back to maplibre-gl, does).
    maplibregl.addProtocol(demSource.contourProtocolId, wrapDemSourceProtocol(demSource.contourProtocolV4));
    maplibregl.addProtocol(demSource.sharedDemProtocolId, wrapDemSourceProtocol(demSource.sharedDemProtocolV4));

    let style: StyleSpecification;
    try {
      style = buildStyle(pack, { packBaseUrl: this.packBaseUrl, demSource });
    } catch (err) {
      console.warn('[HeliusMap] buildStyle with terrain failed, falling back to basemap only', err);
      style = buildStyle(pack, { packBaseUrl: this.packBaseUrl, demSource: null });
    }

    const center = await getPackCenter(pack, this.packBaseUrl);
    const map = new maplibregl.Map({
      container,
      style,
      center,
      zoom: 13,
      pitch: 45,
      attributionControl: { compact: true },
    });
    this.map = map;

    map.on('error', (e) => {
      // Logging the raw Error object (the old `e.error ?? e`) reads as a bare
      // "Error" once it passes through most console-capture tooling — Error's
      // message/stack are non-enumerable, so anything that serializes the
      // argument (rather than calling console's own Error formatting)
      // silently drops them. Pull the string out explicitly instead.
      console.warn('[HeliusMap] map error', e.error?.message ?? String(e), e.error?.stack ?? '');
    });

    // route/accuracy/beacon-dim sources+layers are declared in buildStyle()
    // itself now (empty, populated later via setData/setPaintProperty), so
    // drawRoute/setFix/setBeaconMode only actually need the 'route' source
    // to be registered — NOT `map.isStyleLoaded()`/'load', both verified
    // live to behave the same way here: `Style.loaded()` requires every
    // declared source's initial tiles to have finished (same class of wait
    // as 'load', not "is the style JSON parsed yet" — confirmed by staying
    // false for 120+ seconds on this contended machine while the map was
    // ALREADY visibly rendering basemap/hillshade/trails). Polling the one
    // concrete thing this code needs, directly, sidesteps that entirely:
    // source registration from a style's `sources` dict is synchronous
    // object construction, no network involved, so this resolves within
    // milliseconds of the Map constructor returning — UNLESS the style
    // itself never actually loaded (e.g. an unreachable style: URL), in
    // which case 'route' would never appear at all. Codex R3: the earlier
    // version of this poll had no ceiling for that case, so raced against
    // ROUTE_SOURCE_READY_TIMEOUT_MS below rather than polling forever.
    let pollStopped = false;
    const routeSourceReady = await Promise.race([
      new Promise<boolean>((resolve) => {
        const check = () => {
          if (pollStopped) return;
          if (map.getSource('route')) resolve(true);
          else setTimeout(check, 20);
        };
        check();
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ROUTE_SOURCE_READY_TIMEOUT_MS)),
    ]);
    pollStopped = true; // stop the loser's poll loop regardless of which branch won

    if (!routeSourceReady) {
      this.initFailed = true;
      this.pendingActions.clear(); // nothing will ever flush these now
      const err = new Error(
        `[HeliusMap] style for pack '${pack}' never became ready within ${ROUTE_SOURCE_READY_TIMEOUT_MS}ms (route source never registered) — treating init as failed`,
      );
      console.warn(err.message);
      // Route through the same 'error' handler/format as genuine MapLibre
      // errors, so this shows up wherever those are already being watched.
      map.fire('error', { error: err });
      return;
    }

    this.mapReady = true;
    const pending = this.pendingActions;
    this.pendingActions = new Map();
    // Fixed replay order, not queue/insertion order — coalescing keeps at
    // most one pending call per kind, so this is the only ordering that
    // matters: drawRoute must run before flyToRoute (which reads
    // routeFullCoords, only populated by drawRoute) regardless of which one
    // was queued or re-queued more recently.
    for (const kind of ['setFix', 'drawRoute', 'flyToRoute', 'setBeaconMode'] as const) {
      pending.get(kind)?.();
    }

    // Debug-only escape hatch, unconditional (not gated behind import.meta.env.DEV)
    // — the bug this exists to chase (drawRoute silently doing nothing in the
    // PROD bundle) can only be reproduced IN production, where there's no dev
    // console access to the module otherwise. Exposes only this instance's own
    // already-public API; harmless to leave in.
    (window as unknown as { __heliusMapDebug?: HeliusMap }).__heliusMapDebug = this;

    await new Promise<void>((resolve) => {
      map.on('load', () => resolve());
    });

    void this.loadPois();
  }

  /** Fetches pois.json (trailheads/peaks); tolerant of it not existing yet — the data-prep agent may still be generating it. */
  private async loadPois(): Promise<void> {
    const map = this.map;
    if (!map) return;
    const url = `${this.packBaseUrl}/pois.json`;

    const fetchOnce = async (): Promise<PoiRecord[] | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return normalizePois(await res.json());
      } catch {
        return null;
      }
    };

    let records = await fetchOnce();
    if (!records) {
      await new Promise((r) => setTimeout(r, 5000));
      records = await fetchOnce();
    }
    if (!records) {
      console.warn(`[HeliusMap] ${url} unavailable after retry; skipping trailhead/peak layer`);
      return;
    }

    const features = records.map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      properties: { kind: r.kind, name: r.name, ele: r.ele ?? null },
    }));

    map.addSource('pois', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    for (const layer of poiLayers('pois')) map.addLayer(layer);
  }

  setFix(lat: number, lon: number, accuracyM: number): void {
    if (this.deferUntilReady('setFix', () => this.setFix(lat, lon, accuracyM))) return;
    const map = this.map;
    if (!map) return;

    if (!this.fixMarker) {
      this.fixMarker = new maplibregl.Marker({ element: buildFixMarkerElement(), anchor: 'center' })
        .setLngLat([lon, lat])
        .addTo(map);
    } else {
      this.fixMarker.setLngLat([lon, lat]);
    }

    const accuracySource = map.getSource('accuracy');
    if (accuracySource && 'setData' in accuracySource) {
      (accuracySource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: accuracyCirclePolygon(lat, lon, accuracyM), properties: {} }],
      });
    }

    map.easeTo({ center: [lon, lat] });
  }

  drawRoute(geojson: RouteLineString, opts: DrawRouteOptions = {}): void {
    if (this.deferUntilReady('drawRoute', () => this.drawRoute(geojson, opts))) return;
    const map = this.map;
    if (!map) return;
    const routeSource = map.getSource('route');
    if (!routeSource || !('setData' in routeSource)) return;

    if (this.routeAnimationHandle !== null) {
      cancelAnimationFrame(this.routeAnimationHandle);
      this.routeAnimationHandle = null;
    }

    const coords = geojson.coordinates;
    this.routeFullCoords = coords;
    const src = routeSource as maplibregl.GeoJSONSource;

    if (coords.length === 0) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const dest = coords[coords.length - 1];
    if (!this.destinationMarker) {
      this.destinationMarker = new maplibregl.Marker({ element: buildDestinationFlagElement(), anchor: 'bottom' })
        .setLngLat(dest)
        .addTo(map);
    } else {
      this.destinationMarker.setLngLat(dest);
    }

    if (coords.length < 2) {
      src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geojson, properties: {} }] });
      return;
    }

    const cumulative = cumulativeDistances(coords);
    const total = cumulative[cumulative.length - 1];
    const durationMs = opts.animateMs ?? 1500;
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const partial = total > 0 ? sliceRouteAtProgress(coords, cumulative, total, t) : coords;
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: partial }, properties: {} }],
      });
      if (t < 1) {
        this.routeAnimationHandle = requestAnimationFrame(step);
      } else {
        this.routeAnimationHandle = null;
      }
    };
    this.routeAnimationHandle = requestAnimationFrame(step);
  }

  clearRoute(): void {
    if (this.routeAnimationHandle !== null) {
      cancelAnimationFrame(this.routeAnimationHandle);
      this.routeAnimationHandle = null;
    }
    this.routeFullCoords = null;
    const map = this.map;
    if (!map) return;
    const routeSource = map.getSource('route');
    if (routeSource && 'setData' in routeSource) {
      (routeSource as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
    }
    this.destinationMarker?.remove();
    this.destinationMarker = null;
  }

  flyToRoute(): void {
    // Replayed after drawRoute on flush regardless of queue order (see the
    // fixed kind-order loop in init()), so this always finds routeFullCoords
    // already populated instead of flying to nothing.
    if (this.deferUntilReady('flyToRoute', () => this.flyToRoute())) return;
    const map = this.map;
    if (!map || !this.routeFullCoords || this.routeFullCoords.length === 0) return;
    const [sw, ne] = boundsOf(this.routeFullCoords);
    map.fitBounds([sw, ne], { padding: 64, duration: 800 });
  }

  setBeaconMode(on: boolean): void {
    if (this.deferUntilReady('setBeaconMode', () => this.setBeaconMode(on))) return;
    this.beaconOn = on;
    const map = this.map;
    if (!map || !map.getLayer('beacon-dim')) return;
    map.setPaintProperty('beacon-dim', 'background-opacity', on ? 0.55 : 0);
  }

  /** Current beacon-dim state, mostly useful for tests/the probe page. */
  get isBeaconOn(): boolean {
    return this.beaconOn;
  }
}
