// Unit tests for src/tools/location.ts (demo/real fix precedence) — run with:
//   node --experimental-strip-types tests/location.test.ts
// Node has no navigator, so the geolocation success path is exercised via the
// exported setRealFix() (the exact function the browser callbacks call).
import {
  getFix,
  getFixState,
  isDemoMode,
  resetLocationState,
  setDemoMode,
  setRealFix,
  setSimulatedFix,
  startRealGeolocation,
} from '../src/tools/location.ts';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const ABQ = { lat: 35.08, lon: -106.65, accuracyM: 20, elevationM: 1510 };
const LA_LUZ = { lat: 35.1983, lon: -106.4439, accuracyM: 14, elevationM: 2926 };

// --- pristine state: NO fix. The app never invents a position.
resetLocationState();
eq(getFix(), null, 'no fix at boot');
eq(getFixState(), { fix: null, source: null, demoMode: false, geoStatus: 'idle' }, 'pristine state shape');

// --- real fix arrives → it is the fix, source gps, not demo
setRealFix(ABQ);
eq(getFix(), ABQ, 'real fix wins when not in demo mode');
eq(isDemoMode(), false, 'real fix does not enter demo mode');
eq(getFixState().source, 'gps', 'source is gps');
eq(getFixState().geoStatus, 'granted', 'geoStatus granted after a real fix');

// --- explicit demo overlay beats the real fix
setSimulatedFix(LA_LUZ);
eq(isDemoMode(), true, 'setSimulatedFix enters demo mode');
eq(getFix(), LA_LUZ, 'demo fix shadows the real fix');
eq(getFixState().source, 'demo', 'source is demo');

// --- a real update while in demo mode does NOT clobber the demo fix...
setRealFix({ ...ABQ, lat: 35.09 });
eq(getFix(), LA_LUZ, 'real update ignored while demo mode is on');

// --- ...but leaving demo mode reveals the latest real fix
setDemoMode(false);
eq(getFix()?.lat, 35.09, 'leaving demo mode falls back to the latest real fix');
eq(getFixState().source, 'gps', 'source back to gps');

// --- partial simulated fix merges over the previous demo fix
setSimulatedFix({ lat: 45.97, lon: 6.885 });
eq(getFix()?.elevationM, LA_LUZ.elevationM, 'partial demo fix merges over previous demo fix');

// --- leaving demo with no real fix is honestly null
resetLocationState();
setSimulatedFix(LA_LUZ);
setDemoMode(false);
eq(getFix(), null, 'no real fix + demo off → null (never a stale demo point)');

// --- change handler precedence: fires for real fixes only outside demo mode
{
  resetLocationState();
  const seen: string[] = [];
  // No navigator in Node → startRealGeolocation marks unavailable but still registers the handler.
  startRealGeolocation((f, source) => seen.push(`${source}:${f.lat}`));
  eq(getFixState().geoStatus, 'unavailable', 'no navigator → geoStatus unavailable');
  setRealFix(ABQ); // → gps event
  setSimulatedFix(LA_LUZ); // → demo event
  setRealFix({ ...ABQ, lat: 35.09 }); // demo mode on → suppressed
  eq(seen, ['gps:35.08', 'demo:35.1983'], 'handler sees gps then demo, real update suppressed during demo');
}

console.log(`location.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
