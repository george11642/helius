// The agent loop: one user turn -> (generate -> parse -> maybe run tools ->
// regenerate)* -> final spoken answer. Emits AgentEvents for the UI's chat and
// tool-trace. Message shapes follow the spike-LOCKED contract exactly:
// assistant tool_calls carry an arguments OBJECT; tool results are JSON STRINGS.

import type { AgentEventHandler, ChatMessage } from '../lib/contract';
import { canonicalToolCallKey, createDisplayFilter, parseToolCalls, toAssistantToolCalls } from '../lib/parse';
import type { Engine } from '../llm/engine';
import type { RawFrame } from '../llm/protocol';
import { READ_SIGN_PROMPT, type ToolRegistry } from '../tools/registry';
import { takePendingRoute } from '../tools/route';

const MAX_STEPS = 6;
const MAX_NEW_TOKENS = 512;

const round = (n: number): number => Math.round(n);
const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export interface AgentLoop {
  runText(text: string): Promise<void>;
  runVoice(audio: Float32Array): Promise<void>;
  readSign(frame: RawFrame): Promise<void>;
  abort(): void;
  reset(): void;
}

export interface AgentLoopDeps {
  engine: Engine;
  registry: ToolRegistry;
  emit: AgentEventHandler;
  systemPrompt: string;
}

export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
  const { engine, registry, emit, systemPrompt } = deps;
  const history: ChatMessage[] = [];
  let aborted = false;
  let busy = false;

  const stats = () => engine.getStats() ?? { decodeTps: 0, prefillMs: 0 };

  // One turn at a time. Overlapping sendText/sendVoice/readSign are dropped —
  // the UI also locks input, but this is the correctness backstop: concurrent
  // turns would interleave `history` writes and engine generations. A dropped
  // call resolves as a no-op (never rejects), so callers see no unhandled error.
  async function guardTurn(run: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
  }

  /** The reasoning+tools loop, without turn-start/done bookkeeping. */
  async function runInner(userText: string): Promise<void> {
    history.push({ role: 'user', content: userText });

    let iteration = 0; // generate/regenerate rounds (the loop budget)
    let step = 0; // monotonic per EXECUTED tool call across the turn — unique chip numbers
    let done = false;
    // Consecutive-duplicate guard: identity + result of the last tool actually run.
    let lastExecuted: { key: string; result: Record<string, unknown> } | null = null;

    while (iteration < MAX_STEPS && !aborted) {
      iteration++;
      const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history];

      const filter = createDisplayFilter();
      let streamed = '';
      const result = await engine.generate({
        messages,
        tools: registry.specs,
        maxNewTokens: MAX_NEW_TOKENS,
        onChunk: (chunk) => {
          const vis = filter.push(chunk);
          if (vis) {
            streamed += vis;
            emit({ type: 'assistant-token', text: vis });
          }
        },
      });
      const tail = filter.end();
      if (tail) {
        streamed += tail;
        emit({ type: 'assistant-token', text: tail });
      }

      if (aborted || result.aborted) {
        const partial = streamed.trim();
        emit({ type: 'assistant-done', text: partial, stats: stats() });
        done = true;
        break;
      }

      const { calls, answer } = parseToolCalls(result.rawText);

      if (calls.length === 0) {
        const finalText = (answer || result.text).trim();
        history.push({ role: 'assistant', content: finalText });
        emit({ type: 'assistant-done', text: finalText, stats: stats() });
        if (finalText) emit({ type: 'speak', text: finalText });
        done = true;
        break;
      }

      // Record the assistant's tool_calls turn (LOCKED shape: no content).
      history.push({ role: 'assistant', tool_calls: toAssistantToolCalls(calls) });

      for (const call of calls) {
        // Consecutive-duplicate guard: if the model re-emits the exact call it
        // just ran (name+args), don't re-run, re-draw, or add another chip —
        // hand back the prior result so it moves on instead of looping.
        const key = canonicalToolCallKey(call.name, call.args);
        if (lastExecuted && lastExecuted.key === key) {
          history.push({
            role: 'tool',
            name: call.name,
            content: JSON.stringify({ note: 'duplicate_call', previous_result: lastExecuted.result }),
          });
          continue;
        }

        step++;
        emit({ type: 'tool-start', call: { name: call.name, args: call.args }, step });
        const tool = registry.get(call.name);
        const t0 = performance.now();

        if (!tool) {
          emit({ type: 'tool-error', name: call.name, message: 'unknown tool', step });
          history.push({ role: 'tool', name: call.name, content: JSON.stringify({ error: 'unknown_tool' }) });
          continue;
        }

        // Never run a tool on arguments we couldn't parse — feed the error back
        // so the model re-emits a well-formed call instead of acting on garbage.
        if (!call.argsOk) {
          emit({ type: 'tool-error', name: call.name, message: 'malformed arguments', step });
          history.push({
            role: 'tool',
            name: call.name,
            content: JSON.stringify({ error: 'malformed_arguments', hint: 're-emit the tool call with valid arguments' }),
          });
          continue;
        }

        const res = await tool.run(call.args);
        const ms = round(performance.now() - t0);
        lastExecuted = { key, result: res.data }; // this is now the "immediately previous executed" call
        if (res.data && typeof res.data.error === 'string') {
          emit({ type: 'tool-error', name: call.name, message: res.data.error, step });
        } else {
          emit({ type: 'tool-done', name: call.name, summary: res.summary, ms, step });
          // route_back stashes its (bulky) geometry out-of-band so it never
          // enters the model's context; surface it to the map here.
          const pendingRoute = takePendingRoute();
          if (pendingRoute) {
            emit({
              type: 'route',
              geojson: pendingRoute.geojson,
              distanceM: pendingRoute.distanceM,
              etaMin: pendingRoute.etaMin,
              // Authoritative pre-formatted values — the UI renders these, so
              // the numbers on screen never depend on model prose.
              dest: pendingRoute.dest,
              display: pendingRoute.display,
            });
          }
        }
        // Tool content MUST be a JSON string (jinja mapping branch is broken).
        history.push({ role: 'tool', name: call.name, content: JSON.stringify(res.data) });
      }
    }

    if (!done) {
      // Loop budget exhausted (or aborted between steps) without a final answer.
      const fallback = aborted
        ? ''
        : "I ran out of steps working through that. Tell me the one thing you need most and I'll focus there.";
      if (!aborted) history.push({ role: 'assistant', content: fallback });
      emit({ type: 'assistant-done', text: fallback, stats: stats() });
      if (fallback) emit({ type: 'speak', text: fallback });
    }
  }

  async function runText(text: string): Promise<void> {
    aborted = false;
    emit({ type: 'agent-turn-start' });
    try {
      await runInner(text);
    } catch (err) {
      emit({ type: 'assistant-done', text: `Something failed while I was working on that (${clip(String(err), 120)}).`, stats: stats() });
    } finally {
      emit({ type: 'agent-turn-done' });
    }
  }

  async function runVoice(audio: Float32Array): Promise<void> {
    aborted = false;
    emit({ type: 'agent-turn-start' });
    try {
      const transcript = (await engine.transcribe(audio)).trim();
      emit({ type: 'user-message', text: transcript });
      if (!transcript) {
        const msg = "I didn't catch that — say it again?";
        emit({ type: 'assistant-done', text: msg, stats: stats() });
        emit({ type: 'speak', text: msg });
        return;
      }
      await runInner(transcript);
    } catch (err) {
      emit({ type: 'assistant-done', text: `I couldn't process that audio (${clip(String(err), 120)}).`, stats: stats() });
    } finally {
      emit({ type: 'agent-turn-done' });
    }
  }

  async function readSign(frame: RawFrame): Promise<void> {
    aborted = false;
    emit({ type: 'agent-turn-start' });
    emit({ type: 'user-message', text: 'Read this sign.' });
    emit({ type: 'tool-start', call: { name: 'read_sign', args: {} }, step: 1 });
    const t0 = performance.now();
    try {
      const { text } = await engine.visionInfer(frame, READ_SIGN_PROMPT);
      const clean = text.trim();
      const ms = round(performance.now() - t0);
      emit({ type: 'tool-done', name: 'read_sign', summary: clip(clean) || 'sign read', ms, step: 1 });
      history.push({ role: 'user', content: '[Camera] Read this sign.' });
      history.push({ role: 'assistant', content: clean });
      emit({ type: 'assistant-done', text: clean, stats: stats() });
      if (clean) emit({ type: 'speak', text: clean });
    } catch (err) {
      const ms = round(performance.now() - t0);
      emit({ type: 'tool-error', name: 'read_sign', message: clip(String(err), 120), step: 1 });
      const msg = "I couldn't read that sign. Get the text in frame, hold steady, and try again.";
      emit({ type: 'tool-done', name: 'read_sign', summary: 'failed', ms, step: 1 });
      emit({ type: 'assistant-done', text: msg, stats: stats() });
      emit({ type: 'speak', text: msg });
    } finally {
      emit({ type: 'agent-turn-done' });
    }
  }

  return {
    runText: (text) => guardTurn(() => runText(text)),
    runVoice: (audio) => guardTurn(() => runVoice(audio)),
    readSign: (frame) => guardTurn(() => readSign(frame)),
    abort(): void {
      aborted = true;
      engine.abort();
    },
    reset(): void {
      history.length = 0;
    },
  };
}
