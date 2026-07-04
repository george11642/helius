// Unit tests for src/lib/parse.ts — run with:
//   node --experimental-strip-types tests/parse.test.ts
// Lives outside `src` so tsconfig doesn't typecheck its .ts-extension imports.
import {
  parseArgs,
  parseToolCalls,
  stripMarkers,
  createDisplayFilter,
  toAssistantToolCalls,
} from '../src/lib/parse.ts';

let passed = 0;
let failed = 0;
const fails: string[] = [];

function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    fails.push(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else {
    failed++;
    fails.push(`FAIL ${name}`);
  }
}

// ---- spike-verified exact strings ----
{
  const r = parseToolCalls('<|tool_call>call:locate{}<tool_call|>');
  eq(r.calls.length, 1, 'spike locate: one call');
  eq(r.calls[0].name, 'locate', 'spike locate: name');
  eq(r.calls[0].args, {}, 'spike locate: empty args');
  eq(r.calls[0].argsOk, true, 'spike locate: argsOk');
  eq(r.answer, '', 'spike locate: no answer text');
}
{
  const r = parseToolCalls('<|tool_call>call:sun_clock{}<tool_call|>');
  eq(r.calls[0].name, 'sun_clock', 'spike sun_clock: name');
}

// ---- model stops after opening <|tool_response> (no close marker) ----
{
  const r = parseToolCalls('<|tool_call>call:locate{}<tool_call|><|tool_response>');
  eq(r.calls.length, 1, 'tool_response marker: one call');
  eq(r.calls[0].name, 'locate', 'tool_response marker: name');
  eq(r.answer, '', 'tool_response marker: answer stripped');
}
// missing <tool_call|> close entirely, model jumped straight to response block
{
  const r = parseToolCalls('<|tool_call>call:sun_clock{}<|tool_response>');
  eq(r.calls.length, 1, 'no close marker: still parses');
  eq(r.calls[0].name, 'sun_clock', 'no close marker: name');
}

// ---- args with real values (template <|"|> format) ----
{
  const r = parseToolCalls('<|tool_call>call:route_back{destination:<|"|>trailhead<|"|>}<tool_call|>');
  eq(r.calls[0].args, { destination: 'trailhead' }, 'route_back: string arg');
  eq(r.calls[0].argsOk, true, 'route_back: argsOk');
}
{
  const r = parseToolCalls('<|tool_call>call:pace_eta{distance_m:3870,ascent_m:-680}<tool_call|>');
  eq(r.calls[0].args, { distance_m: 3870, ascent_m: -680 }, 'pace_eta: numeric args incl negative');
}
{
  const r = parseToolCalls(
    '<|tool_call>call:morse_beacon{message:<|"|>SOS<|"|>,mode:<|"|>arm<|"|>}<tool_call|>',
  );
  eq(r.calls[0].args, { message: 'SOS', mode: 'arm' }, 'morse_beacon: two string args');
}
// ---- string-aware brace/quote scanning: braces/quotes INSIDE a string value
//      must not close the call early (Codex finding) ----
{
  const r = parseToolCalls('<|tool_call>call:morse_beacon{message:<|"|>SOS } DONE<|"|>}<tool_call|>');
  eq(r.calls.length, 1, 'brace-in-template-string: one call');
  eq(r.calls[0].args, { message: 'SOS } DONE' }, 'brace-in-template-string: brace kept inside value');
  eq(r.calls[0].argsOk, true, 'brace-in-template-string: argsOk');
}
{
  const r = parseToolCalls('<|tool_call>call:note{text:<|"|>say "hi" now<|"|>}<tool_call|>');
  eq(r.calls[0].args, { text: 'say "hi" now' }, 'quote-in-template-string: JSON quotes kept literal');
}
{
  const r = parseToolCalls('<|tool_call>call:note{text:"a } b"}<tool_call|>');
  eq(r.calls[0].args, { text: 'a } b' }, 'brace-in-JSON-string: brace kept inside value');
}
{
  const r = parseToolCalls('<|tool_call>call:x{a:{b:<|"|>y } z<|"|>},c:2}<tool_call|>');
  eq(r.calls[0].args, { a: { b: 'y } z' }, c: 2 }, 'nested object + brace-in-string');
}
// boolean + nested + sequence values
{
  const { args, ok: aok } = parseArgs('flag:true,list:[1,2,3],nested:{a:<|"|>x<|"|>,b:2}');
  eq(args, { flag: true, list: [1, 2, 3], nested: { a: 'x', b: 2 } }, 'parseArgs: mixed nested');
  eq(aok, true, 'parseArgs: mixed nested ok');
}
// plain JSON-style quotes also accepted (model may not always use <|"|>)
{
  const { args } = parseArgs('destination:"crest"');
  eq(args, { destination: 'crest' }, 'parseArgs: JSON-quoted string');
}
// bareword value fallback
{
  const { args } = parseArgs('mode:start');
  eq(args, { mode: 'start' }, 'parseArgs: bareword value');
}

// ---- malformed input never throws ----
{
  const { args, ok: aok } = parseArgs('destination:<|"|>trailhead'); // unterminated string
  ok(aok === false, 'parseArgs: unterminated string -> ok=false');
  ok(typeof args === 'object', 'parseArgs: unterminated string -> object still returned');
}
{
  const { ok: aok } = parseArgs('garbage-without-colon');
  ok(aok === false, 'parseArgs: no colon -> ok=false');
}
{
  const r = parseToolCalls('total nonsense <|tool_call>call:{}<tool_call|> more'); // bad name
  ok(Array.isArray(r.calls), 'parseToolCalls: malformed name -> no throw');
}

// ---- plain-text answer (no tool call) ----
{
  const r = parseToolCalls('Head downhill now. You have about 40 minutes of light.<turn|>');
  eq(r.calls.length, 0, 'answer only: no calls');
  eq(r.answer, 'Head downhill now. You have about 40 minutes of light.', 'answer only: text cleaned');
}

// ---- answer + trailing/leading tool call ----
{
  const r = parseToolCalls('Let me check.<|tool_call>call:locate{}<tool_call|>');
  eq(r.calls.length, 1, 'prose+call: one call');
  eq(r.answer, 'Let me check.', 'prose+call: prose preserved');
}

// ---- stripMarkers ----
{
  eq(stripMarkers('<|turn>model\nHello<turn|>'), '\nHello', 'stripMarkers: turn markers');
  eq(stripMarkers('a<|"|>b<|"|>c'), 'abc', 'stripMarkers: quote sentinels');
  eq(stripMarkers('keep < 10 C ok'), 'keep < 10 C ok', 'stripMarkers: leaves prose < intact');
}

// ---- toAssistantToolCalls shape ----
{
  const calls = parseToolCalls('<|tool_call>call:locate{}<tool_call|>').calls;
  const shaped = toAssistantToolCalls(calls);
  eq(
    shaped,
    [{ type: 'function', function: { name: 'locate', arguments: {} } }],
    'toAssistantToolCalls: LOCKED shape, arguments as object',
  );
}

// ---- display filter: tool-call turn is suppressed ----
{
  const f = createDisplayFilter();
  let out = '';
  // simulate marker split across chunks
  out += f.push('<|tool');
  out += f.push('_call>call:locate{}');
  out += f.push('<tool_call|>');
  out += f.end();
  eq(out, '', 'displayFilter: tool call emits nothing');
  ok(f.isToolCall() === true, 'displayFilter: isToolCall true');
}

// ---- display filter: prose streams cleanly ----
{
  const f = createDisplayFilter();
  let out = '';
  out += f.push('Head ');
  out += f.push('downhill ');
  out += f.push('now.');
  out += f.push('<turn|>');
  out += f.end();
  eq(out, 'Head downhill now.', 'displayFilter: prose streams, end marker stripped');
  ok(f.isToolCall() === false, 'displayFilter: prose not a tool call');
}

// ---- display filter: holds back a dangling partial marker mid-stream ----
{
  const f = createDisplayFilter();
  const a = f.push('Go now <'); // dangling '<' held back
  ok(!a.includes('<'), 'displayFilter: dangling < not emitted mid-stream');
  const b = f.push('turn|>'); // completes to a marker -> stripped
  eq(a + b, 'Go now ', 'displayFilter: completed marker stripped, prose kept');
}

console.log(`\nparse.test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n' + fails.join('\n'));
  process.exit(1);
}
