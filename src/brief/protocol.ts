// Mission-brief protocol: the shared, environment-agnostic core of the
// OPTIONAL online planning feature ("Nemotron plans your mission online;
// Gemma keeps you alive offline"). This one module is consumed from three
// places — the Cloudflare Pages Function (functions/api/brief.ts), the vite
// dev middleware (functions/dev-plugin.ts), and the node unit tests — so it
// uses only web-standard APIs (fetch/Request/Response) and never touches the
// DOM, workers, or node builtins.
//
// Hard product rule this file enforces: Nemotron NEVER does inference in the
// offline product. It runs once, online, pre-trip; its output is a static
// MissionBrief JSON cached on-device that the on-device Gemma agent later
// reads through the mission_brief tool. No key → 501 not_configured and the
// client hides the feature; mock mode returns a deterministic brief built
// from the pack's real POIs so everything is testable key-less.

export const NEMOTRON_MODEL = 'nvidia/nemotron-3-nano-30b-a3b';
const NIM_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 90_000;

// ------------------------------------------------------------------ types ----

export interface BriefTrailhead {
  name: string;
  lat: number;
  lon: number;
  role?: string; // 'trailhead' | 'crest' | 'tram_station' (pack pois.json roles)
}

/** POST /api/brief body — composed client-side from the pack's REAL data. */
export interface BriefRequestBody {
  packId: string;
  destination?: string;
  startCoord: { lat: number; lon: number };
  date: string; // ISO — trip date
  tz: string; // IANA tz of the user
  bbox?: [number, number, number, number]; // pack manifest bbox [w,s,e,n]
  trailheads: BriefTrailhead[]; // pack pois.json trailheads (bail-out candidates)
  sun?: { sunset: string; civilDusk: string; minutesToSunset: number }; // computed client-side (src/lib/sun.ts)
  mock?: boolean; // deterministic canned brief, no upstream call
}

export interface BriefBailout {
  name: string;
  lat: number;
  lon: number;
  rank: number; // 1 = best
  why: string;
}

export interface MissionBrief {
  packId: string;
  destination: string;
  generatedAt: string;
  model: string; // NEMOTRON_MODEL or 'mock'
  locale: string; // 'fr' for chamonix/fontainebleau, else 'en'
  summary: string;
  daylight: { sunset: string; turnaroundBy: string; note: string };
  route: string[]; // ordered plan lines
  bailouts: BriefBailout[]; // ranked exits
  water: string[];
  gear: string[];
  terrain: string[]; // terrain cautions
  signal: string[]; // where to expect / not expect coverage
  phrases: { local: string; english: string }[]; // key phrases for the pack's locale
}

// ---------------------------------------------------------------- helpers ----

export function localeForPack(packId: string): string {
  return packId === 'chamonix' || packId === 'fontainebleau' ? 'fr' : 'en';
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validateBody(raw: unknown): BriefRequestBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.packId !== 'string' || b.packId.length === 0 || b.packId.length > 64) return null;
  const sc = b.startCoord as Record<string, unknown> | undefined;
  if (!sc || !isFiniteNum(sc.lat) || !isFiniteNum(sc.lon)) return null;
  if (!Array.isArray(b.trailheads)) return null;
  const trailheads: BriefTrailhead[] = [];
  for (const t of b.trailheads as unknown[]) {
    const o = t as Record<string, unknown>;
    if (o && typeof o.name === 'string' && isFiniteNum(o.lat) && isFiniteNum(o.lon)) {
      trailheads.push({ name: o.name, lat: o.lat, lon: o.lon, role: typeof o.role === 'string' ? o.role : undefined });
    }
  }
  if (trailheads.length === 0) return null;
  return {
    packId: b.packId,
    destination: typeof b.destination === 'string' ? b.destination : undefined,
    startCoord: { lat: sc.lat as number, lon: sc.lon as number },
    date: typeof b.date === 'string' ? b.date : '',
    tz: typeof b.tz === 'string' ? b.tz : 'UTC',
    bbox: Array.isArray(b.bbox) && b.bbox.length === 4 && (b.bbox as unknown[]).every(isFiniteNum) ? (b.bbox as [number, number, number, number]) : undefined,
    trailheads,
    sun:
      b.sun && typeof b.sun === 'object' && typeof (b.sun as Record<string, unknown>).sunset === 'string'
        ? (b.sun as BriefRequestBody['sun'])
        : undefined,
    mock: b.mock === true,
  };
}

// ------------------------------------------------------------- mock brief ----
// Deterministic (no clock, no randomness): built entirely from the posted
// pack data, so it exercises the exact same client → cache → mission_brief
// data path as a real Nemotron brief, key-less.

const ROLE_LABEL: Record<string, string> = {
  trailhead: 'road access and parking',
  crest: 'high point with road access',
  tram_station: 'mechanical descent available',
};

const FR_PHRASES = [
  { local: 'Au secours !', english: 'Help!' },
  { local: 'Je suis perdu / perdue.', english: 'I am lost.' },
  { local: 'Où est le sentier le plus proche ?', english: 'Where is the nearest trail?' },
  { local: "J'ai besoin d'aide pour redescendre.", english: 'I need help getting back down.' },
];

function minus90min(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t - 90 * 60000).toISOString() : iso;
}

export function buildMockBrief(body: BriefRequestBody): MissionBrief {
  const locale = localeForPack(body.packId);
  const ranked = [...body.trailheads]
    .map((t) => ({ ...t, km: haversineKm(body.startCoord.lat, body.startCoord.lon, t.lat, t.lon) }))
    .sort((a, b) => a.km - b.km);
  const destination = body.destination ?? ranked[0].name;
  const bailouts: BriefBailout[] = ranked.slice(0, 4).map((t, i) => ({
    name: t.name,
    lat: t.lat,
    lon: t.lon,
    rank: i + 1,
    why: `${t.km.toFixed(1)} km from start${t.role && ROLE_LABEL[t.role] ? ` — ${ROLE_LABEL[t.role]}` : ''}`,
  }));
  const sunset = body.sun?.sunset ?? '';
  return {
    packId: body.packId,
    destination,
    generatedAt: body.date || 'unknown',
    model: 'mock',
    locale,
    summary: `Day plan toward ${destination}: leave early, track daylight, and know your exits — ${bailouts[0].name} is the closest ranked bail-out.`,
    daylight: {
      sunset,
      turnaroundBy: sunset ? minus90min(sunset) : '',
      note: 'Turn around at least 90 minutes before sunset; descending in the dark multiplies every risk.',
    },
    route: [
      `Start at the marked trail near your start coordinate and confirm position before committing.`,
      `Main objective: ${destination}. Stay on the mapped trail network the whole way.`,
      `If pace slips or weather turns, divert to ${bailouts[0].name} (${bailouts[0].why}).`,
    ],
    bailouts,
    water: ['Carry at least 2 L per person; refill only at mapped, treated sources.', 'No reliable water sources assumed above the treeline — top up low.'],
    gear: ['Headlamp with spare battery (non-negotiable).', 'Wind/rain shell and one warm layer more than the forecast needs.', 'Charged phone in airplane mode + this offline pack downloaded.'],
    terrain: ['Expect loose rock and sudden exposure near ridgelines; slow down at cable or chain sections.', 'Afternoon storms build fast over high terrain — descend at the first thunder.'],
    signal: [`Assume NO signal on most of the route; last reliable coverage is near the trailhead road.`, 'High open ridges occasionally catch a bar — mark any spot where a message sends.'],
    phrases: locale === 'fr' ? FR_PHRASES : [],
  };
}

// -------------------------------------------------- Nemotron prompt + call ----

const PLANNER_SYSTEM = [
  'You are the pre-trip mission planner for Helius, an offline hiking safety agent.',
  'You run ONLINE before the user departs. Your briefing is cached to the device and later read OFFLINE',
  'by an on-device agent, so it must be complete and self-contained.',
  'Respond with ONLY one JSON object. No prose, no markdown, no code fences.',
  'STRICTLY NON-MEDICAL: never include first-aid, medical, diagnosis, treatment, or medication content.',
  'For injury or illness the offline agent only ever advises contacting emergency services when a signal',
  'is reachable — do not add anything beyond that stance.',
  'Never invent locations or coordinates: rank bail-out points ONLY from the trailheads provided.',
].join(' ');

function schemaText(locale: string): string {
  return [
    'JSON schema (all fields required):',
    '{',
    '  "summary": string,                       // 1-2 sentences: the day plan in brief',
    '  "daylight": { "sunset": string, "turnaroundBy": string, "note": string },  // ISO times; turnaroundBy well before sunset',
    '  "route": string[],                       // 3-5 ordered plan steps, each <= 140 chars',
    '  "bailouts": [{ "name": string, "rank": number, "why": string }],  // rank ALL provided trailheads, 1 = best exit; name must match a provided trailhead exactly',
    '  "water": string[],                       // 2-4 items, water strategy',
    '  "gear": string[],                        // 3-5 items, non-medical gear checklist',
    '  "terrain": string[],                     // 2-4 terrain cautions for this specific region',
    '  "signal": string[],                      // 2-3 lines: where to expect / not expect phone coverage',
    locale === 'fr'
      ? '  "phrases": [{ "local": string, "english": string }]  // 4-6 short FRENCH phrases a lost hiker needs, with English translations'
      : '  "phrases": []                            // empty array for this region',
    '}',
  ].join('\n');
}

function plannerUserPrompt(body: BriefRequestBody): string {
  const locale = localeForPack(body.packId);
  const th = body.trailheads
    .map((t) => `- ${t.name} (${t.lat.toFixed(4)}, ${t.lon.toFixed(4)})${t.role ? ` [${t.role}]` : ''}`)
    .join('\n');
  return [
    `Region pack: ${body.packId}${body.bbox ? ` — bbox [${body.bbox.join(', ')}]` : ''}. Locale: ${locale}.`,
    `Trip date: ${body.date} (${body.tz}). Start coordinate: ${body.startCoord.lat.toFixed(4)}, ${body.startCoord.lon.toFixed(4)}.`,
    body.sun ? `Sun window (precomputed, trust it): sunset ${body.sun.sunset}, civil dusk ${body.sun.civilDusk}, ${body.sun.minutesToSunset} min of daylight remain from request time.` : '',
    body.destination ? `Primary objective: ${body.destination}.` : 'Primary objective: the nearest role-tagged trailhead.',
    'Known safe exits (the ONLY allowed bail-out points):',
    th,
    '',
    schemaText(locale),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Robust JSON extraction: strips reasoning blocks + code fences, then takes the outermost {...}. */
export function extractJson(text: string): unknown {
  let t = text;
  // Reasoning models: drop <think>…</think>; if only a closing tag survives, keep what follows it.
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  const lastClose = t.lastIndexOf('</think>');
  if (lastClose !== -1) t = t.slice(lastClose + '</think>'.length);
  t = t.replace(/```(?:json)?/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(t.slice(start, end + 1)) as unknown;
}

const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.slice(0, 200)).slice(0, max) : [];

/**
 * Normalize a parsed model reply into a MissionBrief. Coordinates are
 * geo-truth: bail-out lat/lon always come from the pack's own trailheads
 * (matched by name), never from the model — a hallucinated coordinate is
 * worse than none. Throws if the reply is missing its core (summary).
 */
export function normalizeBrief(raw: unknown, body: BriefRequestBody, model: string, generatedAt: string): MissionBrief {
  if (!raw || typeof raw !== 'object') throw new Error('model reply is not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.summary !== 'string' || r.summary.trim() === '') throw new Error('model reply missing summary');

  const byName = new Map(body.trailheads.map((t) => [t.name.toLowerCase(), t]));
  const bailouts: BriefBailout[] = [];
  if (Array.isArray(r.bailouts)) {
    for (const b of r.bailouts as unknown[]) {
      const o = b as Record<string, unknown>;
      if (!o || typeof o.name !== 'string') continue;
      const name = o.name.toLowerCase();
      const match =
        byName.get(name) ?? body.trailheads.find((t) => t.name.toLowerCase().includes(name) || name.includes(t.name.toLowerCase()));
      if (!match) continue; // model invented an exit — drop it
      bailouts.push({
        name: match.name,
        lat: match.lat,
        lon: match.lon,
        rank: isFiniteNum(o.rank) ? o.rank : bailouts.length + 1,
        why: typeof o.why === 'string' ? o.why.slice(0, 200) : '',
      });
    }
  }
  bailouts.sort((a, b) => a.rank - b.rank);

  const dl = (r.daylight ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 300) : '');
  return {
    packId: body.packId,
    destination: body.destination ?? body.trailheads[0].name,
    generatedAt,
    model,
    locale: localeForPack(body.packId),
    summary: r.summary.slice(0, 500),
    daylight: { sunset: str(dl.sunset) || (body.sun?.sunset ?? ''), turnaroundBy: str(dl.turnaroundBy), note: str(dl.note) },
    route: strList(r.route, 5),
    bailouts: bailouts.slice(0, 6),
    water: strList(r.water, 4),
    gear: strList(r.gear, 5),
    terrain: strList(r.terrain, 4),
    signal: strList(r.signal, 3),
    phrases: Array.isArray(r.phrases)
      ? (r.phrases as unknown[])
          .map((p) => p as Record<string, unknown>)
          .filter((p) => p && typeof p.local === 'string' && typeof p.english === 'string')
          .map((p) => ({ local: (p.local as string).slice(0, 120), english: (p.english as string).slice(0, 120) }))
          .slice(0, 6)
      : [],
  };
}

async function callNemotron(body: BriefRequestBody, apiKey: string, fetchImpl: typeof fetch): Promise<MissionBrief> {
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: plannerUserPrompt(body) },
  ];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchImpl(NIM_CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: NEMOTRON_MODEL, messages, temperature: 0.2, top_p: 0.9, max_tokens: 4096 }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`NIM ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const rawText = data.choices?.[0]?.message?.content ?? '';
    try {
      return normalizeBrief(extractJson(rawText), body, NEMOTRON_MODEL, new Date().toISOString());
    } catch (err) {
      lastErr = err;
      // One corrective retry: show the model its own reply and demand pure JSON.
      messages.push({ role: 'assistant', content: rawText.slice(0, 6000) });
      messages.push({ role: 'user', content: 'That was not the required format. Respond again with ONLY the single JSON object matching the schema — no reasoning, no prose, no markdown.' });
    }
  }
  throw new Error(`unparseable model output: ${String(lastErr).slice(0, 200)}`);
}

// ---------------------------------------------------------------- handler ----

export interface BriefEnv {
  NVIDIA_API_KEY?: string;
}

/**
 * The whole /api/brief endpoint, host-agnostic:
 *   GET  → { configured, model }              (client uses this to show/hide the feature)
 *   POST → MissionBrief JSON | 501 not_configured | 400 bad_request | 502 upstream_failed
 * Mock requests never touch the network and work without a key.
 */
export async function handleBriefRequest(request: Request, env: BriefEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method === 'GET') return json({ configured: Boolean(env.NVIDIA_API_KEY), model: NEMOTRON_MODEL });
  if (request.method !== 'POST') return json({ reason: 'method_not_allowed' }, 405);

  let body: BriefRequestBody | null = null;
  try {
    body = validateBody(await request.json());
  } catch {
    body = null;
  }
  if (!body) return json({ reason: 'bad_request', hint: 'packId, startCoord{lat,lon}, trailheads[] required' }, 400);

  if (body.mock) return json(buildMockBrief(body));
  if (!env.NVIDIA_API_KEY) return json({ reason: 'not_configured' }, 501);

  try {
    return json(await callNemotron(body, env.NVIDIA_API_KEY, fetchImpl));
  } catch (err) {
    return json({ reason: 'upstream_failed', detail: String(err).slice(0, 300) }, 502);
  }
}
