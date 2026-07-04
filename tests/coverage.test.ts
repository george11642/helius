// Unit tests for src/tools/coverage.ts — run with:
//   node --experimental-strip-types tests/coverage.test.ts
import { PACK_COVERAGE, coverageForBbox, coverageForPack, distanceToNearestM, haversineM } from '../src/tools/coverage.ts';

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
function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}`);
  }
}

// --- haversine sanity: 1 degree of latitude ≈ 111.2 km
{
  const d = haversineM(35, -106, 36, -106);
  ok(Math.abs(d - 111_195) < 500, 'haversine: 1° lat ≈ 111.2 km');
  eq(haversineM(35.1983, -106.4439, 35.1983, -106.4439), 0, 'haversine: zero for identical points');
}

// --- coverageForBbox
const SANDIA = PACK_COVERAGE.sandia.bbox;
{
  // La Luz demo fix: inside the sandia bbox.
  const c = coverageForBbox(35.1983, -106.4439, SANDIA);
  eq(c.inBbox, true, 'La Luz inside sandia bbox');
  eq(c.distanceToBboxM, 0, 'inside → distance 0');
}
{
  // ABQ downtown is inside the (generous) sandia manifest bbox — bbox coverage
  // alone can't catch it; route_back's off-network layer must (see route.ts).
  const c = coverageForBbox(35.08, -106.65, SANDIA);
  eq(c.inBbox, true, 'ABQ downtown inside sandia manifest bbox (bbox is coarse)');
}
{
  // Santa Fe (35.687, -105.938): east of the bbox's east edge (-106.15).
  const c = coverageForBbox(35.687, -105.938, SANDIA);
  eq(c.inBbox, false, 'Santa Fe outside sandia bbox');
  ok(c.distanceToBboxM > 15_000 && c.distanceToBboxM < 40_000, `Santa Fe ~19-25 km outside (got ${Math.round(c.distanceToBboxM / 1000)} km)`);
}
{
  // Chamonix fix against the sandia pack: very far outside.
  const c = coverageForBbox(45.97, 6.885, SANDIA);
  eq(c.inBbox, false, 'Chamonix outside sandia bbox');
  ok(c.distanceToBboxM > 7_000_000, 'Chamonix thousands of km outside sandia');
}
{
  // Exact bbox corner counts as inside (closed interval).
  const c = coverageForBbox(34.65, -107.15, SANDIA);
  eq(c.inBbox, true, 'bbox corner is inside');
}

// --- coverageForPack
{
  const c = coverageForPack(45.97, 6.885, 'chamonix');
  ok(c !== null && c.inBbox, 'Lac Blanc fix inside chamonix pack');
  eq(coverageForPack(35.1983, -106.4439, 'nope'), null, 'unknown pack → null');
}

// --- distanceToNearestM
{
  const ths = [
    { lat: 35.1836, lon: -106.4805 }, // La Luz trailhead-ish
    { lat: 35.2100, lon: -106.4496 }, // crest
  ];
  const d = distanceToNearestM(35.08, -106.65, ths);
  ok(d !== null && d > 10_000 && d < 30_000, `ABQ downtown ~15-20 km from nearest sandia trailhead (got ${d && Math.round(d / 1000)} km)`);
  eq(distanceToNearestM(35, -106, []), null, 'empty POI list → null');
}

console.log(`coverage.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
