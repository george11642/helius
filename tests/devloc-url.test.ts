// Unit tests for src/app/devloc.ts::demoRequestFromSearch — run with:
//   node --experimental-strip-types tests/devloc-url.test.ts
// The pure URL parser lives in its own import-free module (devloc-url.ts)
// precisely so it can be tested here without a DOM.
import { demoRequestFromSearch } from '../src/app/devloc-url.ts';

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

eq(demoRequestFromSearch(''), null, 'no params → real GPS');
eq(demoRequestFromSearch('?prewarm=1'), null, 'unrelated params → real GPS');
eq(demoRequestFromSearch('?demo=1'), { kind: 'preset', index: 0 }, '?demo=1 → preset 0 (video/runbook path)');
eq(demoRequestFromSearch('?prewarm=1&demo=1'), { kind: 'preset', index: 0 }, 'scenes.mjs URL shape works');
eq(demoRequestFromSearch('?demo=0'), null, '?demo=0 is not demo mode');
eq(demoRequestFromSearch('?devloc=2'), { kind: 'preset', index: 2 }, '?devloc=<n> → preset n');
eq(demoRequestFromSearch('?devloc=-1'), null, 'negative preset rejected');
eq(demoRequestFromSearch('?devloc=abc'), null, 'non-numeric preset rejected');
eq(demoRequestFromSearch('?fix=35.08,-106.65'), { kind: 'fix', lat: 35.08, lon: -106.65, elevationM: null }, '?fix=lat,lon');
eq(demoRequestFromSearch('?fix=35.08,-106.65,1510'), { kind: 'fix', lat: 35.08, lon: -106.65, elevationM: 1510 }, '?fix with elevation');
eq(demoRequestFromSearch('?fix=garbage'), null, 'malformed ?fix → real GPS');
eq(demoRequestFromSearch('?fix=35.08,-106.65&demo=1'), { kind: 'fix', lat: 35.08, lon: -106.65, elevationM: null }, '?fix wins over ?demo');

console.log(`devloc-url.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
