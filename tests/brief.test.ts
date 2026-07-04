// Unit tests for src/brief/protocol.ts — run with:
//   node --experimental-strip-types tests/brief.test.ts
// Exercises the /api/brief handler end-to-end in-process (mock mode, 501
// key-less path, bad input), plus the robust JSON extraction and the
// geo-truth normalization that snaps bail-out coordinates to real POIs.
import {
  handleBriefRequest,
  buildMockBrief,
  extractJson,
  normalizeBrief,
  localeForPack,
  NEMOTRON_MODEL,
} from '../src/brief/protocol.ts';
import type { BriefRequestBody, MissionBrief } from '../src/brief/protocol.ts';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name}`);
  }
}
function eq(actual: unknown, expected: unknown, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const sandiaBody: BriefRequestBody = {
  packId: 'sandia',
  destination: 'La Luz Trailhead',
  startCoord: { lat: 35.1983, lon: -106.4439 },
  date: '2026-07-04T18:00:00.000Z',
  tz: 'America/Denver',
  bbox: [-107.15, 34.65, -106.15, 35.55],
  trailheads: [
    { name: 'La Luz Trailhead', lat: 35.2286, lon: -106.4818, role: 'trailhead' },
    { name: 'Sandia Crest House', lat: 35.2103, lon: -106.4485, role: 'crest' },
    { name: 'Tram Top Station', lat: 35.1899, lon: -106.4059, role: 'tram_station' },
  ],
  sun: { sunset: '2026-07-05T02:24:00.000Z', civilDusk: '2026-07-05T02:53:00.000Z', minutesToSunset: 504 },
};

const post = (body: unknown): Request =>
  new Request('http://localhost/api/brief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function main(): Promise<void> {
  // ---- GET: configured flag ----
  {
    const res = await handleBriefRequest(new Request('http://x/api/brief'), {});
    const data = (await res.json()) as { configured: boolean; model: string };
    eq(res.status, 200, 'GET status');
    eq(data.configured, false, 'GET key-less → configured:false');
    eq(data.model, NEMOTRON_MODEL, 'GET reports model id');
    const res2 = await handleBriefRequest(new Request('http://x/api/brief'), { NVIDIA_API_KEY: 'k' });
    eq(((await res2.json()) as { configured: boolean }).configured, true, 'GET with key → configured:true');
  }

  // ---- POST: key-less, no mock → 501 not_configured ----
  {
    const res = await handleBriefRequest(post(sandiaBody), {});
    eq(res.status, 501, 'key-less POST → 501');
    eq(((await res.json()) as { reason: string }).reason, 'not_configured', '501 reason');
  }

  // ---- POST: garbage → 400 ----
  {
    eq((await handleBriefRequest(post({ nope: true }), {})).status, 400, 'invalid body → 400');
    const noTh = { ...sandiaBody, trailheads: [] };
    eq((await handleBriefRequest(post(noTh), {})).status, 400, 'empty trailheads → 400');
  }

  // ---- POST: mock mode works key-less, deterministic, real POIs ----
  {
    const res = await handleBriefRequest(post({ ...sandiaBody, mock: true }), {});
    eq(res.status, 200, 'mock POST → 200');
    const brief = (await res.json()) as MissionBrief;
    eq(brief.model, 'mock', 'mock brief model');
    eq(brief.packId, 'sandia', 'mock brief packId');
    eq(brief.destination, 'La Luz Trailhead', 'mock brief destination');
    ok(brief.bailouts.length === 3, 'mock ranks all trailheads');
    eq(brief.bailouts[0].name, 'Sandia Crest House', 'nearest exit ranked #1');
    eq(brief.bailouts[0].lat, 35.2103, 'bail-out coords are the real POI coords');
    ok(brief.gear.length >= 3 && brief.water.length >= 2 && brief.terrain.length >= 2 && brief.signal.length >= 2, 'mock checklists populated');
    eq(brief.phrases.length, 0, 'sandia (en) has no phrases');
    eq(brief.daylight.turnaroundBy, '2026-07-05T00:54:00.000Z', 'turnaround = sunset - 90min');
    const again = buildMockBrief({ ...sandiaBody, mock: true });
    eq(JSON.stringify(again), JSON.stringify(brief), 'mock brief is deterministic');
    const noMedical = JSON.stringify(brief).toLowerCase();
    ok(!/first.aid|medic|bandage|medication/.test(noMedical), 'mock brief is non-medical');
  }

  // ---- locale: chamonix gets French phrases ----
  {
    const brief = buildMockBrief({ ...sandiaBody, packId: 'chamonix' });
    eq(localeForPack('chamonix'), 'fr', 'chamonix locale fr');
    eq(localeForPack('fontainebleau'), 'fr', 'fontainebleau locale fr');
    ok(brief.phrases.length >= 4 && brief.phrases.every((p) => p.local && p.english), 'fr phrases present with translations');
  }

  // ---- extractJson robustness ----
  {
    eq(extractJson('{"a":1}'), { a: 1 }, 'plain JSON');
    eq(extractJson('```json\n{"a":1}\n```'), { a: 1 }, 'fenced JSON');
    eq(extractJson('<think>ranking exits...</think>\n{"a":1}'), { a: 1 }, 'think block stripped');
    eq(extractJson('reasoning reasoning</think>{"a":1}'), { a: 1 }, 'unopened think close handled');
    eq(extractJson('Sure! Here is the plan: {"a":{"b":2}} hope that helps'), { a: { b: 2 } }, 'prose around JSON');
    let threw = false;
    try {
      extractJson('no json here');
    } catch {
      threw = true;
    }
    ok(threw, 'no JSON → throws');
  }

  // ---- normalizeBrief: geo-truth snapping + clamps ----
  {
    const raw = {
      summary: 'Solid day plan.',
      daylight: { sunset: '2026-07-05T02:24:00.000Z', turnaroundBy: '2026-07-05T00:30:00.000Z', note: 'be down early' },
      route: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      bailouts: [
        { name: 'tram top station', rank: 2, why: 'lift down', lat: 99, lon: 99 }, // wrong coords + case — must snap
        { name: 'La Luz Trailhead', rank: 1, why: 'parking' },
        { name: 'Hallucinated Hut', rank: 3, why: 'does not exist' }, // must be dropped
      ],
      water: ['w1'],
      gear: ['g1', 'g2'],
      terrain: ['t1'],
      signal: ['s1'],
      phrases: [{ local: 'Au secours !', english: 'Help!' }],
    };
    const brief = normalizeBrief(raw, sandiaBody, NEMOTRON_MODEL, '2026-07-04T18:00:00.000Z');
    eq(brief.route.length, 5, 'route clamped to 5');
    eq(brief.bailouts.length, 2, 'invented bail-out dropped');
    eq(brief.bailouts[0].name, 'La Luz Trailhead', 'bailouts sorted by rank');
    eq(brief.bailouts[1].lat, 35.1899, 'model coords replaced with real POI coords');
    eq(brief.model, NEMOTRON_MODEL, 'model recorded');
    let threw = false;
    try {
      normalizeBrief({ nope: 1 }, sandiaBody, NEMOTRON_MODEL, 'x');
    } catch {
      threw = true;
    }
    ok(threw, 'missing summary → throws');
  }

  // ---- upstream path: fake NIM fetch (bad JSON first, then good) → one retry ----
  {
    let calls = 0;
    const goodJson = JSON.stringify({
      summary: 'Plan.',
      daylight: { sunset: '', turnaroundBy: '', note: '' },
      route: ['go'],
      bailouts: [{ name: 'La Luz Trailhead', rank: 1, why: 'road' }],
      water: ['w'],
      gear: ['g'],
      terrain: ['t'],
      signal: ['s'],
      phrases: [],
    });
    const fakeFetch = (async (_url: unknown, _init?: unknown) => {
      calls++;
      const content = calls === 1 ? 'not json at all' : goodJson;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    const res = await handleBriefRequest(post(sandiaBody), { NVIDIA_API_KEY: 'k' }, fakeFetch);
    eq(res.status, 200, 'retry path → 200');
    eq(calls, 2, 'exactly one retry after unparseable output');
    const brief = (await res.json()) as MissionBrief;
    eq(brief.summary, 'Plan.', 'retried brief parsed');

    const failFetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const res2 = await handleBriefRequest(post(sandiaBody), { NVIDIA_API_KEY: 'bad' }, failFetch);
    eq(res2.status, 502, 'upstream failure → 502');
    eq(((await res2.json()) as { reason: string }).reason, 'upstream_failed', '502 reason');
  }

  console.log(`brief.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
