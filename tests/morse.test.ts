// Unit tests for src/tools/morse.ts — run with:
//   node --experimental-strip-types tests/morse.test.ts
import { toMorse, morseTiming, morseDurationMs } from '../src/tools/morse.ts';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    fails.push(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

// SOS -> "... --- ..."
eq(toMorse('SOS'), '... --- ...', 'toMorse SOS');
eq(toMorse('sos'), '... --- ...', 'toMorse lowercase');
eq(toMorse('HI THERE'), '.... .. / - .... . .-. .', 'toMorse two words');

// Timing for a single 'E' (one dot) at unit 200 -> just [on 200]
{
  const t = morseTiming('E', 200);
  eq(t, [{ on: true, ms: 200 }], 'timing E');
}
// 'S' = ... -> on,gap,on,gap,on (dot,intra,dot,intra,dot)
{
  const t = morseTiming('S', 200);
  eq(
    t,
    [
      { on: true, ms: 200 },
      { on: false, ms: 200 },
      { on: true, ms: 200 },
      { on: false, ms: 200 },
      { on: true, ms: 200 },
    ],
    'timing S',
  );
}
// always starts on, and 'T' (dash) is 3 units
{
  const t = morseTiming('T', 100);
  eq(t, [{ on: true, ms: 300 }], 'timing T dash = 3 units');
}
// SOS total: S(3 dots+2 intra) + interchar(3) + O(3 dashes+2 intra) + interchar(3) + S(...)
// = (200*3 + 200*2) + 600 + (600*3 + 200*2) + 600 + (200*3 + 200*2)
{
  const t = morseTiming('SOS', 200);
  eq(morseDurationMs(t), 1000 + 600 + 2200 + 600 + 1000, 'SOS total duration');
  eq(t[0].on, true, 'SOS starts on');
}

console.log(`\nmorse.test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n' + fails.join('\n'));
  process.exit(1);
}
