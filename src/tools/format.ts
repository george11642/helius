// Deterministic display formatting for tool numbers. Every tool that returns a
// distance/time/clock value pre-formats it here and ships the string in its
// result `data.display` — the model is instructed (src/agent/prompt.ts) to
// quote these verbatim instead of converting units itself, so the numbers the
// user hears are computed, never hallucinated. Pure functions, Node-testable
// (tests/format.test.ts) — keep this module import-free.

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

/** "3.87 km / 2.40 mi" — or "340 m / 1,115 ft" under a kilometer. */
export function fmtDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return 'unknown distance';
  if (meters < 1000) {
    const ft = Math.round(meters / M_PER_FT);
    return `${Math.round(meters)} m / ${ft.toLocaleString('en-US')} ft`;
  }
  const km = meters / 1000;
  const mi = meters / M_PER_MI;
  return `${km.toFixed(2)} km / ${mi.toFixed(2)} mi`;
}

/** "45 min" under an hour, "1h42m" from there up. */
export function fmtDurationMin(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return 'unknown time';
  const min = Math.round(minutes);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/** Local 24-hour wall clock, "20:24" — deterministic (no locale AM/PM). */
export function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "35.1983, -106.4439 (±14 m)" — accuracy omitted when unknown. */
export function fmtLatLon(lat: number, lon: number, accuracyM?: number | null): string {
  const base = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  return typeof accuracyM === 'number' && Number.isFinite(accuracyM) ? `${base} (±${Math.round(accuracyM)} m)` : base;
}
