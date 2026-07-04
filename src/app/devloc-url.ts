// Pure parser for the demo-GPS URL params (?demo=1 / ?devloc=<n> / ?fix=…).
// Split out of devloc.ts so it stays import-free and Node-testable
// (tests/devloc-url.test.ts) — this parser IS the demo-vs-real-GPS decision
// the demo video (video/scenes.mjs) and judge runbook depend on.

export type DemoRequest =
  | { kind: 'preset'; index: number }
  | { kind: 'fix'; lat: number; lon: number; elevationM: number | null };

/** Demo-GPS request parsed from a location.search string: a preset index, an
 *  explicit `?fix=lat,lon[,elevM]` coordinate, or null meaning REAL GPS. */
export function demoRequestFromSearch(search: string): DemoRequest | null {
  const params = new URLSearchParams(search);
  const fix = params.get('fix');
  if (fix !== null) {
    const [lat, lon, elev] = fix.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { kind: 'fix', lat, lon, elevationM: Number.isFinite(elev) ? elev : null };
    }
  }
  if (params.get('demo') === '1') return { kind: 'preset', index: 0 };
  const devloc = params.get('devloc');
  if (devloc !== null) {
    const n = Number(devloc);
    if (Number.isInteger(n) && n >= 0) return { kind: 'preset', index: n };
  }
  return null;
}
