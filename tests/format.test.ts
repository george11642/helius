// Unit tests for src/tools/format.ts — run with:
//   node --experimental-strip-types tests/format.test.ts
import { fmtClock, fmtDistance, fmtDurationMin, fmtLatLon } from '../src/tools/format.ts';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// fmtDistance — the consistency bug this kills: "338 meters / 1.08 miles"
eq(fmtDistance(3870), '3.87 km / 2.40 mi', 'fmtDistance 3870 m');
eq(fmtDistance(10_600), '10.60 km / 6.59 mi', 'fmtDistance 10.6 km');
eq(fmtDistance(340), '340 m / 1,115 ft', 'fmtDistance sub-km uses m/ft');
eq(fmtDistance(999.4), '999 m / 3,279 ft', 'fmtDistance just under a km');
eq(fmtDistance(1000), '1.00 km / 0.62 mi', 'fmtDistance exactly 1 km');
eq(fmtDistance(0), '0 m / 0 ft', 'fmtDistance zero');
eq(fmtDistance(NaN), 'unknown distance', 'fmtDistance NaN');
eq(fmtDistance(-5), 'unknown distance', 'fmtDistance negative');

// fmtDurationMin
eq(fmtDurationMin(45), '45 min', 'fmtDurationMin under an hour');
eq(fmtDurationMin(102), '1h42m', 'fmtDurationMin 102 → 1h42m');
eq(fmtDurationMin(60), '1h00m', 'fmtDurationMin exactly an hour');
eq(fmtDurationMin(0), '0 min', 'fmtDurationMin zero');
eq(fmtDurationMin(59.6), '1h00m', 'fmtDurationMin rounds up across the hour');
eq(fmtDurationMin(-1), 'unknown time', 'fmtDurationMin negative');

// fmtClock — deterministic 24h local time
eq(fmtClock(new Date(2026, 6, 4, 20, 24)), '20:24', 'fmtClock evening');
eq(fmtClock(new Date(2026, 6, 4, 7, 5)), '07:05', 'fmtClock zero-padded');

// fmtLatLon
eq(fmtLatLon(35.1983, -106.4439, 14), '35.1983, -106.4439 (±14 m)', 'fmtLatLon with accuracy');
eq(fmtLatLon(35.1983, -106.4439, null), '35.1983, -106.4439', 'fmtLatLon without accuracy');

console.log(`format.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
