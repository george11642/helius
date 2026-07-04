// Position state, with REAL geolocation as the primary source and an explicit
// DEMO GPS mode layered on top. Two fixes are tracked independently:
//   - realFix: fed by navigator.geolocation (startRealGeolocation) — the truth.
//   - demoFix: fed by setSimulatedFix() (the devloc panel, switchPack in demo
//     mode) — only ever read while demoMode is on.
// getFix() returns the demo fix in demo mode, the real fix otherwise, and NULL
// when there is no honest fix at all — tools must surface that as a structured
// no_fix result, never invent a position. Node-testable (tests/location.test.ts):
// everything except startRealGeolocation is navigator-free.

export interface GpsFix {
  lat: number;
  lon: number;
  accuracyM: number;
  /** null when the GPS reading carries no altitude. */
  elevationM: number | null;
}

export type FixSource = 'gps' | 'demo';

export type GeoStatus =
  | 'idle' // startRealGeolocation not called yet
  | 'requesting' // permission prompt / first fix pending
  | 'granted' // at least one real fix received
  | 'denied' // user refused the permission prompt
  | 'unavailable' // no geolocation API, or position genuinely unobtainable
  | 'timeout'; // no fix within the deadline

export interface FixState {
  fix: GpsFix | null;
  source: FixSource | null;
  demoMode: boolean;
  geoStatus: GeoStatus;
}

let realFix: GpsFix | null = null;
let demoFix: GpsFix | null = null;
let demoMode = false;
let geoStatus: GeoStatus = 'idle';
let watchId: number | null = null;

export type FixChangeHandler = (fix: GpsFix, source: FixSource) => void;
let onChange: FixChangeHandler | null = null;

/** DEMO GPS: store a simulated fix and switch into demo mode (an explicit user
 *  action — the devloc panel or ?demo=1 — never something the app drifts into). */
export function setSimulatedFix(next: Partial<GpsFix>): void {
  const base: GpsFix = demoFix ?? { lat: 35.1983, lon: -106.4439, accuracyM: 14, elevationM: 2926 }; // La Luz, for partial merges
  demoFix = { ...base, ...next };
  demoMode = true;
  onChange?.(demoFix, 'demo');
}

/** Leave (or re-enter) demo mode. Leaving falls back to the real fix, which
 *  may be null — that null is the honest answer, not a bug. */
export function setDemoMode(on: boolean): void {
  demoMode = on;
  const f = getFix();
  if (f) onChange?.(f, demoMode ? 'demo' : 'gps');
}

export function isDemoMode(): boolean {
  return demoMode;
}

/** The active fix: demo fix in demo mode, else the last real GPS fix, else null. */
export function getFix(): GpsFix | null {
  return demoMode ? demoFix : realFix;
}

export function getFixState(): FixState {
  const fix = getFix();
  return {
    fix,
    source: fix ? (demoMode ? 'demo' : 'gps') : null,
    demoMode,
    geoStatus,
  };
}

/** Geolocation success path — also exported for tests (which have no navigator). */
export function setRealFix(next: GpsFix): void {
  realFix = next;
  geoStatus = 'granted';
  if (!demoMode) onChange?.(next, 'gps');
}

function toFix(pos: GeolocationPosition): GpsFix {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyM: Math.round(pos.coords.accuracy),
    elevationM: pos.coords.altitude !== null ? Math.round(pos.coords.altitude) : null,
  };
}

function toStatus(err: GeolocationPositionError): GeoStatus {
  return err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable';
}

/**
 * Start real GPS: one eager high-accuracy getCurrentPosition (fast first fix)
 * plus a continuous watchPosition. Safe to call once at mount; failures land
 * in geoStatus (surfaced by the locate tool as a structured no_fix result)
 * rather than throwing. `handler` fires on every accepted fix change, demo or
 * real, so the map can re-center.
 */
export function startRealGeolocation(handler?: FixChangeHandler): void {
  if (handler) onChange = handler;
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    geoStatus = 'unavailable';
    return;
  }
  if (watchId !== null) return; // already watching
  geoStatus = 'requesting';
  const fail = (err: GeolocationPositionError): void => {
    if (realFix) return; // keep the last good fix; a transient error doesn't unfix us
    geoStatus = toStatus(err);
  };
  navigator.geolocation.getCurrentPosition((pos) => setRealFix(toFix(pos)), fail, {
    enableHighAccuracy: true,
    timeout: 12_000,
    maximumAge: 30_000,
  });
  watchId = navigator.geolocation.watchPosition((pos) => setRealFix(toFix(pos)), fail, {
    enableHighAccuracy: true,
    timeout: 60_000,
    maximumAge: 5_000,
  });
}

export function stopRealGeolocation(): void {
  if (watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
}

/** Test-only: back to the pristine no-fix, no-demo state. */
export function resetLocationState(): void {
  realFix = null;
  demoFix = null;
  demoMode = false;
  geoStatus = 'idle';
  watchId = null;
  onChange = null;
}
