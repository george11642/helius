// Tool registry: deterministic, offline, sub-50ms local functions the agent
// can call by name (read_sign is the one intentional exception — it runs a
// vision sub-inference). Every tool returns fast and NEVER throws; failures
// come back as { error } data so the agent loop can recover in-band.

import type { AgentEventHandler, Tool, ToolResult, ToolSpec } from '../lib/contract';
import type { RawFrame } from '../llm/protocol';
import { daylightLeft } from '../lib/sun';
import { getFix } from './location';
import { morseTiming, morseDurationMs, toMorse } from './morse';
import { takePendingFrame } from './camera';
import { runRouteBack } from './route';

/** Minimal engine surface the tools need (read_sign vision). */
export interface EngineForTools {
  visionInfer(frame: RawFrame, prompt: string): Promise<{ text: string; rawText: string }>;
}

export interface ToolContext {
  emit: AgentEventHandler;
  engine: EngineForTools;
}

export interface ToolRegistry {
  specs: ToolSpec[];
  get(name: string): Tool | undefined;
  names: string[];
}

/** Shared prompt for sign reading — used by both the tool and the façade's readSign(). */
export const READ_SIGN_PROMPT =
  'Read this trail sign. Reply in exactly three short lines, nothing else:\n' +
  '1. Verbatim: the sign text exactly as written.\n' +
  '2. English: a faithful, word-for-word translation. Do NOT add any warning or hazard that is not written on the sign.\n' +
  '3. Do: one short action for the hiker, based ONLY on what the sign actually says.';

const UNIT_MS = 200;

const hhmm = (d: Date): string => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const round = (n: number): number => Math.round(n);
const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

// ------------------------------------------------------------- tool specs ----

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const SPECS: Record<string, ToolSpec> = {
  locate: spec('locate', "Get the user's current position (lat, lon, accuracy, elevation) from GPS or the simulated fix.", {}, []),
  sun_clock: spec(
    'sun_clock',
    'Get sunset time and remaining minutes of daylight and usable light at the current position and date.',
    {},
    [],
  ),
  pace_eta: spec(
    'pace_eta',
    'Estimate walking time (Naismith’s rule) for a given distance and optional climb, and whether it beats sunset.',
    {
      distance_m: { type: 'number', description: 'Distance to cover, in meters.' },
      ascent_m: { type: 'number', description: 'Total climb along the way, in meters (0 or negative if flat/descending).' },
    },
    ['distance_m'],
  ),
  route_back: spec(
    'route_back',
    'Compute a walking route from the current position back to a known safe destination over the offline trail graph. Returns distance, ETA, and waypoint count.',
    {
      destination: {
        type: 'string',
        enum: ['trailhead', 'crest', 'tram_station'],
        description: 'Which safe point to route to.',
      },
    },
    ['destination'],
  ),
  morse_beacon: spec(
    'morse_beacon',
    'Arm, start, or stop the screen strobe signaling a Morse message (default SOS) to make the user findable at night.',
    {
      message: { type: 'string', description: 'Message to flash. Defaults to SOS.' },
      mode: { type: 'string', enum: ['arm', 'start', 'stop'], description: 'arm = prepare, start = begin flashing, stop = end.' },
    },
    ['mode'],
  ),
  safety_plan: spec(
    'safety_plan',
    'Produce a short, ordered field-safety checklist (shelter, signal, stay-put vs move) from the current position and remaining light. Non-medical.',
    { situation: { type: 'string', description: 'Optional one-line description of the situation.' } },
    [],
  ),
  read_sign: spec(
    'read_sign',
    'Read a trail sign the user is pointing the camera at: transcribe it, translate to English if needed, and give one actionable line. Only works when a camera frame is available.',
    {},
    [],
  ),
};

// -------------------------------------------------------------- tool impls ----

function locate(): ToolResult {
  const f = getFix();
  return {
    data: { lat: f.lat, lon: f.lon, accuracy_m: f.accuracyM, elevation_m: f.elevationM },
    summary: `fix ${f.lat.toFixed(4)},${f.lon.toFixed(4)} ±${f.accuracyM}m @${f.elevationM}m`,
  };
}

function sunClock(): ToolResult {
  const f = getFix();
  const now = new Date();
  const s = daylightLeft(now, f.lat, f.lon);
  return {
    data: {
      now: now.toISOString(),
      sunset: s.sunset.toISOString(),
      civil_dusk: s.civilDuskEnd.toISOString(),
      minutes_to_sunset: s.minutesToSunset,
      minutes_to_dark: s.minutesToDark,
    },
    summary: `sunset ${hhmm(s.sunset)}, ${s.minutesToSunset} min light, dark in ${s.minutesToDark} min`,
  };
}

function paceEta(args: Record<string, unknown>): ToolResult {
  const distance = asNumber(args.distance_m);
  if (distance === null) return { data: { error: 'bad_args', hint: 'distance_m (meters) is required' }, summary: 'pace_eta: missing distance' };
  const ascent = Math.max(0, asNumber(args.ascent_m) ?? 0);
  // Naismith: 5 km/h on the flat (83.33 m/min) + 1 min per 10 m of climb.
  const flatMin = distance / (5000 / 60);
  const climbMin = ascent / 10;
  const etaMin = round(flatMin + climbMin);
  const now = new Date();
  const arrival = new Date(now.getTime() + etaMin * 60000);
  const f = getFix();
  const sun = daylightLeft(now, f.lat, f.lon);
  const marginMin = sun.minutesToSunset - etaMin;
  const verdict = marginMin >= 0 ? `${marginMin} min before sunset` : `${-marginMin} min AFTER sunset`;
  return {
    data: {
      eta_min: etaMin,
      arrival: arrival.toISOString(),
      distance_m: round(distance),
      ascent_m: round(ascent),
      margin_min: marginMin,
      beats_sunset: marginMin >= 0,
    },
    summary: `ETA ${etaMin} min, arrive ${hhmm(arrival)} — ${verdict}`,
  };
}

// route_back is implemented in ./route.ts (real A* over the pack graph) and
// wired into the registry below via runRouteBack.

function morseBeacon(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const mode = asString(args.mode, 'arm') as 'arm' | 'start' | 'stop';
  const message = asString(args.message, 'SOS') || 'SOS';
  const steps = morseTiming(message, UNIT_MS);
  const pattern = toMorse(message);
  const action: 'arm' | 'start' | 'stop' = mode === 'start' ? 'start' : mode === 'stop' ? 'stop' : 'arm';
  ctx.emit({ type: 'beacon', action, pattern });
  const state = action === 'start' ? 'flashing' : action === 'stop' ? 'stopped' : 'armed';
  return {
    data: {
      state,
      message,
      pattern,
      unit_ms: UNIT_MS,
      total_ms: morseDurationMs(steps),
      steps,
    },
    summary: `${message} beacon ${state} (${pattern})`,
  };
}

function safetyPlan(args: Record<string, unknown>, _ctx: ToolContext): ToolResult {
  const f = getFix();
  const now = new Date();
  const sun = daylightLeft(now, f.lat, f.lon);
  const situation = asString(args.situation);
  const dark = sun.minutesToDark;
  const stayPut = dark < 45;

  const steps: string[] = [];
  if (stayPut) {
    steps.push('Stop moving now — with under 45 minutes of light, staying put beats stumbling in the dark.');
    steps.push('Find shelter from wind: get below a ridgeline, behind rock or trees, off wet ground.');
    steps.push('Arm the Morse beacon (SOS) so searchers and aircraft can spot you after dark.');
    steps.push('Put on every layer you have and insulate yourself from the ground before you cool down.');
    steps.push('Signal in threes — three whistle blasts or light flashes — and repeat on a regular interval.');
  } else {
    steps.push(`Move now — you have about ${dark} minutes of usable light; use it to reach a known point.`);
    steps.push('Use route_back to the nearest safe destination and check the ETA against sunset with pace_eta.');
    steps.push('Keep the descent conservative: known trail over shortcuts, steady pace, no scrambling.');
    steps.push('Set a turnaround rule: if light runs out before you arrive, stop and arm the beacon.');
    steps.push('Tell someone your plan if you have any signal; otherwise leave it for when you regain it.');
  }

  return {
    data: {
      stay_put: stayPut,
      minutes_to_dark: dark,
      situation: situation || undefined,
      steps,
      note: 'Non-medical guidance. For injury or illness, contact emergency services when reachable.',
    },
    summary: stayPut ? `stay-put plan (${dark} min light): shelter, signal, insulate` : `move-now plan (${dark} min light): route, pace, turnaround`,
  };
}

async function readSign(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const frame = takePendingFrame();
  if (!frame) {
    return {
      data: { error: 'no_camera_frame', hint: 'Point the camera at the sign, then ask again.' },
      summary: 'read_sign: no camera frame available',
    };
  }
  const { text } = await ctx.engine.visionInfer(frame, READ_SIGN_PROMPT);
  const clean = text.trim();
  return {
    data: { text: clean },
    summary: clean.length > 80 ? clean.slice(0, 77) + '…' : clean || 'sign read',
  };
}

// --------------------------------------------------------------- assembly ----

export function createTools(ctx: ToolContext): ToolRegistry {
  const guard =
    (name: string, fn: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>) =>
    async (args: Record<string, unknown>): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        return { data: { error: 'tool_failed', message: String(err).slice(0, 200) }, summary: `${name}: failed` };
      }
    };

  const tools: Tool[] = [
    { spec: SPECS.locate, run: guard('locate', () => locate()) },
    { spec: SPECS.sun_clock, run: guard('sun_clock', () => sunClock()) },
    { spec: SPECS.pace_eta, run: guard('pace_eta', (a) => paceEta(a)) },
    { spec: SPECS.route_back, run: guard('route_back', (a) => runRouteBack(a)) },
    { spec: SPECS.morse_beacon, run: guard('morse_beacon', (a) => morseBeacon(a, ctx)) },
    { spec: SPECS.safety_plan, run: guard('safety_plan', (a) => safetyPlan(a, ctx)) },
    { spec: SPECS.read_sign, run: guard('read_sign', (a) => readSign(a, ctx)) },
  ];

  const byName = new Map(tools.map((t) => [t.spec.function.name, t]));
  return {
    specs: tools.map((t) => t.spec),
    get: (name) => byName.get(name),
    names: [...byName.keys()],
  };
}
