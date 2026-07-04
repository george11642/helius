// On-device persistence for mission briefs. localStorage (not Cache API):
// a brief is a few KB of JSON, synchronous reads keep the mission_brief tool
// deterministic and sub-millisecond like every other tool, and localStorage
// survives offline reloads exactly like the SW caches do. Kept as its own
// tiny module (instead of living in index.ts) so src/tools/brief.ts can read
// the cache without importing the network/prepare side — which would create
// an import cycle back through the tools façade.

import type { MissionBrief } from './protocol';

const key = (packId: string): string => `helius-brief-${packId}`;

export function getCachedBrief(packId: string): MissionBrief | null {
  try {
    const raw = localStorage.getItem(key(packId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MissionBrief;
    return parsed && typeof parsed.summary === 'string' ? parsed : null;
  } catch {
    return null; // no storage / corrupt entry — behave as "no briefing prepared"
  }
}

export function saveBrief(brief: MissionBrief): void {
  try {
    localStorage.setItem(key(brief.packId), JSON.stringify(brief));
  } catch (err) {
    console.warn('[helius] brief cache write failed', err);
  }
}
