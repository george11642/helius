// Pure, dependency-free parsing of Gemma 4's native tool-call wire format.
//
// The model emits tool calls as literal text (NOT special tokens — verified:
// the E2B/E4B tokenizers have zero added-tokens, so every marker below is
// ordinary BPE text that shows up verbatim in a skip_special_tokens=false
// decode). Shape, from the model's chat_template.jinja:
//
//   <|tool_call>call:NAME{key:value,...}<tool_call|>
//
// and after emitting a call the model opens (and stops at) a <|tool_response>
// block. Argument values follow the template's `format_argument` style:
//   string   -> <|"|>text<|"|>
//   boolean  -> true / false
//   number   -> 3870  /  -680
//   mapping  -> {k:v,...}   (bare, unquoted keys)
//   sequence -> [v,v,...]
//
// Everything here is unit-tested in parse.test.ts (run: `node --experimental-strip-types`).

import type { AssistantToolCall } from './contract';

// ---------- marker stripping (for display) ----------

// All wire markers are `<|...>` / `<...|>` shaped, plus the bare sentinel
// tokens. Non-greedy so `<|"|>` and `<|image|>` each collapse cleanly.
const MARKER_RE = /<\|[^>]*?>|<[^<>]*?\|>|<\/?(?:eos|bos|pad|unk|end_of_turn|start_of_turn)>/g;
// A whole hidden reasoning block, if the model ever emits one.
const THINK_RE = /<\|channel>[\s\S]*?<channel\|>/g;

// A turn header carries a role label as literal text after it: `<|turn>model`.
const TURN_ROLE_RE = /<\|turn>(?:system|model|user|tool)\b/g;

/** Remove all wire markers + hidden-thought spans, leaving human-visible prose. */
export function stripMarkers(s: string): string {
  return s.replace(THINK_RE, '').replace(TURN_ROLE_RE, '').replace(MARKER_RE, '');
}

// ---------- argument parsing (recursive descent) ----------

const STR_OPEN = '<|"|>';

interface Cursor {
  s: string;
  i: number;
  ok: boolean;
}

function skipWs(c: Cursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i])) c.i++;
}

function parseValue(c: Cursor): unknown {
  skipWs(c);
  const { s } = c;

  // template-style string: <|"|>...<|"|>
  if (s.startsWith(STR_OPEN, c.i)) {
    const start = c.i + STR_OPEN.length;
    const end = s.indexOf(STR_OPEN, start);
    if (end === -1) {
      c.ok = false;
      c.i = s.length;
      return s.slice(start);
    }
    c.i = end + STR_OPEN.length;
    return s.slice(start, end);
  }

  // JSON-style string: "..."
  if (s[c.i] === '"') {
    let j = c.i + 1;
    let out = '';
    while (j < s.length && s[j] !== '"') {
      if (s[j] === '\\' && j + 1 < s.length) {
        out += s[j + 1];
        j += 2;
      } else {
        out += s[j];
        j++;
      }
    }
    if (s[j] !== '"') c.ok = false;
    c.i = j + 1;
    return out;
  }

  // nested mapping
  if (s[c.i] === '{') {
    c.i++;
    const obj = parsePairs(c, '}');
    return obj;
  }

  // sequence
  if (s[c.i] === '[') {
    c.i++;
    const arr: unknown[] = [];
    skipWs(c);
    if (s[c.i] === ']') {
      c.i++;
      return arr;
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      arr.push(parseValue(c));
      skipWs(c);
      if (s[c.i] === ',') {
        c.i++;
        continue;
      }
      if (s[c.i] === ']') {
        c.i++;
        break;
      }
      // unexpected — bail out of the array
      c.ok = false;
      break;
    }
    return arr;
  }

  // scalar bareword: read until a structural delimiter
  let j = c.i;
  while (j < s.length && !',}]'.includes(s[j])) j++;
  const tok = s.slice(c.i, j).trim();
  c.i = j;

  if (tok === 'true') return true;
  if (tok === 'false') return false;
  if (tok === 'null') return null;
  if (tok !== '' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
  return tok; // fall back to a bare string
}

/** Parse `key:value,key:value` pairs until `end` (or string end when end===''). */
function parsePairs(c: Cursor, end: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const { s } = c;
  skipWs(c);
  if (end && s[c.i] === end) {
    c.i++;
    return obj;
  }
  if (c.i >= s.length) return obj;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    skipWs(c);
    // key: bareword, or template-quoted <|"|>key<|"|>, or "key"
    let key: string;
    if (s.startsWith(STR_OPEN, c.i) || s[c.i] === '"') {
      key = String(parseValue(c));
    } else {
      let j = c.i;
      while (j < s.length && s[j] !== ':' && s[j] !== ',' && s[j] !== end) j++;
      key = s.slice(c.i, j).trim();
      c.i = j;
    }
    skipWs(c);
    if (s[c.i] !== ':') {
      c.ok = false;
      break;
    }
    c.i++; // consume ':'
    const value = parseValue(c);
    if (key) obj[key] = value;
    skipWs(c);
    if (s[c.i] === ',') {
      c.i++;
      continue;
    }
    if (end && s[c.i] === end) {
      c.i++;
      break;
    }
    if (c.i >= s.length) break;
    // stray content — stop cleanly rather than loop forever
    c.ok = false;
    break;
  }
  return obj;
}

/**
 * Parse a tool-call argument body (the text between the call's `{` and `}`).
 * Returns the arguments object and an `ok` flag (false on malformed input —
 * the agent loop turns a false into a retry with an error tool message).
 */
export function parseArgs(body: string): { args: Record<string, unknown>; ok: boolean } {
  const trimmed = body.trim();
  if (trimmed === '') return { args: {}, ok: true };
  const c: Cursor = { s: trimmed, i: 0, ok: true };
  const args = parsePairs(c, '');
  return { args, ok: c.ok };
}

// ---------- tool-call extraction ----------

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  argsOk: boolean;
  raw: string; // the full `<|tool_call>...<tool_call|>` slice, for debugging
}

export interface ParsedTurn {
  calls: ParsedToolCall[];
  /** human-visible answer text with all markers + tool-call blocks removed */
  answer: string;
}

const CALL_OPEN = '<|tool_call>';
const CALL_CLOSE = '<tool_call|>';

/**
 * Read the balanced-brace body starting at `open` (index of the `{`).
 * String-aware: braces inside a template `<|"|>…<|"|>` value or a JSON `"…"`
 * string are literal, not structural — otherwise `{message:<|"|>A } B<|"|>}`
 * would close early and truncate.
 */
function balancedBrace(s: string, open: number): { body: string; end: number } | null {
  if (s[open] !== '{') return null;
  let depth = 0;
  let i = open;
  while (i < s.length) {
    // Skip a whole template-quoted string (checked first — it starts with '<',
    // and its own inner '"' must not trip the JSON-string branch below).
    if (s.startsWith(STR_OPEN, i)) {
      const close = s.indexOf(STR_OPEN, i + STR_OPEN.length);
      if (close === -1) return null; // unterminated string → no balanced brace
      i = close + STR_OPEN.length;
      continue;
    }
    // Skip a JSON-quoted string, honoring backslash escapes.
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      i++; // step past the closing quote (or off the end)
      continue;
    }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return { body: s.slice(open + 1, i), end: i };
    }
    i++;
  }
  return null;
}

/**
 * Extract every tool call from a raw (skip_special_tokens=false) generation,
 * plus the plain-text answer (everything outside the call blocks, cleaned).
 * Robust to a missing `<tool_call|>` close (the model sometimes stops right
 * after opening the following `<|tool_response>`).
 */
export function parseToolCalls(rawText: string): ParsedTurn {
  const calls: ParsedToolCall[] = [];
  let searchFrom = 0;
  const answerParts: string[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const openIdx = rawText.indexOf(CALL_OPEN, searchFrom);
    if (openIdx === -1) {
      answerParts.push(rawText.slice(searchFrom));
      break;
    }
    answerParts.push(rawText.slice(searchFrom, openIdx));

    // Find `call:NAME` then the balanced `{...}`.
    const afterOpen = openIdx + CALL_OPEN.length;
    const callMatch = /^\s*call:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*/.exec(rawText.slice(afterOpen));
    if (!callMatch) {
      // malformed opener — skip past it and continue scanning
      searchFrom = afterOpen;
      continue;
    }
    const name = callMatch[1];
    const braceIdx = afterOpen + callMatch[0].length;
    const braced = balancedBrace(rawText, braceIdx);

    let args: Record<string, unknown> = {};
    let argsOk: boolean;
    let consumeEnd: number;
    if (braced) {
      const parsed = parseArgs(braced.body);
      args = parsed.args;
      argsOk = parsed.ok;
      // consume through the close marker if present, else through the `}`
      const closeIdx = rawText.indexOf(CALL_CLOSE, braced.end);
      consumeEnd = closeIdx === -1 ? braced.end + 1 : closeIdx + CALL_CLOSE.length;
    } else {
      // No balanced {...}. An opening '{' with no matching '}' means the call was
      // truncated mid-arguments (the stream cut off) — flag argsOk:false so the
      // loop's repair path fires instead of running the tool on empty args. No
      // '{' at all is a genuine no-arg call.
      argsOk = rawText[braceIdx] !== '{';
      const closeIdx = rawText.indexOf(CALL_CLOSE, braceIdx);
      consumeEnd = closeIdx === -1 ? rawText.length : closeIdx + CALL_CLOSE.length;
    }

    calls.push({ name, args, argsOk, raw: rawText.slice(openIdx, consumeEnd) });
    searchFrom = consumeEnd;
  }

  const answer = stripMarkers(answerParts.join(' ')).replace(/\s+/g, ' ').trim();
  return { calls, answer };
}

// ---------- streaming display filter ----------

export interface DisplayFilter {
  /** Feed a raw streamed chunk; returns any newly-emittable visible text. */
  push(chunk: string): string;
  /** Flush at end of generation; returns the final visible remainder. */
  end(): string;
  /** True once the turn is known to be a tool call (suppress visible text). */
  isToolCall(): boolean;
}

// Hold back a dangling potential-marker tail like `<`, `<|`, `<|tool_ca`, `<turn`.
const DANGLING_RE = /<\|?[a-zA-Z_"]*$/;

/**
 * Live filter that turns the worker's raw token stream into clean visible
 * prose while suppressing tool-call turns entirely. Detection is safe against
 * markers split across chunk boundaries: we re-strip the whole buffer each
 * push and only emit the delta up to a safe boundary.
 */
export function createDisplayFilter(): DisplayFilter {
  let buf = '';
  let emitted = 0;
  let tool = false;

  function visibleDelta(atEnd: boolean): string {
    if (tool) return '';
    if (buf.includes(CALL_OPEN)) {
      tool = true;
      return '';
    }
    // Don't emit a dangling partial marker unless this is the final flush.
    const safe = atEnd ? buf : buf.replace(DANGLING_RE, '');
    const clean = stripMarkers(safe);
    if (clean.length <= emitted) return '';
    const delta = clean.slice(emitted);
    emitted = clean.length;
    return delta;
  }

  return {
    push(chunk: string): string {
      buf += chunk;
      return visibleDelta(false);
    },
    end(): string {
      return visibleDelta(true);
    },
    isToolCall(): boolean {
      return tool;
    },
  };
}

// ---------- assistant-message shaping ----------

/** Build the LOCKED assistant tool_calls message shape (arguments as OBJECT). */
export function toAssistantToolCalls(calls: ParsedToolCall[]): AssistantToolCall[] {
  return calls.map((c) => ({
    type: 'function' as const,
    function: { name: c.name, arguments: c.args },
  }));
}
