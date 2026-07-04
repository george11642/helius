// Client side of the optional online planning feature. While the user still
// has signal, prepareBrief() composes a request from the pack's REAL data
// (pois.json trailheads, manifest bbox, the same offline sun math the agent
// uses) and POSTs it to /api/brief, where NVIDIA Nemotron drafts a structured
// MissionBrief. The result is persisted on-device (see ./store) so the
// on-device Gemma agent can read it fully offline via the mission_brief tool.
// The offline product never depends on this module succeeding: no key → the
// endpoint answers 501 and the UI hides the feature; ?brief=mock exercises
// the whole path with a deterministic canned brief and no upstream call.

import { PACK_BASE_URL } from '../map/pack-base';
import { daylightLeft } from '../lib/sun';
import { getFix, getPack, defaultFixFor } from '../tools/tools';
import type { BriefRequestBody, BriefTrailhead, MissionBrief } from './protocol';
import { saveBrief } from './store';

export { getCachedBrief } from './store';
export type { MissionBrief } from './protocol';

const ENDPOINT = '/api/brief';

/** True when the page was opened with ?brief=mock — key-less demo/testing mode. */
export function isBriefMockMode(): boolean {
  return new URLSearchParams(location.search).get('brief') === 'mock';
}

export function isOnline(): boolean {
  return navigator.onLine;
}

/** Asks the endpoint whether a planning key is configured (GET is cheap and key-less). */
export async function briefConfigured(): Promise<boolean> {
  try {
    const res = await fetch(ENDPOINT, { method: 'GET' });
    if (!res.ok) return false;
    const data = (await res.json()) as { configured?: boolean };
    return data.configured === true;
  } catch {
    return false; // offline, or no function deployed — feature stays hidden
  }
}

interface PackManifest {
  bbox: [number, number, number, number];
  center: [number, number];
}
interface PackPois {
  trailheads: { name: string; lat: number; lon: number; role?: string }[];
}

async function fetchPackJson<T>(packId: string, file: string): Promise<T> {
  const res = await fetch(`${PACK_BASE_URL}/${packId}/${file}`);
  if (!res.ok) throw new Error(`${file} for ${packId}: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Prepare (or refresh) the mission brief for a pack: gather the pack's real
 * data, call the planning endpoint, persist the result on-device. Throws
 * 'not_configured' when no key is set server-side (caller hides the feature).
 */
export async function prepareBrief(packId: string, opts: { mock?: boolean } = {}): Promise<MissionBrief> {
  const [manifest, pois] = await Promise.all([
    fetchPackJson<PackManifest>(packId, 'manifest.json'),
    fetchPackJson<PackPois>(packId, 'pois.json'),
  ]);
  const trailheads: BriefTrailhead[] = pois.trailheads.map((t) => ({ name: t.name, lat: t.lat, lon: t.lon, role: t.role }));

  // Start point: the live fix if this pack is active (getFix may be null when
  // no GPS/demo fix exists yet), else the pack's demo fix, else its center.
  const live = getPack() === packId ? getFix() : null;
  const fix = live ?? defaultFixFor(packId) ?? { lat: manifest.center[1], lon: manifest.center[0] };
  const now = new Date();
  const sun = daylightLeft(now, fix.lat, fix.lon);
  const primary = trailheads.find((t) => t.role) ?? trailheads[0];

  const body: BriefRequestBody = {
    packId,
    destination: primary?.name,
    startCoord: { lat: fix.lat, lon: fix.lon },
    date: now.toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    bbox: manifest.bbox,
    trailheads,
    sun: { sunset: sun.sunset.toISOString(), civilDusk: sun.civilDuskEnd.toISOString(), minutesToSunset: sun.minutesToSunset },
    mock: opts.mock === true,
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 501) throw new Error('not_configured');
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`brief failed (${res.status}): ${detail}`);
  }
  const brief = (await res.json()) as MissionBrief;
  saveBrief(brief);
  return brief;
}
