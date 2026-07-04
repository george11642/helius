// mission_brief tool: the offline half of the online-planning feature. While
// the user still had signal, an online planning pass (NVIDIA Nemotron via
// /api/brief) produced a MissionBrief that was cached on-device alongside the
// pack. This tool hands that cached brief to the ON-DEVICE Gemma agent —
// deterministic, synchronous, fully offline, never throws, no inference of
// its own. If no brief was prepared, it says so honestly instead of guessing.

import type { ToolResult, ToolSpec } from '../lib/contract';
import { getCachedBrief } from '../brief/store';
import { getPack } from './pack';

export const missionBriefSpec: ToolSpec = {
  type: 'function',
  function: {
    name: 'mission_brief',
    description:
      'Get the pre-trip mission briefing prepared while online for this region: route/daylight plan, ranked bail-out points, water and gear checklist, terrain cautions, signal coverage expectations, and key local phrases. Available fully offline once prepared.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const hhmm = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};

export function runMissionBrief(): ToolResult {
  const packId = getPack();
  const brief = getCachedBrief(packId);
  if (!brief) {
    return {
      data: {
        error: 'no_briefing',
        display: 'No mission briefing is cached for this region. One can be prepared from the header while online, before losing signal.',
      },
      summary: 'mission_brief: none prepared for this region',
    };
  }
  const turnaround = hhmm(brief.daylight.turnaroundBy);
  const topBailout = brief.bailouts[0];
  const display = `Briefing for ${brief.destination}, prepared online before departure: ${brief.summary}${
    turnaround ? ` Turn around by ${turnaround}.` : ''
  }${topBailout ? ` Best bail-out: ${topBailout.name} (${topBailout.why}).` : ''}`;
  return {
    data: {
      display,
      destination: brief.destination,
      prepared: brief.generatedAt,
      source: 'prepared online before departure, cached on-device',
      summary: brief.summary,
      daylight: brief.daylight,
      route_plan: brief.route,
      bailouts: brief.bailouts,
      water: brief.water,
      gear: brief.gear,
      terrain_cautions: brief.terrain,
      signal_expectations: brief.signal,
      key_phrases: brief.phrases,
    },
    summary: `briefing: ${brief.destination}, ${brief.bailouts.length} bail-outs${turnaround ? `, turnaround ${turnaround}` : ''}`,
  };
}
